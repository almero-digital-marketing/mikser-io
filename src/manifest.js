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
// Storage: `runtime/manifest.ndjson` — newline-delimited JSON, one
// snapshot per line, keyed in-memory by `${id}:${destination}` so
// paginated outputs from the same source stay distinct. Streaming
// read at startup keeps memory bounded as the manifest grows; write
// is skipped entirely on cycles where nothing diverged from disk
// (the warm-restart common case).
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
import { readFile, writeFile, unlink, rename } from 'fs/promises'
import { existsSync, createReadStream } from 'fs'
import { createInterface } from 'node:readline'
import sift from 'sift'
import runtime from './runtime.js'
import { useLogger } from './engine.js'
import { onLoaded, onFinalize } from './lifecycle.js'
import { useJournal } from './journal.js'
import { OPERATION } from './constants.js'
import { extractRefs, inputHashOf } from './utils.js'
import { filterKey } from './track.js'
import { findById } from './catalog.js'

// Re-export so consumers that previously imported inputHashOf from
// manifest don't break. Canonical home is utils.js.
export { inputHashOf } from './utils.js'

const MANIFEST_FILE = 'manifest.ndjson'

// Module-level Map shared by the public API and the lifecycle hooks
// below. One manifest per process. Values are snapshots, not entities.
const entries = new Map()

// Inverse index for pagination cleanup. Maps a paginated parent's id
// to the set of `entries` keys belonging to its child pages. Same role
// the layouts plugin's uriIndex plays for the sitemap: turn O(N) scans
// in `dropEntriesWhere(snap => snap.parent === parentId)` into O(matches).
// Without it, `lostPagination` accumulated every non-paginated render
// on cold and the cleanup loop did N × N predicate checks for zero
// unlinks.
const childrenByParent = new Map()

// Track whether the in-memory state has diverged from the on-disk
// file. Lets onFinalize skip the write entirely when nothing changed
// this cycle — the common case on warm restarts with the source.js
// gate firing for every file. Any mutation to `entries` (record,
// remove, the cleanup passes in onFinalize) sets this true; loading
// from disk and a successful persist reset it.
let dirty = false

function key(query) {
    return `${query.id}:${query.destination}`
}

// All `entries` mutations go through these so `childrenByParent` stays
// in lockstep. Direct entries.set/delete elsewhere would leak the
// invariant.
function setEntry(k, snap) {
    const prev = entries.get(k)
    if (prev?.parent && prev.parent !== snap.parent) {
        unindexChild(prev.parent, k)
    }
    entries.set(k, snap)
    if (snap.parent) indexChild(snap.parent, k)
}

function deleteEntry(k) {
    const snap = entries.get(k)
    if (!snap) return false
    if (snap.parent) unindexChild(snap.parent, k)
    return entries.delete(k)
}

function indexChild(parentId, k) {
    let set = childrenByParent.get(parentId)
    if (!set) {
        set = new Set()
        childrenByParent.set(parentId, set)
    }
    set.add(k)
}

function unindexChild(parentId, k) {
    const set = childrenByParent.get(parentId)
    if (!set) return
    set.delete(k)
    if (set.size === 0) childrenByParent.delete(parentId)
}

// Pure hash helpers. SHA-1 is fine here — collision resistance is not
// the threat model; we just need stable fingerprints. Output is hex
// (40 chars) which keeps the JSON file small.

function sha1(payload) {
    return crypto.createHash('sha1').update(String(payload)).digest('hex')
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
        const key = 'query:' + filterKey(filter)
        if (seen.has(key)) return
        seen.add(key)
        closure.push({ kind: 'query', filter })
    }
    // $-key refs from entity meta (kind: 'ref'). Try to hash the target
    // via catalog lookup; refs that don't resolve fall back to the
    // conservative check.
    if (entity.meta) {
        for (const { ref } of extractRefs(entity.meta)) {
            const target = findById(ref)
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
                if (currentHash === null) return false            // target was deleted → invalidate
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
            setEntry(key(entity), buildSnapshot(entity, deps))
            dirty = true
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
                    deleteEntry(k)
                    dirty = true
                }
            }
            return dropped
        },

        // Iterable of all currently-recorded snapshots.
        all() {
            return entries.values()
        },

        // Id → inputHash Map mined across every snapshot:
        //   - the rendered entity's own `inputHash`
        //   - target hashes from refClosure entries (kind: 'ref' /
        //     'layout' / 'partial') for support entities (layouts,
        //     partials, $-ref targets) that don't produce output
        //     themselves but appear in consumers' closures
        //
        // The layouts dispatcher uses this as its hash-aware seeding
        // filter: a journal CREATE/UPDATE whose current inputHash
        // matches the recorded one is a cold-start re-discovery, not
        // a real change, and shouldn't seed the closure walk.
        recordedHashes() {
            const map = new Map()
            for (const snap of entries.values()) {
                if (snap.inputHash && !map.has(snap.id)) {
                    map.set(snap.id, snap.inputHash)
                }
                for (const dep of snap.refClosure ?? []) {
                    if (dep.kind === 'query') continue
                    if (dep.target && dep.hash && !map.has(dep.target)) {
                        map.set(dep.target, dep.hash)
                    }
                }
            }
            return map
        },

        // Build the dep-edge array the engine threads into a snapshot
        // via record(entity, edges). One place to know what the
        // refClosure shape is — engine just collects the components
        // and hands them off. Auto-includes the layout edge (every
        // render has one); merges track.partials with hashes looked
        // up from the catalog; appends template-time + sidecar queries.
        collectEdges({ entity, track, sidecarQueries }) {
            const edges = []
            if (entity?.layout?.id) {
                edges.push({
                    kind: 'layout',
                    target: entity.layout.id,
                    hash: inputHashOf(entity.layout),
                })
            }
            if (track?.partials) {
                for (const target of track.partials) {
                    const partial = findById(target)
                    edges.push({
                        kind: 'partial',
                        target,
                        hash: partial ? inputHashOf(partial) : undefined,
                    })
                }
            }
            if (track?.queries) {
                for (const filter of track.queries) {
                    edges.push({ kind: 'query', filter })
                }
            }
            if (sidecarQueries) {
                for (const filter of sidecarQueries) {
                    edges.push({ kind: 'query', filter })
                }
            }
            return edges
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
            // NDJSON: one snapshot per line. Streaming read so memory
            // stays flat at large scales — at 1M entries with ~500 bytes
            // each, a JSON.parse over the whole file would peak at
            // ~1GB resident; readline keeps it bounded.
            const stream = createReadStream(manifestPath)
            const rl = createInterface({ input: stream, crlfDelay: Infinity })
            for await (const line of rl) {
                if (!line.trim()) continue
                try {
                    const snapshot = JSON.parse(line)
                    if (snapshot?.id && snapshot?.destination) {
                        setEntry(key(snapshot), snapshot)
                    }
                } catch (err) {
                    logger.warn('Skipping malformed manifest line: %s', err.message)
                }
            }
        } catch (err) {
            logger.warn('Could not load %s: %s', MANIFEST_FILE, err.message)
        }
    }
    // Loaded from disk; in-memory matches the file.
    dirty = false

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

// Drop manifest entries matching `predicate`, unlinking their output
// file from disk first. The generic full-scan helper — used by the
// DELETE-journal cleanup pass below where the match key is id (and
// we have no id-index, just a destination-suffixed key). Pagination
// passes use `dropChildrenOf` instead, which is O(matches) via
// `childrenByParent`.
async function dropEntriesWhere(predicate, reason) {
    const logger = useLogger()
    for (const [k, snap] of entries) {
        if (!predicate(snap)) continue
        const filePath = path.join(runtime.options.outputFolder, snap.destination)
        try {
            await unlink(filePath)
            logger.debug('%s: unlinked %s', reason, snap.destination)
        } catch { }
        deleteEntry(k)
        dirty = true
    }
}

// Drop a paginated parent's children — optionally keeping any whose
// destination is in `keep`. O(matches) via `childrenByParent`. Returns
// immediately for parents the index doesn't know about (the cold-path
// case: every non-paginated render ends up in `lostPagination`, and
// we want each of those to hit a single Map lookup rather than walk
// the full manifest).
async function dropChildrenOf(parentId, reason, { keep } = {}) {
    const childKeys = childrenByParent.get(parentId)
    if (!childKeys || childKeys.size === 0) return
    const logger = useLogger()
    // Snapshot the keys — `deleteEntry` mutates the underlying set.
    for (const k of [...childKeys]) {
        const snap = entries.get(k)
        if (!snap) continue
        if (keep?.has(snap.destination)) continue
        const filePath = path.join(runtime.options.outputFolder, snap.destination)
        try {
            await unlink(filePath)
            logger.debug('%s: unlinked %s', reason, snap.destination)
        } catch { }
        deleteEntry(k)
        dirty = true
    }
}

// Use onFinalize (not onFinalized) so the journal still has this
// cycle's RENDER entries when we walk them. journal.js's own
// onFinalized hook drains entries — running afterwards. The two
// phases bracket end-of-cycle work cleanly: onFinalize is "the
// cycle's last chance to read its journal," onFinalized is "the
// cycle is over, transient state resets."
onFinalize(async () => {
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
        await dropEntriesWhere(
            snap => snap.id === entity.id || snap.parent === entity.id,
            'Entity deleted',
        )
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
            setEntry(key(entity), buildSnapshot(entity, deps, outputHash))
            dirty = true
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
        await dropChildrenOf(parentId, 'Pagination shrunk', { keep: destinations })
    }
    for (const parentId of lostPagination) {
        await dropChildrenOf(parentId, 'Pagination dropped')
    }

    // Skip the write entirely when nothing diverged from disk this
    // cycle — the common case on warm restarts where the source.js
    // gate suppressed every CREATE and no renders happened. Trims the
    // largest single fixed cost from the no-op cycle (was ~500ms at
    // 10k entries).
    if (!dirty) return

    // NDJSON write — one snapshot per line. Atomic via write-tmp +
    // rename so a crash mid-write leaves the previous file intact
    // rather than a truncated half-file that fails JSON.parse.
    const manifestPath = path.join(runtime.options.runtimeFolder, MANIFEST_FILE)
    const tmpPath = manifestPath + '.tmp'
    const lines = []
    for (const snapshot of entries.values()) {
        lines.push(JSON.stringify(snapshot))
    }
    await writeFile(tmpPath, lines.length ? lines.join('\n') + '\n' : '', 'utf8')
    await rename(tmpPath, manifestPath)
    dirty = false
})
