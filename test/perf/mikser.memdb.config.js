// DOES NOT RUN TODAY. Kept for the record; see below before reaching for it.
//
// Same as test/perf/mikser.config.js but the engine database is
// in-memory. Apples-to-apples comparison vs the pre-Phase-7 Map+NDJSON
// numbers — both keep state in memory across the cycle, neither pays
// disk-write cost.
//
// Why it cannot work: every render calls ensureWorkerDb (src/render.js),
// which opens `<runtimeFolder>/mikser.sqlite` with `fileMustExist: true` so
// that template helpers like lookupHref stay synchronous. With
// `filename: ':memory:'` there is no such file and all 10k renders fail with
// `unable to open database file`. Making the open optional would be worse
// than this file being broken: the helpers would resolve nothing, and the run
// would quietly measure a different pipeline than the one it claims to.
//
// It is also answering a settled question. The Map+NDJSON comparison it
// exists for is recorded in ADR-0009 and in CLAUDE.md's Perf section, against
// a named baseline commit (6922b33). Nothing references this file.
//
// So: either delete it, or give the in-memory case a real path through the
// render helpers. Do not "fix" it by loosening ensureWorkerDb.
//
// Kept in step with its sibling deliberately: the whole value of this file is
// that the ONLY difference from mikser.config.js is the database, so any
// change to the plugin list belongs in both.

import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'

export default async () => ({
    plugins: [
        documents({ documentsFolder: 'documents' }),
        frontMatter(),
        yaml(),
        layouts({ autoLayouts: true }),
        renderHbs(),
    ],
    database: {
        filename: ':memory:',
    },
})
