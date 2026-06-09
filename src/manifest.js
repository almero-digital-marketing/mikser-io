// Engine-level render manifest. Persists the per-output render cache
// across cycles and process restarts. Powers:
//
//   - stale-output cleanup on DELETE (unlinks the file on disk when
//     its source entity is gone)
//   - skip-if-unchanged at the render dispatcher: when input + layout
//     are byte-identical to last cycle and none of the entity's `$`-ref
//     targets mutated, the render is short-circuited
//   - disk verification (`mikser --verify`, planned)
//
// Storage: `runtime/manifest.json`, a JSON array of compact snapshots
// keyed in-memory by `${id}:${destination}` so paginated outputs from
// the same source stay distinct.
//
// Snapshot shape (intentionally tiny — the full entity is in the catalog;
// the manifest only stores what's needed to make the skip decision plus
// what's needed to unlink stale outputs):
//
//   {
//     id, destination, parent,              // identity + cleanup keys
//     inputHash, layoutHash,                // skip-decision inputs
//     refTargets,                           // ref-driven invalidation
//     renderedAt,                           // diagnostic
//   }
//
// Lives in the engine per ADR-0006's five-test: substrate (every render
// depends on knowing what's already on disk and what changed),
// strategic (defines what "build cache" means for mikser), composable
// (other modules read via `runtime.manifest`), release-cadence-aligned
// (no external schema). Exposed at `runtime.manifest` per the
// `runtime.<name>` convention.

import crypto from 'node:crypto'
import path from 'node:path'
import { readFile, writeFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import runtime from './runtime.js'
import { useLogger } from './engine.js'
import { onLoaded, onAfterRender } from './lifecycle.js'
import { useJournal } from './journal.js'
import { OPERATION } from './constants.js'
import { extractRefs } from './utils.js'

const MANIFEST_FILE = 'manifest.json'

// Module-level Map shared by the public API and the lifecycle hooks
// below. One manifest per process. Values are snapshots, not entities.
const entries = new Map()

function key(query) {
    return `${query.id}:${query.destination}`
}

// Pure hash helpers. SHA-1 is fine here — collision resistance is not
// the threat model; we just need stable fingerprints. Output is hex
// (40 chars) which keeps the JSON file small.

function sha1(payload) {
    return crypto.createHash('sha1').update(payload).digest('hex')
}

function computeInputHash(entity) {
    // For file entities (no meta/content surface), the file content's
    // checksum is the authoritative fingerprint and is already computed
    // upstream by the files plugin via utils.js's `checksum`.
    if (entity.checksum && entity.meta == null && entity.content == null) {
        return sha1(entity.checksum)
    }
    return sha1(JSON.stringify({
        meta: entity.meta ?? null,
        content: entity.content ?? null,
    }))
}

function computeLayoutHash(entity) {
    if (!entity.layout?.content) return ''
    return sha1(entity.layout.content)
}

function computeRefTargets(entity) {
    if (!entity.meta) return []
    const seen = new Set()
    for (const { ref } of extractRefs(entity.meta)) {
        seen.add(ref)
    }
    return [...seen]
}

function buildSnapshot(entity) {
    const snapshot = {
        id: entity.id,
        destination: entity.destination,
        inputHash: computeInputHash(entity),
        layoutHash: computeLayoutHash(entity),
        refTargets: computeRefTargets(entity),
        renderedAt: Date.now(),
    }
    if (entity.parent) snapshot.parent = entity.parent
    return snapshot
}

export function createManifest() {
    return {
        // Look up a previously-recorded entry by entity (or by an
        // object with `{id, destination}`). Returns the snapshot, or
        // null. Snapshots from older runs that predate the hash fields
        // come back with `inputHash` undefined; the skip check below
        // treats those as cache misses and re-renders cleanly.
        lookup(query) {
            if (!query?.id || !query?.destination) return null
            return entries.get(key(query)) ?? null
        },

        // Should this render be skipped? True iff:
        //   - we have a prior snapshot for (id, destination)
        //   - inputHash and layoutHash match the entity's current hashes
        //   - none of the snapshot's refTargets is in `mutatedRefs`
        //
        // `mutatedRefs` is a Set of ids (and hrefs) mutated this cycle,
        // computed once at the top of onRender by the engine. The
        // ref-target check captures the case where the entity itself
        // hasn't changed but something it references did — without it,
        // dependent renders would silently serve stale output.
        shouldSkip(entity, mutatedRefs) {
            const snapshot = this.lookup(entity)
            if (!snapshot?.inputHash) return false
            if (computeInputHash(entity) !== snapshot.inputHash) return false
            if (computeLayoutHash(entity) !== snapshot.layoutHash) return false
            if (snapshot.refTargets?.length && mutatedRefs?.size) {
                for (const target of snapshot.refTargets) {
                    if (mutatedRefs.has(target)) return false
                }
            }
            return true
        },

        // Record a successful render. Computes the snapshot from the
        // entity (hashes + ref targets) and stores it keyed by
        // id+destination. Overwrites the existing entry when the same
        // source re-renders to the same destination; ids whose
        // destination changed leave the old key behind as a stale
        // entry that the next DELETE pass reclaims.
        record(entity) {
            entries.set(key(entity), buildSnapshot(entity))
        },

        // Drop all snapshots owned by entity id (direct outputs and
        // any paginated children whose `parent` is set to this id).
        // Returns the destinations that were removed so callers can
        // unlink the corresponding files when desired.
        remove(id) {
            const dropped = []
            for (const [k, value] of entries) {
                if (value.id === id || value.parent === id) {
                    dropped.push(value.destination)
                    entries.delete(k)
                }
            }
            return dropped
        },

        // Iterable of all currently-recorded snapshots.
        all() {
            return entries.values()
        },

        size() {
            return entries.size
        },

        // Internal accessor — module-level Map. Exposed for tests and
        // for the lifecycle hooks below.
        _entries: entries,
    }
}

// Wire to the lifecycle. Loads at onLoaded so plugins observing it
// from their own onLoaded see a fully-populated `runtime.manifest`.
// Cleanup + persist happen at onAfterRender, matching the cycle's
// natural rhythm (deletes prune entries, successful renders add or
// overwrite, the merged set is written to disk).

onLoaded(async () => {
    const logger = useLogger()
    runtime.manifest = createManifest()

    const manifestPath = path.join(runtime.options.runtimeFolder, MANIFEST_FILE)
    if (existsSync(manifestPath)) {
        try {
            const arr = JSON.parse(await readFile(manifestPath, 'utf8'))
            if (Array.isArray(arr)) {
                for (const snapshot of arr) {
                    if (snapshot?.id && snapshot?.destination) {
                        entries.set(key(snapshot), snapshot)
                    }
                }
            }
        } catch (err) {
            logger.warn('Could not load manifest.json: %s', err.message)
        }
    }
})

onAfterRender(async () => {
    const logger = useLogger()

    // Unlink stale output files for entities deleted in this cycle and
    // prune them from the manifest. Matches by `entity.id` for direct
    // hits and by `entity.parent` so paginated children (whose id was
    // rewritten via changeExtension) are reclaimed alongside their
    // source.
    for await (let { entity } of useJournal('Manifest cleanup', [OPERATION.DELETE])) {
        for (const [k, value] of entries) {
            if (value.id === entity.id || value.parent === entity.id) {
                const filePath = path.join(runtime.options.outputFolder, value.destination)
                try {
                    await unlink(filePath)
                    logger.debug('Manifest unlinked stale output: %s', value.destination)
                } catch { }
                entries.delete(k)
            }
        }
    }

    // Merge this cycle's successful renders. New snapshots appear;
    // re-rendered ids overwrite (same key); ids whose destination
    // changed leave the old key as a stale entry — reclaimed by the
    // cleanup pass above on the next DELETE.
    for await (let { output, entity } of useJournal('Output', [OPERATION.RENDER])) {
        if (output?.success) {
            entries.set(key(entity), buildSnapshot(entity))
        }
    }

    const manifestPath = path.join(runtime.options.runtimeFolder, MANIFEST_FILE)
    await writeFile(manifestPath, JSON.stringify(Array.from(entries.values())), 'utf8')
})
