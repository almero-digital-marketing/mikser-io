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
import { extractRefs, inputHashOf, inputPartsOf, diffInputParts, lookupKeys } from './utils.js'
import { filterKey } from './track.js'
import { findById, findEntities } from './catalog.js'
import { useDatabase, registerSchema } from './database/index.js'

// Schema registration. Applied at db.open(). PRIMARY KEY (id,
// destination) — leading id column means `WHERE id = ?` queries use the
// PK index, no separate id index needed. Parent index is for pagination
// cleanup (drop all children of X). WITHOUT ROWID keeps the file
// smaller.
// Exported so tests build against the real schema rather than a copy. A
// copy drifts the moment a column is added, and the failure is a bare
// SQLITE_ERROR that names nothing.
export const SNAPSHOTS_SCHEMA = `
    CREATE TABLE IF NOT EXISTS mikser_snapshots (
        id          TEXT NOT NULL,
        destination TEXT NOT NULL,
        inputHash   TEXT,
        inputParts  TEXT,
        outputHash  TEXT,
        refClosure  TEXT,
        -- Meta keys this render actually READ, as dotted paths.
        --
        -- Kept out of refClosure deliberately: those are edges to other
        -- entities and drive invalidation, while these are property paths on
        -- the entity's own meta and drive nothing. They exist because static
        -- parsing structurally cannot see them: a sidecar reads meta in plain
        -- JavaScript, and no parser for any template engine will ever find
        -- an optional chain like row.meta?.hero?.tags.
        metaReads   TEXT,
        renderedAt  INTEGER,
        parent      TEXT,
        PRIMARY KEY (id, destination)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_mikser_snapshots_parent ON mikser_snapshots(parent) WHERE parent IS NOT NULL;
`
registerSchema('mikser_snapshots', SNAPSHOTS_SCHEMA)

// Failed render attempts, durably.
//
// A failed render writes no snapshot — deliberately, so the last good bytes
// survive — which leaves nothing anywhere saying the attempt happened. The
// consequences all follow from that one absence: the entity is gated at
// import next cycle (its own source did not change), so it is never
// re-dispatched; the manifest still describes the last good render, so
// --verify is clean; and --explain reports `[current]` and `would be
// SKIPPED` for a page whose render is throwing — the one tool whose job is
// "why is this not rebuilding", answering "because there is nothing to do".
//
// Keyed by (id, destination) like snapshots, but a SEPARATE table because a
// render that has never once succeeded has no snapshot to hang a column on.
//
// firstFailedAt is kept distinct from lastFailedAt so a report can say
// "since 14:02" — the difference between "this broke just now" and "this has
// been broken for an hour" is most of what a reader wants.
export const FAILURES_SCHEMA = `
    CREATE TABLE IF NOT EXISTS mikser_failures (
        id            TEXT NOT NULL,
        destination   TEXT NOT NULL,
        error         TEXT,
        context       TEXT,
        firstFailedAt INTEGER,
        lastFailedAt  INTEGER,
        attempts      INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (id, destination)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_mikser_failures_id ON mikser_failures(id);
`
registerSchema('mikser_failures', FAILURES_SCHEMA)

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
// Which input moved, as a flat list of part names ('content',
// 'meta.title', 'checksum', 'inputs.shared'). Empty when the snapshot
// predates part recording — the combined hash still says the entity
// changed, and saying nothing is better than guessing which part.
function describeInputChange(entity, snapshot) {
    if (!snapshot?.inputParts) return []
    const { changed, added, removed } = diffInputParts(snapshot.inputParts, inputPartsOf(entity))
    return [
        ...changed,
        ...added.map(key => `${key} (added)`),
        ...removed.map(key => `${key} (removed)`),
    ]
}

function buildRefClosure(entity, deps) {
    const closure = []
    const seen = new Set()
    // `targetId`/`targetIds` are the recorded BINDING — which entity the
    // ref resolved to — and they have to survive into the snapshot. A
    // projection that keeps only {kind, target, hash} leaves the binding
    // in mikser_refs and out of the snapshot, so skipDecision has nothing
    // but the name to compare: the scheduler finds the dependent and the
    // manifest then skips it.
    function pushTarget(kind, target, hash, targetId, targetIds) {
        if (!target) return
        const key = `${kind}:${target}`
        if (seen.has(key)) return
        seen.add(key)
        const entry = { kind, target }
        if (targetId) entry.targetId = targetId
        if (targetIds?.length) entry.targetIds = targetIds
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
            // Resolve through the refs index, which mirrors refFilter's
            // four forms. findById alone is an exact primary-key read, so
            // a $-ref written as a meta.href or a served meta.url path
            // (ADR-0011) resolves to nothing and the edge lands with no
            // hash and no binding — leaving the manifest unable to see
            // that the target changed.
            const ids = runtime.refs?.resolveRefIds?.(ref) ?? (findById(ref) ? [ref] : [])
            const bound = ids.length === 1 ? findById(ids[0]) : null
            pushTarget(
                'ref', ref,
                bound ? inputHashOf(bound) : undefined,
                ids.length === 1 ? ids[0] : undefined,
                ids.length > 1 ? ids : undefined,
            )
        }
    }
    if (Array.isArray(deps)) {
        for (const dep of deps) {
            if (dep.kind === 'query') pushQuery(dep.filter ?? null)
            else pushTarget(dep.kind, dep.target, dep.hash, dep.targetId, dep.targetIds)
        }
    }
    return closure
}

function buildSnapshot(entity, deps, outputHash, metaReads) {
    const snapshot = {
        id: entity.id,
        destination: entity.destination,
        inputHash: inputHashOf(entity),
        // Per-component hashes of the same payload the combined hash covers,
        // so a later run can name WHICH input moved instead of only that one
        // did. Without it `inputs-changed` sends the reader to a database
        // query for something the tool already has in hand.
        inputParts: inputPartsOf(entity),
        refClosure: buildRefClosure(entity, deps),
        renderedAt: Date.now(),
    }
    // Sorted and deduped: this is a SET of paths, and a stable order keeps a
    // snapshot comparable between runs.
    if (metaReads?.length) snapshot.metaReads = [...new Set(metaReads)].sort()
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
        inputParts:  row.inputParts ? JSON.parse(row.inputParts) : undefined,
        outputHash:  row.outputHash ?? undefined,
        refClosure:  row.refClosure ? JSON.parse(row.refClosure) : undefined,
        metaReads:   row.metaReads  ? JSON.parse(row.metaReads)  : undefined,
        renderedAt:  row.renderedAt ?? undefined,
        parent:      row.parent ?? undefined,
    }
}

function snapToRow(snap) {
    return {
        id:          snap.id,
        destination: snap.destination,
        inputHash:   snap.inputHash   ?? null,
        inputParts:  snap.inputParts  ? JSON.stringify(snap.inputParts) : null,
        outputHash:  snap.outputHash  ?? null,
        refClosure:  snap.refClosure  ? JSON.stringify(snap.refClosure) : null,
        metaReads:   snap.metaReads   ? JSON.stringify(snap.metaReads)  : null,
        renderedAt:  snap.renderedAt  ?? null,
        parent:      snap.parent      ?? null,
    }
}

// Where a `destination` actually is on disk.
//
// Two shapes are in circulation and both are legitimate. A page's is
// output-relative with a leading slash (`/bg/index.html`); an asset's is a
// real filesystem path, because assets.js builds it from
// `runtime.options.assetsFolder`, which resolves inside the WORKING folder
// and can sit outside outputFolder entirely.
//
// `path.isAbsolute` cannot separate them — on POSIX `/bg/index.html` is
// absolute too — so resolve by EXISTENCE, output-relative first since that
// is the dominant shape. A page destination treated as a filesystem path
// would otherwise be looked for at the root of the disk.
//
// One definition for both callers. verify() and hashOutputFile ask the same
// question, and a private copy of the join in each is how one mistake
// becomes two symptoms — one loud (every asset reported missing, at its
// real and present path) and one silent (no outputHash recorded, leaving
// most snapshots presence-checked only).
export function resolveOutputPath(destination, outputFolder = runtime.options?.outputFolder) {
    if (!destination) return undefined
    const joined = path.join(outputFolder ?? '', destination)
    if (existsSync(joined)) return joined
    if (path.isAbsolute(destination) && existsSync(destination)) return destination
    return joined
}

async function hashOutputFile(destination) {
    const filePath = resolveOutputPath(destination)
    if (!filePath) return undefined
    try {
        const buf = await readFile(filePath)
        return sha1(buf)
    } catch {
        return undefined
    }
}

// The source entities that fed a render, each with HOW it got there.
//
// The reverse of everything else here: snapshots answer "what did this entity
// produce", and this answers "what produced this". It belongs in the engine
// because the refClosure IS the engine's record of what a render consumed —
// which is what makes the answer authoritative rather than a guess. A bundle
// assembled from `findEntities({ collection: 'styles' })` records that query,
// and re-running it returns exactly the parts that went in.
//
// `via` is kept per source and accumulates, because one entity can reach a
// render by more than one route — a layout that is also a $-ref target, a
// document matched by two recorded queries — and collapsing that to the first
// route found would quietly answer a different question.
export async function sourcesBehind(snapshot) {
    const sources = new Map()
    const add = (id, via) => {
        if (!id) return
        if (!sources.has(id)) sources.set(id, { id, via: [] })
        if (!sources.get(id).via.includes(via)) sources.get(id).via.push(via)
    }
    if (!snapshot) return []
    add(snapshot.id, 'renders to this destination')
    for (const entry of snapshot.refClosure ?? []) {
        if (entry.kind === 'query') {
            // A null filter is the sentinel for a predicate that could not be
            // serialized. It names no members, so there is nothing to resolve
            // — and claiming the whole catalog fed this render would be worse
            // than saying nothing.
            if (!entry.filter) continue
            const label = `query ${JSON.stringify(entry.filter)}`
            try {
                for (const member of await findEntities(entry.filter)) add(member.id, label)
            } catch { /* a recorded filter that no longer parses tells us nothing */ }
            continue
        }
        for (const id of entry.targetIds ?? (entry.targetId ? [entry.targetId] : [])) {
            add(id, entry.kind)
        }
        // An edge that resolved to nothing still names what it asked for — a
        // forward reference to a page that does not exist yet is a real answer
        // to "what feeds this", and dropping it hides the reason a link breaks.
        if (!entry.targetId && !entry.targetIds?.length && entry.target) {
            add(entry.target, `${entry.kind} (unresolved)`)
        }
    }
    return [...sources.values()]
}

// Everything that fed a DESTINATION, across every entity claiming it.
//
// The shape a caller actually wants: they have a built file, not a snapshot.
// More than one claimant means a collision, and the union is reported rather
// than one arbitrary winner — see collisions().
export async function sourcesOf(destination) {
    const snapshots = runtime.manifest?.snapshotsAt?.(destination) ?? []
    const merged = new Map()
    for (const snapshot of snapshots) {
        for (const source of await sourcesBehind(snapshot)) {
            const existing = merged.get(source.id)
            if (!existing) { merged.set(source.id, { ...source, via: [...source.via] }); continue }
            for (const via of source.via) if (!existing.via.includes(via)) existing.via.push(via)
        }
    }
    return [...merged.values()]
}

export function createManifest(db) {
    if (!db) throw new Error('createManifest: db is required')

    const stmtCollisions = db.prepare(`
        SELECT destination, count(*) AS n, group_concat(id) AS ids
        FROM mikser_snapshots
        GROUP BY destination HAVING n > 1
    `)
    const stmtClaimants = db.prepare(`
        SELECT id, outputHash FROM mikser_snapshots WHERE destination = ?
    `)
    const stmtSelectByDestination = db.prepare(`
        SELECT id FROM mikser_snapshots WHERE destination = ?
    `)
    const stmtLookupByDestination = db.prepare(`
        SELECT id, destination, inputHash, inputParts, outputHash, refClosure, metaReads, renderedAt, parent
        FROM mikser_snapshots WHERE destination = ?
    `)
    const stmtDeleteByDestination = db.prepare(`
        DELETE FROM mikser_snapshots WHERE destination = ?
    `)

    const stmtRecordFailure = db.prepare(`
        INSERT INTO mikser_failures
            (id, destination, error, context, firstFailedAt, lastFailedAt, attempts)
        VALUES (@id, @destination, @error, @context, @at, @at, 1)
        ON CONFLICT(id, destination) DO UPDATE SET
            error = excluded.error,
            context = excluded.context,
            lastFailedAt = excluded.lastFailedAt,
            attempts = mikser_failures.attempts + 1
    `)
    const stmtClearFailure = db.prepare(`
        DELETE FROM mikser_failures WHERE id = ? AND destination = ?
    `)
    const stmtClearFailuresForId = db.prepare(`
        DELETE FROM mikser_failures WHERE id = ?
    `)
    const stmtFailuresFor = db.prepare(`
        SELECT id, destination, error, context, firstFailedAt, lastFailedAt, attempts
        FROM mikser_failures WHERE id = ?
    `)
    const stmtFailureAt = db.prepare(`
        SELECT id, destination, error, context, firstFailedAt, lastFailedAt, attempts
        FROM mikser_failures WHERE id = ? AND destination = ?
    `)
    const stmtAllFailures = db.prepare(`
        SELECT id, destination, error, context, firstFailedAt, lastFailedAt, attempts
        FROM mikser_failures
    `)

    const stmtLookupById = db.prepare(`
        SELECT id, destination, inputHash, inputParts, outputHash, refClosure, metaReads, renderedAt, parent
        FROM mikser_snapshots WHERE id = ? ORDER BY destination
    `)
    const stmtLookup = db.prepare(`
        SELECT id, destination, inputHash, inputParts, outputHash, refClosure, metaReads, renderedAt, parent
        FROM mikser_snapshots WHERE id = ? AND destination = ?
    `)
    const stmtUpsert = db.prepare(`
        INSERT OR REPLACE INTO mikser_snapshots
            (id, destination, inputHash, inputParts, outputHash, refClosure, metaReads, renderedAt, parent)
        VALUES
            (@id, @destination, @inputHash, @inputParts, @outputHash, @refClosure, @metaReads, @renderedAt, @parent)
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
        SELECT id, destination, inputHash, inputParts, outputHash, refClosure, metaReads, renderedAt, parent
        FROM mikser_snapshots
    `)
    const stmtCount = db.prepare(`SELECT COUNT(*) AS c FROM mikser_snapshots`)
    // Two narrow queries instead of one row-scan-and-JSON.parse loop.
    // The dep-hash query uses sqlite's `json_each` extension to flatten
    // each snapshot's refClosure array entirely in C — at 110k
    // snapshots the prior implementation parsed ~500MB of JSON in JS
    // every cycle to recover ~20 distinct (target, hash) pairs.
    const stmtEntityInputHashes = db.prepare(`
        SELECT id, MIN(inputHash) AS inputHash
        FROM mikser_snapshots
        WHERE inputHash IS NOT NULL
        GROUP BY id
    `)
    const stmtDepHashes = db.prepare(`
        SELECT
            json_extract(value, '$.target') AS target,
            MIN(json_extract(value, '$.hash')) AS hash
        FROM mikser_snapshots, json_each(mikser_snapshots.refClosure)
        WHERE mikser_snapshots.refClosure IS NOT NULL
          AND json_extract(value, '$.kind')   != 'query'
          AND json_extract(value, '$.target') IS NOT NULL
          AND json_extract(value, '$.hash')   IS NOT NULL
        GROUP BY json_extract(value, '$.target')
    `)
    // Snapshots whose refClosure contains at least one query dep. The
    // LIKE pre-filter is cheap (JSON column scan with no parse) and
    // narrows down to the small set of aggregate-layout renders.
    // queryAffected then JSON.parses just those rows and sift-matches
    // each query filter against each mutated entity.
    const stmtSnapshotsWithQuery = db.prepare(`
        SELECT id, refClosure FROM mikser_snapshots
        WHERE refClosure LIKE '%"kind":"query"%'
    `)

    // Snapshots holding a non-query edge that names any of the given keys,
    // by the name asked for OR by the entity it bound to. Both, for the same
    // reason skipDecision reads both — a name survives a rename only through
    // the binding, and a forward edge to a page that does not exist yet has
    // only the name.
    //
    // A prefilter, not the answer: it narrows a corpus-wide walk to the
    // handful of snapshots that could possibly care, and the real
    // skipDecision then judges each one.
    const edgeCandidates = (keys) => {
        if (!keys.length) return []
        const holes = keys.map(() => '?').join(',')
        return db.prepare(`
            SELECT DISTINCT s.id AS id, s.destination AS destination
            FROM mikser_snapshots s, json_each(s.refClosure) j
            WHERE s.refClosure IS NOT NULL
              AND json_extract(j.value, '$.kind') != 'query'
              AND (json_extract(j.value, '$.target')   IN (${holes})
                OR json_extract(j.value, '$.targetId') IN (${holes}))
        `).all(...keys, ...keys)
    }

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
            if (runtime.options?.force) return { skip: false, reason: 'force' }
            if (entity?.meta?.cache === false) return { skip: false, reason: 'cache-disabled' }
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
        record(entity, deps, metaReads) {
            stmtUpsert.run(snapToRow(buildSnapshot(entity, deps, undefined, metaReads)))
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
        recordedHashes() {
            const map = new Map()
            for (const row of stmtEntityInputHashes.iterate()) {
                map.set(row.id, row.inputHash)
            }
            for (const row of stmtDepHashes.iterate()) {
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
                const filePath = resolveOutputPath(snap.destination, outputFolder)
                // Orphan detection compares against a globby walk of
                // outputFolder, so `claimed` has to hold exactly the relative
                // form that walk produces. A destination resolving outside
                // outputFolder can never appear in it and is not claimable;
                // one inside it must be claimed by its relative path, not by
                // the raw string with its leading slashes stripped.
                const relative = path.relative(outputFolder, filePath)
                if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
                    claimed.add(relative)
                }
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
            renderedEntries.push({ entity, deps, metaReads: output.metaReads })
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
    // re-rendered it, and --verify reported it missing.
    //
    // That made "resolve the collision by deleting the stub" delete the
    // homepage, which is the opposite of what the operator asked for and the
    // exact operation the new collision reporting invites.
    for (const { destination, reason } of filesToUnlink) {
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
    for (const { entity, deps, metaReads } of renderedEntries) {
        if (deleted.has(entity.id) || (entity.parent && deleted.has(entity.parent))) continue
        const outputHash = await hashOutputFile(entity.destination)
        recordedSnapshots.push(buildSnapshot(entity, deps, outputHash, metaReads))
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
        for (const snap of recordedSnapshots) {
            m._stmtUpsert.run(snapToRow(snap))
        }
    })
})
