// Should this work be redone?
//
// One question, asked at four layers with different evidence in hand:
//
//   source.js      a file's checksum against the catalog's
//   manifest       a recorded hash, for the layouts dispatcher's seeding
//   manifest       a snapshot plus its refClosure, at the render gate
//   assets         a `.md5` marker at the current preset revision
//
// The evidence differs and belongs to each layer. What does NOT differ is
// what OVERRIDES the evidence — and that is what this module owns, because
// it was written four times and drifted the moment a fifth override was
// added to one of them.
//
// The drift, concretely: `rm -rf out` changes no input, so every layer
// answered "unchanged" and a build rendered nothing, printed no `Rendered:`
// line and exited 0 over an empty output folder. Adding an output-existence
// check to the render gate fixed nothing, because the source gate had
// already dropped the entity; adding it there fixed the site but not image
// derivatives, because files.js held a private copy of that gate; and fixing
// that still left the assets marker, which had never asked about the file at
// all. Five gates, one question, four implementations of the override rules.
//
// So the rule is: a layer may own what it KNOWS. It may not own what
// overrides it. Anything that makes a gate not apply — --force, a wiped
// cache, a reload event, an output that is gone — is declared here once, and
// a new one added here reaches every gate that ever asks.
//
// Deliberately NOT moved here: the dependency-graph walk in
// manifest.skipDecision. That reasons over snapshots, refClosures and sift
// filters the manifest owns, and hauling it out would trade a real coupling
// for a fake one. It asks this module what overrides its answer, which is the
// part that was duplicated.
//
// A leaf module: runtime and node builtins only. It reads `runtime.manifest`
// lazily rather than importing it, the way every other consumer of engine
// state does, so the manifest can import this without a cycle.

import path from 'node:path'
import { existsSync } from 'node:fs'
import runtime from './runtime.js'

// The vocabulary, in one place because it is asserted against.
//
// `--json` carries these strings out to callers and the scenario suite
// matches on them, so they are API. Defined here rather than in the gate
// that happens to emit each one, so the set can be read as a set.
export const REASON = Object.freeze({
    // Overrides — this module's business.
    FORCE: 'force',
    CACHE_INVALIDATED: 'cache-invalidated',
    RELOAD: 'reload',
    OUTPUT_MISSING: 'output-missing',
    // Evidence — each layer's business, named here so the vocabulary is
    // legible as a whole.
    UNCHANGED: 'unchanged',
    NEVER_RENDERED: 'never-rendered',
    INPUTS_CHANGED: 'inputs-changed',
    REF_CHANGED: 'ref-changed',
    QUERY_MATCHED: 'query-matched',
    CACHE_DISABLED: 'cache-disabled',
    RETRY_FAILED: 'retry-failed',
})

// Where an output lives, given what a snapshot recorded.
//
// Destinations come in two shapes and both are legitimate: output-relative
// for a rendered page (`/index.html`), absolute for a derivative the assets
// plugin places itself. Resolving relative-first and falling back to the
// literal path covers both without the caller having to know which it holds.
//
// Returns the joined path even when nothing exists there, so a caller can
// report WHICH path it looked for — "missing" without a path is a fact
// nobody can act on.
export function resolveOutputPath(destination, outputFolder = runtime.options?.outputFolder) {
    if (!destination) return undefined
    const joined = path.join(outputFolder ?? '', destination)
    if (existsSync(joined)) return joined
    if (path.isAbsolute(destination) && existsSync(destination)) return destination
    return joined
}

// Is the file this destination names gone?
export function outputMissing(destination) {
    if (!destination) return false
    return !existsSync(resolveOutputPath(destination))
}

// Memoized for the cycle.
//
// Every gate asks, and they all ask before anything has rendered, so one walk
// answers all of them. Dropped at the end of onFinalize, where this cycle's
// renders are recorded and the answer stops being true — not at the start of
// the next cycle, because in watch mode there may not be one for hours and a
// stale set held that long would re-dispatch entities it saw as missing.
let cachedMissingOutputs = null

// The entity ids whose last render wrote a file that is no longer on disk.
//
// One stat per recorded snapshot. The syscalls are ~2.2ms per 1842 paths and
// cost the same whether the files are there or not; at the build level it does
// not register — warm rebuilds of the 10k perf corpus ran 3.36s median with
// this against 3.56s without, i.e. nominally faster, which is only to say the
// difference is inside the run-to-run spread. Re-measure with
// `npm run test:perf` before trusting a claim that it got slower.
export function missingOutputIds() {
    if (cachedMissingOutputs) return cachedMissingOutputs
    const missing = new Set()
    for (const snapshot of runtime.manifest?.all?.() ?? []) {
        if (!snapshot.destination) continue
        if (outputMissing(snapshot.destination)) missing.add(snapshot.id)
    }
    cachedMissingOutputs = missing
    return missing
}

export function forgetMissingOutputs() {
    cachedMissingOutputs = null
}

// What overrides a gate's own evidence, or null when nothing does.
//
// Callers pass the evidence they hold: `reload` if they are a watch event,
// `id` if they are gating an entity whose outputs are recorded. Passing
// neither asks only the universal question, which is what the render gate
// wants — it checks the output separately and later, so that an entity whose
// inputs ALSO moved reports `inputs-changed` rather than losing that detail
// to a broader answer.
export function bypassReason({ reload = false, id } = {}) {
    if (reload) return REASON.RELOAD
    if (runtime.options?.force) return REASON.FORCE
    if (runtime.catalog?.cacheInvalidated) return REASON.CACHE_INVALIDATED
    if (id !== undefined && missingOutputIds().has(id)) return REASON.OUTPUT_MISSING
    return null
}

// Is every entity being presented for evaluation this cycle?
//
// The same fact as bypassReason, asked for a different purpose: a "declared X
// matched nothing" warning is only worth printing when everything was looked
// at. On an incremental cycle a pattern legitimately matches nothing in a run
// of two, and a warning that always fires is one people filter out — taking
// the real instance with it.
//
// `firstRun` counts here and not in bypassReason because there is nothing to
// bypass on a first run: no prior checksum, no snapshot, so every gate opens
// on its own evidence.
//
// Takes the runtime rather than reading the singleton, so a plugin passes the
// one it was injected with — the singleton in a real build, the harness's
// stand-in under test.
export function isFullCycle(engineRuntime = runtime) {
    return !!(
        engineRuntime?.options?.force
        || engineRuntime?.options?.firstRun
        || engineRuntime?.catalog?.cacheInvalidated
    )
}
