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
import sift from 'sift'
import runtime from './runtime.js'
import { useLogger } from './engine.js'
import { onLoaded, onFinalized } from './lifecycle.js'
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

// refClosure is the unified dependency list for a render. It mixes:
//   - $-key refs from the entity's meta (extracted statically here)
//   - Render-time edges from the engine's track API: layout / partial
//     (target + hash) and query (sift filter, no target)
//
// Layout/partial/ref entries carry the target's content `hash` at the
// time of this render, so a future cycle can distinguish "this entity
// reappeared in the journal" (cold-start re-discovery, no real change)
// from "the content actually differs" (real invalidation reason). Hash
// is optional — refs targeting external resources or entities not in
// the catalog at record time omit it and the skip check falls back to
// the conservative "any journal mutation invalidates" rule.
//
// Query entries carry a normalized filter object (or null sentinel
// for unserializable filters like function predicates). At skip-check
// the filter is replayed against this cycle's mutated entities via
// sift; any match invalidates the render.
function buildRefClosure(entity, deps) {
    const closure = []
    const seen = new Set()
    function pushTarget(kind, target, hash) {
        if (!target) return
        const key = `${kind}:${target}`
        if (seen.has(key)) return
        seen.add(key)
        const entry = { kind, target }
        if (hash) entry.hash = hash
        closure.push(entry)
    }
    function pushQuery(filter) {
        // Dedupe queries by their serialized form. Null filter is the
        // sentinel for "unserializable" — it goes through once.
        const key = filter === null ? 'query:__null__' : 'query:' + JSON.stringify(filter)
        if (seen.has(key)) return
        seen.add(key)
        closure.push({ kind: 'query', filter })
    }
    // $-key refs from entity meta (kind: 'ref'). Try to hash the target
    // via catalog lookup; refs that don't resolve fall back to the
    // conservative check.
    if (entity.meta) {
        for (const { ref } of extractRefs(entity.meta)) {
            const target = lookupEntity(ref)
            pushTarget('ref', ref, target ? inputHashOf(target) : undefined)
        }
    }
    // Render-time edges supplied by the engine via journal entry.deps.
    if (Array.isArray(deps)) {
        for (const dep of deps) {
            if (dep.kind === 'query') pushQuery(dep.filter ?? null)
            else pushTarget(dep.kind, dep.target, dep.hash)
        }
    }
    return closure
}

function buildSnapshot(entity, deps, outputHash) {
    const snapshot = {
        id: entity.id,
        destination: entity.destination,
        inputHash: inputHashOf(entity),
        refClosure: buildRefClosure(entity, deps),
        renderedAt: Date.now(),
    }
    if (entity.parent) snapshot.parent = entity.parent
    if (outputHash) snapshot.outputHash = outputHash
    return snapshot
}

// Hash the on-disk output file for a given snapshot destination. Read
// as a buffer (binary-safe) and SHA-1 it. Returns undefined if the
// file doesn't exist or can't be read — `mikser --verify` treats that
// as a missing-output error separately.
async function hashOutputFile(destination) {
    if (!destination) return undefined
    const filePath = path.join(runtime.options.outputFolder, destination)
    try {
        const buf = await readFile(filePath)
        return sha1(buf)
    } catch {
        return undefined
    }
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
        //   - for every refClosure target (layout/partial/$-ref) that
        //     appears in `mutatedRefs` this cycle, the target's current
        //     hash matches what we recorded last render (i.e. the
        //     journal mutation was a re-discovery, not a real content
        //     change). Without this hash gate, cold-start file
        //     rediscovery would falsely invalidate every render whose
        //     layout/partial appears in the journal — which is every
        //     render.
        //   - for every refClosure query (kind:'query'), no mutated
        //     entity matches the recorded sift filter. A null filter
        //     (sentinel for unserializable predicates) always
        //     invalidates conservatively.
        //
        // `mutatedRefs` is a Set of ids (and hrefs) mutated this cycle.
        // `currentHashes` is a Map<id, hash> of the *current* hash for
        // every entity that appears in this cycle's journal mutations.
        // `mutatedEntities` is a Map<id, entity> of the entity payloads
        // themselves — used by the query check to run sift matchers.
        // All three are built once at the top of onRender by the engine.
        // Snapshots without per-target hashes (older records, external
        // refs that didn't resolve at record time) fall back to the
        // conservative "any mutation invalidates" rule.
        shouldSkip(entity, mutatedRefs, currentHashes, mutatedEntities) {
            // Per-entity opt-out: `meta.cache: false` declares the
            // entity unconditionally non-skippable. Escape hatch for
            // renders with deps mikser can't see (external API calls,
            // time-sensitive helpers, ECT partials we don't track).
            if (entity?.meta?.cache === false) return false
            const snapshot = this.lookup(entity)
            if (!snapshot?.inputHash) return false
            if (inputHashOf(entity) !== snapshot.inputHash) return false
            if (!snapshot.refClosure?.length) return true
            for (const entry of snapshot.refClosure) {
                if (entry.kind === 'query') {
                    // Unserializable filter → can't verify → force re-render.
                    if (!entry.filter) return false
                    if (!mutatedEntities?.size) continue
                    const matcher = sift(entry.filter)
                    for (const mutated of mutatedEntities.values()) {
                        if (matcher(mutated)) return false
                    }
                    continue
                }
                // layout / partial / ref — target-based.
                if (!mutatedRefs?.has(entry.target)) continue
                if (!entry.hash) return false                     // no recorded hash → can't verify
                const currentHash = currentHashes?.get(entry.target)
                if (currentHash === undefined) continue           // not really in this cycle's mutations after all
                if (currentHash !== entry.hash) return false      // real content change
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

        // Walk the output folder against recorded snapshots, returning
        // a diff describing:
        //   - missing[]    — snapshots whose output file is gone
        //   - mismatched[] — files whose current hash differs from the
        //                    recorded outputHash (corruption/tampering/
        //                    out-of-band edit)
        //   - orphaned[]   — output files not claimed by any snapshot
        //                    (stale outputs from prior runs that were
        //                    never reclaimed)
        //   - unverifiable[] — snapshots without an outputHash field
        //                    (older records or content that couldn't
        //                    be hashed at render time)
        //
        // Backs `mikser --verify`. Pure: no mutations, no filesystem
        // changes. Caller decides whether to report-and-exit, prune,
        // or re-render.
        async verify({ outputFolder } = {}) {
            outputFolder = outputFolder || runtime.options.outputFolder
            const missing = []
            const mismatched = []
            const unverifiable = []
            const claimed = new Set()
            for (const snap of entries.values()) {
                if (!snap.destination) continue
                claimed.add(snap.destination.replace(/^\/+/, ''))
                const filePath = path.join(outputFolder, snap.destination)
                if (!existsSync(filePath)) {
                    missing.push({ id: snap.id, destination: snap.destination })
                    continue
                }
                if (!snap.outputHash) {
                    unverifiable.push({ id: snap.id, destination: snap.destination })
                    continue
                }
                try {
                    const buf = await readFile(filePath)
                    if (sha1(buf) !== snap.outputHash) {
                        mismatched.push({ id: snap.id, destination: snap.destination })
                    }
                } catch {
                    missing.push({ id: snap.id, destination: snap.destination })
                }
            }
            // Walk output folder for orphans. Defer the import so the
            // verify path stays optional at module load time.
            const { globby } = await import('globby')
            const onDisk = await globby('**/*', {
                cwd: outputFolder,
                onlyFiles: true,
                followSymbolicLinks: false,
            })
            const orphaned = []
            for (const rel of onDisk) {
                if (claimed.has(rel)) continue
                orphaned.push({ path: rel })
            }
            return { missing, mismatched, unverifiable, orphaned }
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

    // Replay each snapshot's refClosure into runtime.refs so the
    // first post-restart cycle's inverseClosureOf returns correctly.
    // Without this, dynamic layout/partial edges live only in memory
    // and reset to empty every restart — incremental dispatch would
    // miss every consumer until that consumer re-renders, producing
    // silent stale output. (refExtract for $-key refs is rebuilt from
    // catalog by refs.js's onPersist; we replay only layout/partial.
    // Query edges don't carry a target, so they have nothing to
    // populate in the inverse index — sift matching is independent.)
    if (runtime.refs?.replaceDynamic) {
        for (const snapshot of entries.values()) {
            const edges = []
            for (const entry of snapshot.refClosure ?? []) {
                if (entry.kind === 'layout' || entry.kind === 'partial') {
                    if (entry.target) edges.push({ kind: entry.kind, target: entry.target })
                }
            }
            if (edges.length) runtime.refs.replaceDynamic(snapshot.id, edges)
        }
    }
})

onFinalized(async () => {
    const logger = useLogger()

    // Persist manifest at the very end of the cycle so:
    //   1. Postprocess-modified outputs are captured by outputHash
    //      (post-mjml overwrites the render HTML, post-pdf produces a
    //      sibling file). Hashing here means `mikser --verify` checks
    //      against the *final* on-disk state, not the intermediate
    //      render output.
    //   2. Deleted entities get their orphan files unlinked after
    //      everything that might still need them has run.
    //
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
    //
    // outputHash is taken from the file on disk AT END OF CYCLE — by
    // which point postprocess has run, intermediates are gone, and the
    // entity's `destination` either points at the final file (e.g.
    // post-mjml leaves HTML at the render destination) or at a file
    // that's been consumed (post-pdf renames to .pdf). In the latter
    // case hashOutputFile returns undefined and the snapshot is
    // recorded without an outputHash — `mikser --verify` will mark
    // those as unverifiable (warning, not error) since they're
    // expected for postprocess-bound entities.
    for await (let { output, entity, deps } of useJournal('Output', [OPERATION.RENDER])) {
        if (output?.success && !output.skipped) {
            const outputHash = await hashOutputFile(entity.destination)
            entries.set(key(entity), buildSnapshot(entity, deps, outputHash))
        }
    }

    // Pagination cleanup. When a paginated parent re-renders with a
    // different page count (shrunk, grew, or reverted to single-page),
    // old child entries persist in manifest and stale files persist on
    // disk. Track which destinations each parent emitted this cycle,
    // then drop prior children that weren't re-emitted.
    //
    // Pagination conventions (from layouts.js):
    //   - First page:       entity.id === parentId, entity.parent unset,
    //                       entity.pages > 1
    //   - Subsequent pages: entity.id != parentId, entity.parent set,
    //                       entity.pages > 1
    //   - Non-paginated:    entity.pages unset or === 1
    //
    // So for "parents that ran pagination this cycle" we collect both
    // first and subsequent page destinations. For "parents that lost
    // pagination" (was paginated, now single-page) we observe a non-
    // paginated render of an entity that has prior `parent === id`
    // children in manifest.
    const newDestinationsByParent = new Map()
    const lostPagination = new Set()
    for await (let { output, entity } of useJournal('Pagination tracking', [OPERATION.RENDER])) {
        if (!output?.success || output.skipped) continue
        if (entity.pages > 1) {
            const parentId = entity.parent ?? entity.id
            if (!newDestinationsByParent.has(parentId)) {
                newDestinationsByParent.set(parentId, new Set())
            }
            newDestinationsByParent.get(parentId).add(entity.destination)
        } else if (!entity.parent) {
            // Non-paginated, non-child render. If it has prior children
            // in manifest, those need to go (parent un-paginated).
            lostPagination.add(entity.id)
        }
    }

    for (const [parentId, destinations] of newDestinationsByParent) {
        for (const [k, snap] of entries) {
            if (snap.parent === parentId && !destinations.has(snap.destination)) {
                const filePath = path.join(runtime.options.outputFolder, snap.destination)
                try {
                    await unlink(filePath)
                    logger.debug('Pagination shrunk: unlinked %s', snap.destination)
                } catch { }
                entries.delete(k)
            }
        }
    }
    for (const parentId of lostPagination) {
        for (const [k, snap] of entries) {
            if (snap.parent === parentId) {
                const filePath = path.join(runtime.options.outputFolder, snap.destination)
                try {
                    await unlink(filePath)
                    logger.debug('Pagination dropped: unlinked %s', snap.destination)
                } catch { }
                entries.delete(k)
            }
        }
    }

    const manifestPath = path.join(runtime.options.runtimeFolder, MANIFEST_FILE)
    await writeFile(manifestPath, JSON.stringify(Array.from(entries.values())), 'utf8')
})
