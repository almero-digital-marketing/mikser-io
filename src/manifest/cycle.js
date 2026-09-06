// The manifest's own lifecycle: opening against the cycle's database at
// onLoaded, and at onFinalize draining the journal, hashing what was
// written, and committing every mutation in one transaction.

import path from 'node:path'
import runtime from '../runtime.js'
import { OPERATION } from '../constants.js'
import { useDatabase } from '../database/index.js'
import { useLogger } from '../engine/index.js'
import { forgetMissingOutputs } from '../invalidation.js'
import { useJournal } from '../journal.js'
import { onFinalize, onLoaded } from '../lifecycle.js'
import { unlink } from 'fs/promises'
import { buildSnapshot, hashOutputFile, snapToRow } from './snapshot.js'
import { renderedByDependency } from '../report.js'

// The manifest instance and its database, owned here because this is the only
// place either is assigned: onLoaded builds them, onFinalize commits through
// them. `createManifest` arrives as an argument rather than an import, so
// index.js can own the factory without the two files importing each other.
let sharedDb = null
let sharedManifest = null

export function registerManifestHooks(createManifest) {
// from their own onLoaded see a fully-populated `runtime.manifest`.
// Cleanup + persist happen at onFinalize, matching the cycle's natural
// rhythm.
onLoaded(async () => {
    sharedDb = useDatabase()
    if (!sharedDb) throw new Error('manifest requires the database; useDatabase() returned null')
    sharedManifest = createManifest(sharedDb)
    runtime.manifest = sharedManifest
})

// Use onFinalize (not onFinalized) so the journal still has this
// cycle's RENDER entries when we walk them.
//
// Per the migration plan's per-phase transaction granularity, the
// onFinalize work commits in one transaction at the end. But: there
// are async file operations (unlink, hashOutputFile) interleaved with
// the DB writes. better-sqlite3's transaction() wrapper is sync-only,
// so we structure as: drain journal + do async file ops + collect DB
// mutations into batches, then commit the batches inside a single
// sync transaction.
onFinalize(async () => {
    const logger = useLogger()

    // Drain journal entries into mutation lists. We can't apply yet —
    // the file ops below need to be async, and the DB transaction
    // below needs to be sync. Stage everything, then commit.
    const deletedIds = []          // entity ids to drop from manifest
    const renderedEntries = []     // RENDER entries to record
    const newDestinationsByParent = new Map()
    const lostPagination = new Set()

    for await (const { entity } of useJournal('Manifest cleanup', [OPERATION.DELETE])) {
        deletedIds.push(entity.id)
    }

    for await (const { output, entity, deps } of useJournal('Output', [OPERATION.RENDER])) {
        if (output?.success && !output.skipped) {
            renderedEntries.push({ entity, deps, metaReads: output.metaReads,
                                   consumedReads: output.consumedReads })
            if (entity.pages > 1) {
                const parentId = entity.parent ?? entity.id
                if (!newDestinationsByParent.has(parentId)) {
                    newDestinationsByParent.set(parentId, new Set())
                }
                newDestinationsByParent.get(parentId).add(entity.destination)
            } else if (!entity.parent) {
                lostPagination.add(entity.id)
            }
        }
    }

    // File ops are async — unlink stale outputs from prior cycles,
    // hash this cycle's rendered files. Has to happen before the DB
    // transaction because better-sqlite3's transaction() callback is
    // sync-only.
    const m = sharedManifest

    // 2a. Stage file unlinks for deleted entities + their children.
    const deleted = new Set(deletedIds)
    const filesToUnlink = []
    const staged = new Set()
    const stageUnlink = (destination) => {
        if (!destination || staged.has(destination)) return
        staged.add(destination)
        filesToUnlink.push({ destination, reason: 'Entity deleted' })
    }
    for (const id of deletedIds) {
        for (const row of m._stmtSelectByIdOrParent.all(id, id)) {
            stageUnlink(row.destination)
        }
    }
    // Recorded snapshots only describe PRIOR cycles. An entity rendered and
    // deleted within the same cycle has no row to look its destination up in —
    // on a first build there is no row at all — so the file it just wrote would
    // survive both the entity and its snapshot. Take the destination from this
    // cycle's render entries instead.
    for (const { entity } of renderedEntries) {
        if (deleted.has(entity.id) || (entity.parent && deleted.has(entity.parent))) {
            stageUnlink(entity.destination)
        }
    }

    // 2b. Pagination shrunk — drop children whose destination wasn't
    // re-emitted this cycle.
    const childrenToDelete = []   // [{id, destination, reason}]
    for (const [parentId, keep] of newDestinationsByParent) {
        const rows = m._stmtSelectByParent.all(parentId)
        for (const row of rows) {
            if (keep.has(row.destination)) continue
            filesToUnlink.push({ destination: row.destination, reason: 'Pagination shrunk' })
            childrenToDelete.push({ id: row.id, destination: row.destination })
        }
    }

    // 2c. Pagination lost — parent went from paginated to single-page.
    for (const parentId of lostPagination) {
        const rows = m._stmtSelectByParent.all(parentId)
        for (const row of rows) {
            filesToUnlink.push({ destination: row.destination, reason: 'Pagination dropped' })
            childrenToDelete.push({ id: row.id, destination: row.destination })
        }
    }

    // Everything whose snapshot this pass removes: deleted entities, their
    // paginated children, and children dropped by a pagination shrink.
    const goingAway = new Set(deleted)
    for (const { id } of childrenToDelete) goingAway.add(id)
    for (const parentId of deleted) {
        for (const row of m._stmtSelectByParent.all(parentId)) goingAway.add(row.id)
    }

    // 2d. Unlink stale output files (async, parallel-friendly).
    //
    // Never unlink a destination another entity still claims. Two entities
    // can render to one path — an empty `index.md` beside the real
    // `index.yml` — and deleting one of them was taking the shared output
    // with it: the file vanished while the survivor's snapshot still said it
    // was there, the survivor's own source had not changed so nothing
    // re-rendered it, and --audit-output reported it missing.
    //
    // That made "resolve the collision by deleting the stub" delete the
    // homepage, which is the opposite of what the operator asked for and the
    // exact operation the new collision reporting invites.
    // Destinations THIS cycle's surviving renders just wrote.
    //
    // Their snapshot rows are not inserted until 3c below, so the
    // by-destination query cannot see them — the same blind spot 2a already
    // compensates for in the other direction ("recorded snapshots only
    // describe PRIOR cycles").
    //
    // Without this, renaming a source's extension unlinks the output the new
    // entity just wrote. `index.md` → `index.yml` keeps the entity NAME and
    // the destination but changes the id, so one cycle carries a DELETE for
    // the old id and a RENDER for the new one. The render writes the page,
    // the delete stages the same destination, nothing surviving claims it
    // yet, and the file goes — with `Rendered: 1`, a green build and no
    // warning. A second build does not fix it (nothing changed), nor does
    // touch (the input hash is the same); only a real content edit re-renders
    // it. Only --audit-output ever said so, and renaming an extension is the most
    // common action there is during a migration.
    const claimedByThisCycle = new Set()
    for (const { entity } of renderedEntries) {
        if (deleted.has(entity.id) || (entity.parent && deleted.has(entity.parent))) continue
        if (entity.destination) claimedByThisCycle.add(entity.destination)
    }

    for (const { destination, reason } of filesToUnlink) {
        // Written this cycle by an entity that is staying. Keep it, and say
        // nothing: the snapshot recorded at 3c is this render's own, so there
        // is no staleness to report — unlike the surviving-snapshot case
        // below, where the bytes belong to the entity that went away.
        if (claimedByThisCycle.has(destination)) continue

        // "Still claimed" means by something that SURVIVES this pass. The
        // ids going away here are not just the deleted entities: pagination
        // children staged above are removed too, and counting a child's own
        // snapshot as a claimant would keep every shrunk page on disk
        // forever.
        const stillClaimed = m._stmtSelectByDestination.all(destination)
            .filter(row => row.id !== undefined && !goingAway.has(row.id))
        if (stillClaimed.length) {
            // Keep the file — deleting a live page's output is worse than any
            // staleness — but do NOT let the state go quiet. The bytes on
            // disk were written by the entity that just went away, and the
            // survivor's snapshot recorded that same hash (each render hashes
            // the file after writing, so the loser recorded the winner's
            // bytes). Left alone, verify would compare the survivor's
            // snapshot against the deleted entity's output and report OK.
            //
            // Dropping the survivor's snapshot for this destination makes it
            // an orphan — a file no snapshot claims, which is exactly what it
            // is — so verify warns instead of blessing it, and the next time
            // the survivor renders it is `never-rendered` rather than skipped.
            m._stmtDeleteByDestination.run(destination)
            logger.warn(
                '%s: %s is also written by %s — keeping the file, but its bytes came from the '
                + 'deleted entity. Re-render or --force to refresh it.',
                reason, destination, stillClaimed.map(r => r.id).join(', '))
            continue
        }
        const filePath = path.join(runtime.options.outputFolder, destination)
        try {
            await unlink(filePath)
            logger.debug('%s: unlinked %s', reason, destination)
        } catch { /* file already gone or never existed — fine */ }
    }

    // 2e. Hash the rendered output files (async).
    //
    // An id can appear in BOTH drains within one cycle — rendered, then
    // deleted. A render that opts out of the catalog journals its DELETE the
    // moment it resolves, so the RENDER and the DELETE sit in the same
    // journal. 3a below drops the snapshot and 3c would insert it straight
    // back, undoing the delete inside its own transaction. The DELETE wins:
    // the entity is gone, so nothing may go on describing it. Skipping here
    // rather than in 3c also saves hashing an output that was just unlinked.
    //
    // `parent` is checked too, mirroring _stmtDeleteByIdOrParent — a deleted
    // parent takes its paginated children's snapshots with it.
    const recordedSnapshots = []
    // Entities whose output moved while their inputs did not — collected
    // inside the transaction, reported by the caller once it commits.
    const drifted = []
    for (const { entity, deps, metaReads, consumedReads } of renderedEntries) {
        if (deleted.has(entity.id) || (entity.parent && deleted.has(entity.parent))) continue
        const outputHash = await hashOutputFile(entity.destination)
        recordedSnapshots.push(buildSnapshot(entity, deps, outputHash, metaReads, consumedReads))
    }

    // Apply all DB mutations atomically.
    sharedDb.transaction(() => {
        // 3a. Delete by entity id or parent (DELETE journal entries).
        for (const id of deletedIds) {
            m._stmtDeleteByIdOrParent.run(id, id)
        }
        // 3b. Pagination children cleanup.
        for (const { id, destination } of childrenToDelete) {
            m._stmtDeleteByPK.run(id, destination)
        }
        // 3c. Record successful renders.
        //
        // Drift: the same inputs produced different output.
        //
        // The row about to be replaced is still readable here, and it carries
        // both hashes — so an output that moved while its inputHash stood
        // still is knowable at the moment it happens, for the cost of one
        // lookup. That is a rendering change nobody asked for: an upgraded
        // renderer, a changed helper, a dependency that shifted under the
        // build.
        //
        // "Every entity input is in inputHash by construction" is what this
        // used to say, and it is false. inputHash covers the entity's OWN
        // meta and checksum. An entity assembled from a query — a CSS bundle
        // globbing styles/**/*.css, a page listing its collection — has every
        // real input outside it, reaching the render through refClosure. Its
        // inputHash is CONSTANT by construction, so editing any part tripped
        // this check on every build, forever, telling the reader the cause was
        // an upgraded renderer when it was the file they had just saved.
        //
        // The refClosure cannot settle it either: a query edge records the
        // filter and how many matched, not a hash of what they contained, so
        // it is identical before and after the edit.
        //
        // What does settle it is WHY the render happened. `ref-changed` and
        // `query-matched` mean something this entity consumes moved — that is
        // an input change the hashes cannot see, and not drift. Everything
        // else with an unchanged inputHash still is: --force sweeps, retries,
        // a renderer that stopped being a function of its inputs.
        //
        // Recorded here rather than checked later because later is too late —
        // the render rewrites its own snapshot, so by the time anything asks,
        // the evidence has been replaced by the new bytes agreeing with
        // themselves. That is why --audit-output reported OK on a regression.
        //
        // Only entities that actually rendered can drift. Under an ordinary
        // build the unchanged ones are skipped and never reach here, so this
        // reports on what moved; under --force everything re-renders with
        // unchanged inputs, which makes it a full sweep.
        const dependencyDriven = renderedByDependency()
        for (const snap of recordedSnapshots) {
            const prior = m._stmtLookup.get(snap.id, snap.destination)
            if (prior
                && prior.inputHash
                && prior.inputHash === snap.inputHash
                && prior.outputHash
                && snap.outputHash
                && prior.outputHash !== snap.outputHash
                && !dependencyDriven.has(snap.id)) {
                drifted.push({ id: snap.id, destination: snap.destination })
            }
            m._stmtUpsert.run(snapToRow(snap))
        }
    })

    // Reported after the transaction, so the log never describes a commit
    // that did not happen.
    //
    // A warning, not an error: identical inputs CAN legitimately produce
    // different bytes — a template that prints a timestamp, an id drawn at
    // random. Those are worth knowing about once, and then worth fixing,
    // because a render that is not a function of its inputs cannot be
    // cached, compared or trusted to be reproducible.
    if (drifted.length) {
        const SHOWN = 10
        for (const { id, destination } of drifted.slice(0, SHOWN)) {
            logger.warn({ code: 'output-drift', entity: id, destination },
                'Output changed with unchanged inputs: %s → %s', id, destination)
        }
        logger.warn({ code: 'output-drift-summary', drifted: drifted.length },
            '%d render(s) produced different bytes from the same inputs%s. Nothing about the content '
            + 'moved, so the cause is outside it — an upgraded renderer, a changed helper, a dependency '
            + 'that shifted under the build. This is the check --audit-output structurally cannot make: '
            + 'a render rewrites its own snapshot, so afterwards the new bytes agree with themselves.',
            drifted.length, drifted.length > SHOWN ? `, ${SHOWN} shown` : '')
    }

    // This cycle just wrote files and recorded snapshots for them, so the
    // memoized missing-output set describes a state that no longer exists.
    // Dropped here rather than at the start of the next cycle because in
    // watch mode there may not be one for hours, and a stale set held that
    // long would keep re-dispatching entities it saw as missing.
    forgetMissingOutputs()
})
}
