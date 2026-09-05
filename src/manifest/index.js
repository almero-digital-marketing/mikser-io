// Engine-level render manifest. Persists the per-output render cache
// across cycles and process restarts. Powers:
//
//   - stale-output cleanup on DELETE (unlinks the file on disk when
//     its source entity is gone)
//   - skip-if-unchanged at the render dispatcher: when the entity's
//     own bytes are identical to last cycle AND none of its tracked
//     dependencies (layout, partials, $-refs, queries) mutated, the
//     render is short-circuited
//   - `mikser --audit-output` walks output folder against recorded snapshots
//
// Storage: `mikser_snapshots` table in the engine's sqlite database,
// alongside `mikser_entities` and `mikser_refs`. Composite primary key
// (id, destination) keeps paginated outputs from the same source
// distinct. Reads are indexed SELECTs; writes happen in the onFinalize
// transaction so cycle state is consistent.
//
// Snapshot shape (the row is mapped to/from this object via rowToSnap /
// snapToRow):
//
//   {
//     id, destination, parent,              // identity + cleanup keys
//     inputHash,                            // entity bytes fingerprint
//     outputHash,                           // bytes-on-disk fingerprint
//                                           // (post-postprocess)
//     refClosure,                           // [{kind, target, hash?, filter?}]
//                                           // — all dependencies this
//                                           // render touched. Kinds:
//                                           // 'ref' / 'layout' /
//                                           // 'partial' / 'query'.
//                                           // Stored as JSON text in
//                                           // the refClosure column.
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


import path from 'node:path'
import runtime from '../runtime.js'
import sift from 'sift'
import { findById, findEntities } from '../catalog.js'
import { REASON, bypassReason, missingOutputIds, outputMissing, resolveOutputPath } from '../invalidation.js'
import { onFinalize, onLoaded } from '../lifecycle.js'
import { inputHashOf, lookupKeys } from '../utils/index.js'
import { existsSync } from 'fs'
import { readFile, unlink } from 'fs/promises'
import { prepareStatements } from './statements.js'
import { registerManifestHooks } from './cycle.js'
export { SNAPSHOTS_SCHEMA, FAILURES_SCHEMA } from './schema.js'
export { sourcesBehind, sourcesOf } from './sources.js'
import { sha1, describeInputChange, buildRefClosure, buildSnapshot, rowToSnap, snapToRow, hashOutputFile } from './snapshot.js'



export function createManifest(db) {
    const {
        stmtCollisions,
        stmtClaimants,
        stmtSelectByDestination,
        stmtLookupByDestination,
        stmtDeleteByDestination,
        stmtRecordFailure,
        stmtClearFailure,
        stmtClearFailuresForId,
        stmtFailuresFor,
        stmtFailureAt,
        stmtAllFailures,
        stmtLookupById,
        stmtLookup,
        stmtUpsert,
        stmtDeleteByPK,
        stmtSelectByIdOrParent,
        stmtDeleteByIdOrParent,
        stmtSelectByParent,
        stmtSelectAll,
        stmtCount,
        stmtEntityInputHashes,
        stmtDepHashes,
        stmtSnapshotsWithQuery,
        stmtSnapshotsWithLayout,
        edgeCandidates,
    } = prepareStatements(db)
    const manifest = {
        // Look up a previously-recorded entry by entity (or by an
        // object with `{id, destination}`). Returns the snapshot, or
        // null. Snapshots from older runs that predate the hash fields
        // come back with `inputHash` undefined; the skip check treats
        // those as cache misses and re-renders cleanly.
        lookup(query) {
            if (!query?.id || !query?.destination) return null
            return rowToSnap(stmtLookup.get(query.id, query.destination))
        },

        // EVERY snapshot for an entity, not just the one at a known
        // destination. An entity can have several — one per matched layout,
        // one per paginated page — and a caller asking "what happened to
        // this?" does not know the destinations in advance. That is exactly
        // the position an operator (or an agent) is in when a page did not
        // change and they want to know why.
        snapshotsFor(id) {
            if (!id) return []
            return stmtLookupById.all(id).map(rowToSnap)
        },

        // Every snapshot that claims a destination — the reverse of
        // snapshotsFor, and the entry point for "what produced this file?".
        // More than one means a collision; see collisions().
        snapshotsAt(destination) {
            if (!destination) return []
            return stmtLookupByDestination.all(destination).map(rowToSnap)
        },

        // Which destinations would re-render if this entity changed.
        //
        // Answered by running the REAL skipDecision against each candidate,
        // with the mutation maps the render loop would build for exactly this
        // one entity. A second implementation of the invalidation rule would
        // be a preview that disagrees with the cycle it is previewing, which
        // is worse than no preview: it would be trusted.
        //
        // What it cannot model, and says so at its caller: how the entity's
        // OWN meta would change. Frontmatter is parsed during import, not
        // here, so a change that alters meta.layout (and therefore the
        // destination itself) is outside what this can see. Its own snapshots
        // are reported as affected regardless, which is the safe direction.
        affectedBy(entity) {
            if (!entity?.id) return []
            const lang = entity?.meta?.lang ?? null
            const hash = inputHashOf(entity)
            const keys = lookupKeys(entity)
            const mutatedRefs = new Map(keys.map(key => [key, new Set([lang])]))
            const currentHashes = new Map(keys.map(key => [key, hash]))
            const mutatedEntities = new Map([[entity.id, entity]])

            // Three ways a snapshot can care, unioned before judging so a
            // snapshot reachable by two of them is judged once.
            const candidates = new Map()
            const consider = (id, destination) => {
                if (!id || !destination) return
                candidates.set(`${id}\u0000${destination}`, { id, destination })
            }
            for (const snap of this.snapshotsFor(entity.id)) consider(snap.id, snap.destination)
            for (const row of edgeCandidates(keys)) consider(row.id, row.destination)
            for (const id of this.queryAffected(mutatedEntities)) {
                for (const snap of this.snapshotsFor(id)) consider(snap.id, snap.destination)
            }

            const affected = []

            // Sidecars take the route above rather than the candidate walk:
            // skipDecision compares against the edges a snapshot recorded, and
            // no snapshot records an edge to a sidecar — it would answer "skip"
            // for every page and hide the whole radius.
            if (entity.type === 'sidecar') {
                for (const row of stmtSnapshotsWithLayout.iterate()) {
                    let layoutEdge = null
                    try {
                        layoutEdge = JSON.parse(row.refClosure ?? '[]').find(e => e.kind === 'layout') ?? null
                    } catch { /* unreadable closure — still affected, just unattributed */ }
                    affected.push({
                        id: row.id,
                        destination: row.destination,
                        reason: 'ref-changed',
                        ...(layoutEdge?.target ? { dependency: layoutEdge.target } : {}),
                        why: 'a layout sidecar feeds every layout through its shared digest',
                    })
                }
                return affected
            }

            for (const { id, destination } of candidates.values()) {
                // Its own renders: the premise of the question is that this
                // entity changed, so asking skipDecision — which compares the
                // hash of the entity as it stands NOW — would answer
                // "unchanged" and hide the one destination the caller is
                // certainly touching.
                if (id === entity.id) {
                    affected.push({ id, destination, reason: 'inputs-changed', why: 'this entity\'s own render' })
                    continue
                }
                const dependent = findById(id)
                if (!dependent) continue
                const decision = this.skipDecision(
                    { ...dependent, destination }, mutatedRefs, currentHashes, mutatedEntities)
                if (decision.skip) continue
                // The same provenance the build report carries. A bare list of
                // destinations answers "how many" and not "why this one",
                // which is the half that makes it checkable.
                affected.push({
                    id, destination, reason: decision.reason,
                    ...(decision.changed?.length ? { changed: decision.changed } : {}),
                    ...(decision.matched ? { matched: decision.matched } : {}),
                    ...(decision.dependency ? { dependency: decision.dependency } : {}),
                })
            }
            return affected
        },

        // Should this render be skipped? See the original docstring in
        // the prior NDJSON-backed implementation — logic is unchanged,
        // backing storage is the only thing that changed.
        // Boolean wrapper, kept because that is what the render loop asked
        // for first. skipDecision carries the same logic plus WHY, which is
        // what a machine-readable build report needs — "Rendered: 16" is a
        // number nobody can assert on.
        shouldSkip(entity, mutatedRefs, currentHashes, mutatedEntities) {
            return this.skipDecision(entity, mutatedRefs, currentHashes, mutatedEntities).skip
        },

        // { skip, reason } — reason is set either way, and the vocabulary is
        // stable so it can be asserted against:
        //
        //   unchanged        nothing this render depends on moved
        //   never-rendered   no snapshot: first build, or it never rendered
        //   output-missing   the file the last render wrote is gone from disk
        //   inputs-changed   the entity's own hash moved
        //   ref-changed      a $-ref or partial it depends on moved
        //   query-matched    an entity matching a recorded query mutated
        //   cache-disabled   meta.cache === false
        //   force            --force: skip nothing, ask nothing
        //   retry-failed     the last render attempt for this destination
        //                    threw; nothing else would reschedule it
        skipDecision(entity, mutatedRefs, currentHashes, mutatedEntities) {
            // --force means "ignore what you think you know". THREE gates
            // can stop a render — source.js's import checksum gate,
            // layouts' dispatch filter, and this one — and force has to
            // reach all three. This one runs last, so if it alone ignores
            // force, a forced build re-imports everything, re-dispatches
            // everything, and drops all of it here as `unchanged`:
            // rendered=0, and a summary that reads like a success.
            //
            // That is the situation --force exists for — the invalidation
            // graph being under suspicion — including where the preset
            // no-match warning tells the operator to use it.
            // --force and a wiped cache both mean "ignore what you think you
            // know", and both are declared in invalidation.js so a third one
            // added there reaches this gate without being remembered.
            const override = bypassReason()
            if (override) return { skip: false, reason: override }
            if (entity?.meta?.cache === false) return { skip: false, reason: REASON.CACHE_DISABLED }
            // A render whose last attempt threw must be retried, and checked
            // before anything else: every other branch reasons about hashes,
            // and the hashes are consistent — the entity did not change, the
            // snapshot still describes the last GOOD render. Consistency is
            // exactly why the failure is invisible without this.
            //
            // Retried unbounded, and noisily. A page that fails every cycle IS
            // failing every cycle, and a build that stops mentioning it after
            // the third attempt is making the same trade as reporting
            // `rendered: 12, exit 0`. What makes it tolerable is presentation
            // — one line per failing entity, and `since` on the report so a
            // reader can tell "broke just now" from "broken since 14:02" —
            // not backoff.
            const failure = this.failureAt(entity?.id, entity?.destination)
            if (failure) {
                return {
                    skip: false,
                    reason: 'retry-failed',
                    failure: {
                        error: failure.error,
                        since: failure.firstFailedAt ?? null,
                        attempts: failure.attempts ?? 1,
                    },
                }
            }
            const snapshot = this.lookup(entity)
            if (!snapshot?.inputHash) return { skip: false, reason: 'never-rendered' }
            if (inputHashOf(entity) !== snapshot.inputHash) {
                // Name the component that moved. "inputs-changed" alone is
                // the answer to a question nobody asked — the reader wants to
                // know WHICH input, and the recorded parts have it.
                return {
                    skip: false,
                    reason: 'inputs-changed',
                    changed: describeInputChange(entity, snapshot),
                }
            }
            // The inputs say nothing moved. That is only a reason to skip if
            // the thing the last render PRODUCED is still there.
            //
            // Every branch above this one reasons about inputs, and inputs are
            // not where `rm -rf out` shows up: the documents are unchanged,
            // because what was deleted is the output. So the build skips every
            // entity, renders nothing, prints no `Rendered:` line and exits 0
            // with an empty output folder — correct by its own reasoning and
            // wrong about the only question the caller asked. A missing output
            // is a reason to re-render, not a reason to report unchanged.
            //
            // Placed after the input comparison and before the refClosure walk
            // so one check covers both `unchanged` exits, and placed here
            // rather than in the render loop because this is the function that
            // owns the word: anything asking shouldSkip() gets the same answer.
            //
            // Asked of invalidation.js rather than answered here, so that
            // auditOutput, the source gate and the assets marker resolve a
            // destination the same way. The two disagreeing is the bug —
            // `--audit-output` finding what the build just called clean is
            // what sends people to this function in the first place.
            if (outputMissing(snapshot.destination)) {
                return { skip: false, reason: REASON.OUTPUT_MISSING, destination: snapshot.destination }
            }
            if (!snapshot.refClosure?.length) return { skip: true, reason: 'unchanged' }
            const sourceLang = entity?.meta?.lang ?? null
            for (const entry of snapshot.refClosure) {
                if (entry.kind === 'query') {
                    // A null filter is the sentinel for a predicate that
                    // could not be serialized — findEntities() with no
                    // argument, or a function filter. It re-renders on ANY
                    // mutation, which is a materially different situation
                    // from "this specific query matched" and is reported as
                    // such: an aggregate page that always re-renders is a
                    // filter worth narrowing, which is what catalog.js
                    // already warns about at record time.
                    if (!entry.filter) {
                        return {
                            skip: false,
                            reason: 'query-matched',
                            matched: { filter: null, by: null },
                        }
                    }
                    if (!mutatedEntities?.size) continue
                    const matcher = sift(entry.filter)
                    for (const mutated of mutatedEntities.values()) {
                        // Both the filter and the entity that tripped it are
                        // live here. Reporting only "a query matched" throws
                        // away the two facts the reader needs — on a page with
                        // eighteen query edges, which one fired and what set
                        // it off is the entire question.
                        if (matcher(mutated)) {
                            return {
                                skip: false,
                                reason: 'query-matched',
                                matched: { filter: entry.filter, by: mutated.id ?? null },
                            }
                        }
                    }
                    continue
                }
                // An edge is checked against every key it could have been
                // hit by: the entity it BOUND to, and the name it asked
                // for. entity.id is always lookupKeys()[0], so the engine's
                // mutation maps are already keyed by id — reading them by
                // targetId needs no change there, and a binding survives
                // the target renaming itself.
                //
                // Both, not the first match, because the two can disagree:
                // the bound entity may be re-persisted unchanged in the
                // same cycle that a DIFFERENT entity starts answering to
                // the same name. Stopping at the binding compares an
                // unchanged hash and skips, silently ignoring the new
                // claimant. The name key also carries unresolved/forward
                // edges, which is how a link to a not-yet-existing page
                // invalidates once that page appears.
                const keys = [
                    ...(entry.targetIds ?? []),
                    ...(entry.targetId ? [entry.targetId] : []),
                    entry.target,
                ]
                for (const key of keys) {
                    if (!mutatedRefs?.has(key)) continue
                    // Language scope: if the source has a meta.lang AND the
                    // mutation came from a different meta.lang, the ref
                    // doesn't actually depend on what changed. A `null` lang
                    // in the mutation set means a shared (un-localized)
                    // entity touched the same key — that does invalidate
                    // language-specific sources because the shared entity
                    // is the only variant. Sources without a meta.lang are
                    // language-agnostic and accept any mutation lang.
                    if (sourceLang) {
                        const mutatedLangs = mutatedRefs.get(key)
                        if (mutatedLangs && !mutatedLangs.has(sourceLang) && !mutatedLangs.has(null)) {
                            continue
                        }
                    }
                    // Which dependency, and why. Three distinct causes reach
                    // the same reason, and the difference is what the reader
                    // is after: a layout whose bytes moved, a $-ref whose
                    // target was deleted, and an edge recorded with no hash
                    // are three different things to go and look at.
                    //
                    //   unhashed  nothing resolved when the edge was recorded,
                    //             so any mutation of that name re-renders
                    //   deleted   the target is gone from the catalog
                    //   changed   the target's own input hash moved
                    const dependency = (cause) => ({
                        skip: false,
                        reason: 'ref-changed',
                        dependency: { kind: entry.kind, target: entry.target, key, cause },
                    })
                    if (!entry.hash) return dependency('unhashed')
                    const currentHash = currentHashes?.get(key)
                    if (currentHash === undefined) continue
                    if (currentHash === null) return dependency('deleted')
                    if (currentHash !== entry.hash) return dependency('changed')
                }
            }
            return { skip: true, reason: 'unchanged' }
        },

        // Record that a render attempt threw. `at` is passed in rather than
        // read from the clock here so the caller owns the timestamp.
        recordFailure(entity, { error, context, at }) {
            if (!entity?.id || !entity?.destination) return
            stmtRecordFailure.run({
                id: entity.id,
                destination: entity.destination,
                error: error ?? null,
                context: context ?? null,
                at: at ?? Date.now(),
            })
        },

        // The entity is gone, so every failure recorded against it is
        // irrelevant regardless of which destination it was recorded at.
        //
        // Deliberately NOT a foreign key with ON DELETE CASCADE, which is how
        // mikser_refs handles the same situation: a render task's id is not
        // guaranteed to be a row in mikser_entities — snapshots carry a
        // `parent` precisely because paginated children render under derived
        // ids — so an FK would make recordFailure throw from inside the
        // handler that exists to report a render error, turning a reported
        // failure into a crash.
        //
        // A rename presents as delete + create under a new id, so this covers
        // that residue too: the old id's rows go with the delete.
        clearFailures(id) {
            if (!id) return
            stmtClearFailuresForId.run(id)
        },

        // A render succeeded, so whatever was recorded about it failing is
        // no longer true. Called on every success, not only after a failure —
        // it is a cheap DELETE and forgetting it would strand the marker.
        clearFailure(entity) {
            if (!entity?.id || !entity?.destination) return
            stmtClearFailure.run(entity.id, entity.destination)
        },

        // Destinations claimed by more than one entity.
        //
        // Two entities rendering to one path is always a bug — one silently
        // overwrites the other — and it is invisible to every other check.
        // Not to `verify`'s hash comparison in particular: each render
        // records the hash of the file AFTER it wrote, so with concurrent
        // renders the loser reads the winner's bytes and both snapshots
        // agree with disk. Measured on the case this exists for: an empty
        // stub and a real homepage both claiming /bg/index.html recorded the
        // SAME outputHash, and verify reported OK.
        //
        // So it is detected structurally rather than by content: the
        // manifest already knows both claimants because a snapshot is keyed
        // (id, destination).
        collisions() {
            return stmtCollisions.all().map(row => ({
                destination: row.destination,
                entities: String(row.ids).split(',').filter(Boolean).sort(),
            }))
        },

        // Which entity's recorded bytes are the ones on disk right now.
        // Answers "who wrote this?" for a destination several entities
        // claim, which is the question a mismatch leaves open.
        writerOf(destination, outputHash) {
            if (!destination || !outputHash) return null
            const rows = stmtClaimants.all(destination)
            const match = rows.find(r => r.outputHash === outputHash)
            return match?.id ?? null
        },

        // Every recorded failure for an entity, across destinations.
        failuresFor(id) {
            return id ? stmtFailuresFor.all(id) : []
        },

        // One, at a known destination.
        failureAt(id, destination) {
            if (!id || !destination) return null
            return stmtFailureAt.get(id, destination) ?? null
        },

        // Every entity id with a recorded failure. The dispatch set a
        // task-production plugin unions in so a failed render is retried:
        // the entity's own source has not changed, so nothing else will
        // schedule it, and going quiet about a page that will not build is
        // the failure mode this whole area exists to avoid.
        failedIds() {
            return [...new Set(stmtAllFailures.all().map(row => row.id))]
        },

        allFailures() {
            return stmtAllFailures.all()
        },

        // Record a successful render. Single INSERT OR REPLACE.
        record(entity, deps, metaReads, consumedReads) {
            stmtUpsert.run(snapToRow(buildSnapshot(entity, deps, undefined, metaReads, consumedReads)))
        },

        // Return the set of entity ids whose recorded snapshots have a
        // query dep that matches any of the cycle's mutated entities.
        // The static-ref closure walk (refs.inverseClosureOf) only finds
        // entities reachable via $-keyed edges in mikser_refs; aggregate
        // layouts that depend on findEntities(...) results need this
        // second-pass dispatch hint.
        //
        // Cheap when there are no aggregate layouts (LIKE pre-filter
        // returns no rows). Cost scales with (snapshots-with-query) ×
        // (mutated-entities), both typically small.
        queryAffected(mutatedEntities) {
            const affected = new Set()
            if (!mutatedEntities?.size) return affected
            for (const row of stmtSnapshotsWithQuery.iterate()) {
                const refClosure = row.refClosure ? JSON.parse(row.refClosure) : []
                let hit = false
                for (const entry of refClosure) {
                    if (entry.kind !== 'query') continue
                    if (!entry.filter) {
                        // Null filter = unserializable predicate captured
                        // at render time. Conservative: invalidate on any
                        // mutation.
                        hit = true
                        break
                    }
                    const matcher = sift(entry.filter)
                    for (const mutated of mutatedEntities.values()) {
                        if (matcher(mutated)) {
                            hit = true
                            break
                        }
                    }
                    if (hit) break
                }
                if (hit) affected.add(row.id)
            }
            return affected
        },

        // Drop all snapshots owned by entity id (direct outputs and any
        // paginated children whose `parent` is set to this id). Returns
        // the destinations that were removed so callers can unlink the
        // corresponding files when desired. Two queries (SELECT for
        // destinations, DELETE for cleanup) wrapped in a transaction.
        remove(id) {
            const rows = stmtSelectByIdOrParent.all(id, id)
            stmtDeleteByIdOrParent.run(id, id)
            return rows.map(r => r.destination)
        },

        // Yield every recorded snapshot. Generator so callers don't pay
        // for the whole result set upfront when they short-circuit.
        *all() {
            for (const row of stmtSelectAll.iterate()) {
                yield rowToSnap(row)
            }
        },

        // Id → inputHash Map mined across every snapshot. Used by the
        // layouts dispatcher as its hash-aware seeding filter.
        //
        // Two indexed-projection queries instead of the prior scan-
        // and-parse-every-row loop. At 110k snapshots the old loop
        // parsed ~500MB of refClosure JSON in JS per cycle; this path
        // moves the json work into sqlite's json_each (C) and projects
        // just the (target, hash) pairs we actually need.
        //
        // Entity inputHashes come from the indexed `inputHash` column
        // directly. Dep hashes come from a json_each flatten with a
        // GROUP BY target so 110k snapshots × ~3 deps each → ~20
        // distinct rows hit JS.
        //
        // Entity hashes are loaded first so they "win" over dep hashes
        // for the same id (matches the prior first-seen-wins semantic;
        // entity inputHashes were always added before deps in the
        // earlier loop).
        // An entity whose output is gone is omitted entirely. The consumer
        // uses a recorded hash to decide "this needs no render", and that
        // conclusion only follows while the file the hash describes is still
        // there. Omitting is the whole fix at this gate: a seed with no
        // recorded hash is always dispatched.
        //
        // Done here rather than in the dispatcher because this map exists for
        // that one decision, and a second consumer would otherwise have to
        // rediscover the same caveat. missingOutputIds() is memoized for the
        // cycle, so this shares the walk the source gate already paid for.
        recordedHashes() {
            const missingOutputs = missingOutputIds()
            const map = new Map()
            for (const row of stmtEntityInputHashes.iterate()) {
                if (missingOutputs.has(row.id)) continue
                map.set(row.id, row.inputHash)
            }
            for (const row of stmtDepHashes.iterate()) {
                if (missingOutputs.has(row.target)) continue
                if (!map.has(row.target)) map.set(row.target, row.hash)
            }
            return map
        },

        // Build the dep-edge array the engine threads into a snapshot
        // via record(entity, edges).
        collectEdges({ entity, track, sidecarQueries }) {
            const edges = []
            if (entity?.layout?.id) {
                edges.push({
                    kind: 'layout',
                    target: entity.layout.id,
                    targetId: entity.layout.id,
                    hash: inputHashOf(entity.layout),
                })
            }
            if (track?.partials) {
                for (const target of track.partials) {
                    const partial = findById(target)
                    edges.push({
                        kind: 'partial',
                        target,
                        targetId: partial ? target : undefined,
                        hash: partial ? inputHashOf(partial) : undefined,
                    })
                }
            }
            if (track?.lookups) {
                for (const [target, ids] of track.lookups) {
                    // The lookup helper has already resolved this and
                    // handed over the ids, so the hash comes from the
                    // BOUND entity. It must not come from
                    // findById(target): that is an exact primary-key read
                    // and resolves neither meta.href nor meta.url nor a
                    // stripped extension, so any href- or url-form target
                    // yields no hash and the manifest cannot tell "target
                    // moved" from "target changed".
                    //
                    // No hash means "nothing resolved", and skipDecision
                    // re-renders a hashless edge whose target mutated —
                    // which is what should happen when a page that was
                    // linked-to-but-missing finally appears.
                    const targetIds = [...ids]
                    const bound = targetIds.length === 1 ? findById(targetIds[0]) : null
                    edges.push({
                        kind: 'lookup',
                        target,
                        targetId: targetIds.length === 1 ? targetIds[0] : undefined,
                        targetIds: targetIds.length > 1 ? targetIds : undefined,
                        hash: bound ? inputHashOf(bound) : undefined,
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
        // a diff describing missing / mismatched / orphaned /
        // unverifiable. Backs `mikser --audit-output`. Pure: no mutations.
        async auditOutput({ outputFolder, roots } = {}) {
            outputFolder = outputFolder || runtime.options.outputFolder
            const missing = []
            const mismatched = []
            const unverifiable = []
            const claimed = new Set()
            for (const row of stmtSelectAll.iterate()) {
                const snap = rowToSnap(row)
                if (!snap.destination) continue
                const filePath = resolveOutputPath(snap.destination, outputFolder)
                // Claimed by ABSOLUTE path, so the set does not depend on the
                // relative form any particular walk produces. It was keyed on
                // a path relative to outputFolder, which worked only while
                // that was the one tree walked — and quietly claimed nothing
                // for every destination outside it.
                claimed.add(path.resolve(filePath))
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
                    const actual = sha1(buf)
                    if (actual !== snap.outputHash) {
                        // Name who DID write the bytes that are there, when a
                        // sibling snapshot for the same destination matches
                        // them. "Mismatched" alone leaves the reader to work
                        // out whether the file was edited by hand or lost a
                        // race with another entity claiming the same path.
                        mismatched.push({
                            id: snap.id,
                            destination: snap.destination,
                            writtenBy: this.writerOf(snap.destination, actual),
                        })
                    }
                } catch {
                    missing.push({ id: snap.id, destination: snap.destination })
                }
            }
            const { globby } = await import('globby')
            // Every tree mikser writes into, not only the output folder.
            //
            // Preset derivatives live at the working-folder root and reach
            // the site through a symlink, which the walk does not follow — so
            // a file nothing claims there was invisible to this check, which
            // is the one place the concept of an orphan exists. Plugins
            // declare their own trees on `runtime.options.auditRoots`,
            // carrying their own ignore patterns, so nothing here has to know
            // what a preset is or that a `.md5` beside a derivative is
            // bookkeeping rather than output.
            const declared = [{ path: outputFolder }, ...(roots ?? runtime.options.auditRoots ?? [])]
            const walked = []
            for (const root of declared) {
                const resolved = path.resolve(root.path ?? root)
                // A root inside one already walked would report every file in
                // it twice.
                const nested = walked.some(({ resolved: seen }) =>
                    resolved === seen || resolved.startsWith(seen + path.sep))
                if (nested) continue
                walked.push({ resolved, ignore: root.ignore ?? [] })
            }
            const orphaned = []
            for (const { resolved, ignore } of walked) {
                const onDisk = await globby('**/*', {
                    cwd: resolved,
                    onlyFiles: true,
                    followSymbolicLinks: false,
                    ignore,
                })
                for (const rel of onDisk) {
                    if (claimed.has(path.join(resolved, rel))) continue
                    // Relative to the output folder for the output folder, as
                    // before; relative to the working folder for anything
                    // else, because `web/media/x.jpg` alone does not say which
                    // tree it is in.
                    const isOutput = resolved === path.resolve(outputFolder)
                    const display = isOutput
                        ? rel
                        : path.relative(runtime.options.workingFolder ?? resolved, path.join(resolved, rel))
                    orphaned.push({ path: display, root: resolved })
                }
            }
            // Reported alongside, not as a mismatch: two entities claiming one
            // destination usually produces NO mismatch at all, because each
            // render hashes the file after writing it and the loser reads the
            // winner's bytes. Without this the whole situation is silent.
            const collisions = this.collisions()
            // One verdict, computed here, because three callers report it —
            // the CLI's exit code, the api route and the MCP tool — and three
            // copies of the rule would drift.
            //
            // A collision is a WARNING, not a failure: nothing is missing or
            // corrupt, the bytes on disk are some entity's real render. What
            // is wrong is that another entity's output was discarded, which
            // the reader has to be told about but which does not mean the
            // deploy is broken in the way a missing or altered file does.
            // It is also pre-existing on any site that already has one, so
            // failing the gate outright would break pipelines on upgrade for
            // a condition that was always there.
            const errors = missing.length + mismatched.length
            const warnings = orphaned.length + unverifiable.length + collisions.length
            return {
                verdict: errors > 0 ? 'FAIL' : warnings > 0 ? 'WARN' : 'OK',
                missing, mismatched, unverifiable, orphaned, collisions,
            }
        },

        size() {
            return stmtCount.get().c
        },

        // Internals exposed for onFinalize's batch operations. Not
        // part of the public surface — they go straight to the
        // prepared statements without rebuilding them.
        _stmtSelectByIdOrParent: stmtSelectByIdOrParent,
        _stmtDeleteByIdOrParent: stmtDeleteByIdOrParent,
        _stmtSelectByParent:     stmtSelectByParent,
        _stmtSelectByDestination: stmtSelectByDestination,
        _stmtDeleteByDestination: stmtDeleteByDestination,
        _stmtDeleteByPK:         stmtDeleteByPK,
        _stmtLookup:             stmtLookup,
        _stmtUpsert:             stmtUpsert,
    }
    return manifest
}


// Wire to the lifecycle. Loads at onLoaded so plugins observing it
registerManifestHooks(createManifest)
