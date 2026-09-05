// Every prepared statement the manifest runs, built once per database
// handle. Returned as one object so createManifest can destructure it and
// leave the method bodies reading exactly as they did.

import sift from 'sift'

export function prepareStatements(db) {
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
        SELECT id, destination, inputHash, inputParts, outputHash, refClosure, metaReads, consumedReads, renderedAt, parent
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
        SELECT id, destination, inputHash, inputParts, outputHash, refClosure, metaReads, consumedReads, renderedAt, parent
        FROM mikser_snapshots WHERE id = ? ORDER BY destination
    `)
    const stmtLookup = db.prepare(`
        SELECT id, destination, inputHash, inputParts, outputHash, refClosure, metaReads, consumedReads, renderedAt, parent
        FROM mikser_snapshots WHERE id = ? AND destination = ?
    `)
    const stmtUpsert = db.prepare(`
        INSERT OR REPLACE INTO mikser_snapshots
            (id, destination, inputHash, inputParts, outputHash, refClosure, metaReads, consumedReads, renderedAt, parent)
        VALUES
            (@id, @destination, @inputHash, @inputParts, @outputHash, @refClosure, @metaReads, @consumedReads, @renderedAt, @parent)
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
        SELECT id, destination, inputHash, inputParts, outputHash, refClosure, metaReads, consumedReads, renderedAt, parent
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

    // Everything that rendered through a layout — the blast radius of a change
    // to a layout SIDECAR.
    //
    // A sidecar is reachable by none of the three routes affectedBy otherwise
    // walks: it never renders, so it has no snapshots; nothing points at it by
    // ref; and no query matches it. Its dependency is the layout's input
    // digest, which is not an edge. So the preview answered "nothing would be
    // affected" for a change that re-renders the entire site — the one
    // direction of wrong that matters, since it says a site-wide edit is safe.
    //
    // The blast radius really is everything: the layouts plugin folds every
    // OTHER sidecar under the folder into each layout's `shared` digest, so any
    // sidecar edit moves every layout's checksum, and every page renders
    // through some layout.
    const stmtSnapshotsWithLayout = db.prepare(`
        SELECT id, destination, refClosure FROM mikser_snapshots
        WHERE refClosure LIKE '%"kind":"layout"%'
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

    return {
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
    }
}
