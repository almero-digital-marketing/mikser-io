// Engine-level render manifest. Persists the per-output render cache
// across cycles and process restarts. Powers:
//
//   - stale-output cleanup on DELETE (unlinks the file on disk when
//     its source entity is gone)
//   - skip-if-unchanged at the render dispatcher: when the entity's
//     own bytes are identical to last cycle AND none of its tracked
//     dependencies (layout, partials, $-refs, queries) mutated, the
//     render is short-circuited
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
//     inputHash,                            // entity bytes fingerprint
//     refClosure,                           // [{kind, target}] — all
//                                           // dependencies this render
//                                           // touched. Kinds: 'ref'
//                                           // (entity.meta $-refs),
//                                           // 'layout' (the layout
//                                           // entity), 'partial' (any
//                                           // partial loaded). Future:
//                                           // 'query' for catalog
//                                           // queries (Phase 3B).
//     renderedAt,                           // diagnostic
//   }
//
// refClosure is populated from `entry.deps` on the journal RENDER entry,
// which the engine fills via the render-time track API + auto layout
// edge. Ref-kind edges are added separately from `extractRefs(entity.meta)`
// so a snapshot's closure is self-contained (no consult of runtime.refs
// required at skip-decision time — important for cold-start correctness).
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
    return crypto.createHash('sha1').update(String(payload)).digest('hex')
}

// Stable fingerprint of an entity's render-relevant bytes. Excludes
// volatile fields like stamp/time/uri so re-discovery on startup doesn't
// produce a different hash for an unchanged file. Exported so the engine
// can compute hashes for journal-mutation entities to feed the
// `currentHashes` Map that shouldSkip consults.
export function inputHashOf(entity) {
    if (!entity) return ''
    // For file-only entities (no meta/content surface) the upstream
    // file-content checksum already exists.
    if (entity.checksum && entity.meta == null && entity.content == null) {
        return sha1(entity.checksum)
    }
    return sha1(JSON.stringify({
        meta: entity.meta ?? null,
        content: entity.content ?? null,
    }))
}

// Synchronous catalog lookup used at record time to hash refClosure
// targets (layouts, partials) so future cycles can tell whether a
// "mutation" was a real content change or just re-discovery.
function lookupEntity(id) {
    return runtime.catalog?.chain.get('entities').find({ id }).value()
}

// refClosure is the unified dependency list for a render. It mixes the
// edges the engine collected at render time (layout, partials, future:
// queries) with the entity's own $-refs (extracted statically). One list
// covers every reason a render might need to invalidate.
//
// Each entry carries the target's content `hash` at the time of this
// render, so a future cycle can distinguish "this entity reappeared in
// the journal" (cold-start re-discovery, no real change) from "the
// content actually differs" (real invalidation reason). Hash is
// optional — for refs targeting external resources or entities not in
// the catalog at record time, we omit it and the skip check falls back
// to the conservative "any journal mutation invalidates" rule.
function buildRefClosure(entity, deps) {
    const closure = []
    const seen = new Set()
    function push(kind, target, hash) {
        if (!target) return
        const key = `${kind}:${target}`
        if (seen.has(key)) return
        seen.add(key)
        const entry = { kind, target }
        if (hash) entry.hash = hash
        closure.push(entry)
    }
    // $-key refs from entity meta (kind: 'ref'). Try to hash the target
    // via catalog lookup; refs that don't resolve fall back to the
    // conservative check.
    if (entity.meta) {
        for (const { ref } of extractRefs(entity.meta)) {
            const target = lookupEntity(ref)
            push('ref', ref, target ? inputHashOf(target) : undefined)
        }
    }
    // Render-time edges supplied by the engine via journal entry.deps.
    // Each carries the target's hash at render time (computed by the
    // engine at collection time and threaded through the journal entry).
    if (Array.isArray(deps)) {
        for (const { kind, target, hash } of deps) push(kind, target, hash)
    }
    return closure
}

function buildSnapshot(entity, deps) {
    const snapshot = {
        id: entity.id,
        destination: entity.destination,
        inputHash: inputHashOf(entity),
        refClosure: buildRefClosure(entity, deps),
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
        //   - inputHash matches the entity's current bytes
        //   - for every refClosure target that appears in `mutatedRefs`
        //     this cycle, the target's current hash matches what we
        //     recorded last render (i.e. the journal mutation was a
        //     re-discovery, not a real content change). Without this
        //     hash gate, cold-start file rediscovery would falsely
        //     invalidate every render whose layout/partial appears in
        //     the journal — which is every render.
        //
        // `mutatedRefs` is a Set of ids (and hrefs) mutated this cycle.
        // `currentHashes` is a Map<id, hash> of the *current* hash for
        // every entity that appears in this cycle's journal mutations.
        // Both are built once at the top of onRender by the engine.
        // Snapshots without per-target hashes (older records, external
        // refs that didn't resolve at record time) fall back to the
        // conservative "any mutation invalidates" rule.
        shouldSkip(entity, mutatedRefs, currentHashes) {
            const snapshot = this.lookup(entity)
            if (!snapshot?.inputHash) return false
            if (inputHashOf(entity) !== snapshot.inputHash) return false
            if (snapshot.refClosure?.length && mutatedRefs?.size) {
                for (const { target, hash } of snapshot.refClosure) {
                    if (!mutatedRefs.has(target)) continue
                    // Target appears in journal — was its content really
                    // different from what we rendered against?
                    if (!hash) return false                       // no recorded hash → can't verify, force re-render
                    const currentHash = currentHashes?.get(target)
                    if (currentHash === undefined) continue       // not in this cycle's mutations after all
                    if (currentHash !== hash) return false        // real content change
                }
            }
            return true
        },

        // Record a successful render. Computes the snapshot from the
        // entity (hash + refClosure built from `deps` plus any $-refs in
        // entity.meta) and stores it keyed by id+destination. Overwrites
        // the existing entry when the same source re-renders to the same
        // destination; ids whose destination changed leave the old key
        // behind as a stale entry that the next DELETE pass reclaims.
        record(entity, deps) {
            entries.set(key(entity), buildSnapshot(entity, deps))
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
    //
    // Skipped renders (output.skipped === 'manifest') keep their prior
    // snapshot intact — the entity didn't re-render, so its deps haven't
    // changed and rebuilding the snapshot with empty deps would erase
    // last cycle's partial/layout tracking.
    for await (let { output, entity, deps } of useJournal('Output', [OPERATION.RENDER])) {
        if (output?.success && !output.skipped) {
            entries.set(key(entity), buildSnapshot(entity, deps))
        }
    }

    const manifestPath = path.join(runtime.options.runtimeFolder, MANIFEST_FILE)
    await writeFile(manifestPath, JSON.stringify(Array.from(entries.values())), 'utf8')
})
