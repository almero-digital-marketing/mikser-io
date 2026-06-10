// Engine-level render manifest. Persists the per-output render cache
// across cycles and process restarts. Powers:
//
//   - stale-output cleanup on DELETE (unlinks the file on disk when
//     its source entity is gone)
//   - skip-if-unchanged at the render dispatcher: when the entity's
//     own bytes are identical to last cycle AND none of its tracked
//     dependencies (layout, partials, $-refs, queries) mutated, the
//     render is short-circuited
//   - `mikser --verify` walks output folder against recorded snapshots
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

import crypto from 'node:crypto'
import path from 'node:path'
import { readFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import sift from 'sift'
import runtime from './runtime.js'
import { useLogger } from './engine.js'
import { onLoaded, onFinalize } from './lifecycle.js'
import { useJournal } from './journal.js'
import { OPERATION } from './constants.js'
import { extractRefs, inputHashOf } from './utils.js'
import { filterKey } from './track.js'
import { findById } from './catalog.js'
import { useDatabase, registerSchema } from './database/index.js'

export { inputHashOf } from './utils.js'

// Schema registration. Applied at db.open(). PRIMARY KEY (id,
// destination) — leading id column means `WHERE id = ?` queries use the
// PK index, no separate id index needed. Parent index is for pagination
// cleanup (drop all children of X). WITHOUT ROWID keeps the file
// smaller.
registerSchema('mikser_snapshots', `
    CREATE TABLE IF NOT EXISTS mikser_snapshots (
        id          TEXT NOT NULL,
        destination TEXT NOT NULL,
        inputHash   TEXT,
        outputHash  TEXT,
        refClosure  TEXT,
        renderedAt  INTEGER,
        parent      TEXT,
        PRIMARY KEY (id, destination)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_mikser_snapshots_parent ON mikser_snapshots(parent) WHERE parent IS NOT NULL;
`)

// Module-level DB handle + prepared statements for the lifecycle
// integration. Tests build their own via `createManifest(db)` —
// the lifecycle hook below grabs useDatabase() and stashes the
// handle here so the onFinalize hook can use the same prepared
// statements as the runtime.manifest exposes.
let sharedDb = null
let sharedManifest = null

function sha1(payload) {
    return crypto.createHash('sha1').update(String(payload)).digest('hex')
}

// refClosure builder — same logic as before, no DB involvement.
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
    if (entity.meta) {
        for (const { ref } of extractRefs(entity.meta)) {
            const target = findById(ref)
            pushTarget('ref', ref, target ? inputHashOf(target) : undefined)
        }
    }
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

// Map a sqlite row → snapshot object. `refClosure` is JSON-decoded
// here so callers don't have to think about the wire format.
function rowToSnap(row) {
    if (!row) return null
    return {
        id:          row.id,
        destination: row.destination,
        inputHash:   row.inputHash ?? undefined,
        outputHash:  row.outputHash ?? undefined,
        refClosure:  row.refClosure ? JSON.parse(row.refClosure) : undefined,
        renderedAt:  row.renderedAt ?? undefined,
        parent:      row.parent ?? undefined,
    }
}

function snapToRow(snap) {
    return {
        id:          snap.id,
        destination: snap.destination,
        inputHash:   snap.inputHash   ?? null,
        outputHash:  snap.outputHash  ?? null,
        refClosure:  snap.refClosure  ? JSON.stringify(snap.refClosure) : null,
        renderedAt:  snap.renderedAt  ?? null,
        parent:      snap.parent      ?? null,
    }
}

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

export function createManifest(db) {
    if (!db) throw new Error('createManifest: db is required')

    const stmtLookup = db.prepare(`
        SELECT id, destination, inputHash, outputHash, refClosure, renderedAt, parent
        FROM mikser_snapshots WHERE id = ? AND destination = ?
    `)
    const stmtUpsert = db.prepare(`
        INSERT OR REPLACE INTO mikser_snapshots
            (id, destination, inputHash, outputHash, refClosure, renderedAt, parent)
        VALUES
            (@id, @destination, @inputHash, @outputHash, @refClosure, @renderedAt, @parent)
    `)
    const stmtDeleteByPK = db.prepare(`
        DELETE FROM mikser_snapshots WHERE id = ? AND destination = ?
    `)
    const stmtSelectByIdOrParent = db.prepare(`
        SELECT id, destination, parent FROM mikser_snapshots
        WHERE id = ? OR parent = ?
    `)
    const stmtDeleteByIdOrParent = db.prepare(`
        DELETE FROM mikser_snapshots WHERE id = ? OR parent = ?
    `)
    const stmtSelectByParent = db.prepare(`
        SELECT id, destination FROM mikser_snapshots WHERE parent = ?
    `)
    const stmtSelectAll = db.prepare(`
        SELECT id, destination, inputHash, outputHash, refClosure, renderedAt, parent
        FROM mikser_snapshots
    `)
    const stmtCount = db.prepare(`SELECT COUNT(*) AS c FROM mikser_snapshots`)
    const stmtRecordedHashes = db.prepare(`
        SELECT id, inputHash, refClosure FROM mikser_snapshots
    `)

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

        // Should this render be skipped? See the original docstring in
        // the prior NDJSON-backed implementation — logic is unchanged,
        // backing storage is the only thing that changed.
        shouldSkip(entity, mutatedRefs, currentHashes, mutatedEntities) {
            if (entity?.meta?.cache === false) return false
            const snapshot = this.lookup(entity)
            if (!snapshot?.inputHash) return false
            if (inputHashOf(entity) !== snapshot.inputHash) return false
            if (!snapshot.refClosure?.length) return true
            for (const entry of snapshot.refClosure) {
                if (entry.kind === 'query') {
                    if (!entry.filter) return false
                    if (!mutatedEntities?.size) continue
                    const matcher = sift(entry.filter)
                    for (const mutated of mutatedEntities.values()) {
                        if (matcher(mutated)) return false
                    }
                    continue
                }
                if (!mutatedRefs?.has(entry.target)) continue
                if (!entry.hash) return false
                const currentHash = currentHashes?.get(entry.target)
                if (currentHash === undefined) continue
                if (currentHash === null) return false
                if (currentHash !== entry.hash) return false
            }
            return true
        },

        // Record a successful render. Single INSERT OR REPLACE.
        record(entity, deps) {
            stmtUpsert.run(snapToRow(buildSnapshot(entity, deps)))
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
        // Walks the manifest once per cycle in onProcessed; bounded
        // cost.
        recordedHashes() {
            const map = new Map()
            for (const row of stmtRecordedHashes.iterate()) {
                if (row.inputHash && !map.has(row.id)) {
                    map.set(row.id, row.inputHash)
                }
                if (row.refClosure) {
                    let closure
                    try { closure = JSON.parse(row.refClosure) } catch { continue }
                    for (const dep of closure) {
                        if (dep.kind === 'query') continue
                        if (dep.target && dep.hash && !map.has(dep.target)) {
                            map.set(dep.target, dep.hash)
                        }
                    }
                }
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
        // a diff describing missing / mismatched / orphaned /
        // unverifiable. Backs `mikser --verify`. Pure: no mutations.
        async verify({ outputFolder } = {}) {
            outputFolder = outputFolder || runtime.options.outputFolder
            const missing = []
            const mismatched = []
            const unverifiable = []
            const claimed = new Set()
            for (const row of stmtSelectAll.iterate()) {
                const snap = rowToSnap(row)
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
            return stmtCount.get().c
        },

        // Internals exposed for onFinalize's batch operations. Not
        // part of the public surface — they go straight to the
        // prepared statements without rebuilding them.
        _stmtSelectByIdOrParent: stmtSelectByIdOrParent,
        _stmtDeleteByIdOrParent: stmtDeleteByIdOrParent,
        _stmtSelectByParent:     stmtSelectByParent,
        _stmtDeleteByPK:         stmtDeleteByPK,
        _stmtUpsert:             stmtUpsert,
    }
    return manifest
}

// Wire to the lifecycle. Loads at onLoaded so plugins observing it
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

    // ---- Phase 1: Drain journal into mutation lists ----
    const deletedIds = []          // entity ids to drop from manifest
    const renderedEntries = []     // RENDER entries to record
    const newDestinationsByParent = new Map()
    const lostPagination = new Set()

    for await (const { entity } of useJournal('Manifest cleanup', [OPERATION.DELETE])) {
        deletedIds.push(entity.id)
    }

    for await (const { output, entity, deps } of useJournal('Output', [OPERATION.RENDER])) {
        if (output?.success && !output.skipped) {
            renderedEntries.push({ entity, deps })
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

    // ---- Phase 2: Async file ops ----
    const m = sharedManifest

    // 2a. Stage file unlinks for deleted entities + their children.
    const filesToUnlink = []
    for (const id of deletedIds) {
        const rows = m._stmtSelectByIdOrParent.all(id, id)
        for (const row of rows) {
            filesToUnlink.push({ destination: row.destination, reason: 'Entity deleted' })
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

    // 2d. Unlink stale output files (async, parallel-friendly).
    for (const { destination, reason } of filesToUnlink) {
        const filePath = path.join(runtime.options.outputFolder, destination)
        try {
            await unlink(filePath)
            logger.debug('%s: unlinked %s', reason, destination)
        } catch { /* file already gone or never existed — fine */ }
    }

    // 2e. Hash the rendered output files (async).
    const recordedSnapshots = []
    for (const { entity, deps } of renderedEntries) {
        const outputHash = await hashOutputFile(entity.destination)
        recordedSnapshots.push(buildSnapshot(entity, deps, outputHash))
    }

    // ---- Phase 3: Single sync transaction for all DB mutations ----
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
        for (const snap of recordedSnapshots) {
            m._stmtUpsert.run(snapToRow(snap))
        }
    })
})
