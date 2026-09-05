// The two tables this module owns, and what each column is for.

import runtime from '../runtime.js'
import { registerSchema, useDatabase } from '../database/index.js'
import { onFinalize } from '../lifecycle.js'

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
        -- Keys of OTHER entities this render read, keyed by the entity they
        -- belong to. The counterpart to metaReads, and the only record of what
        -- a document that never renders is actually needed FOR: the engine knew
        -- that a page queried it, never which of its fields mattered.
        consumedReads TEXT,
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
// --audit-output is clean; and --explain reports `[current]` and `would be
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
