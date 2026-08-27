// The machine-readable build report behind `--json`.
//
// `Rendered: 16` is a number nobody can assert on. Verifying "did my change
// land" without this means diffing the output folder against a snapshot taken
// beforehand — a lot of ceremony for one question.
//
// The valuable field is `reason`, not the counts. And a stable `code` on a
// warning matters more than its prose: it lets a caller assert "this build
// produced no preset-no-match" instead of grepping a sentence that may be
// reworded — which is exactly the kind of assertion that should not break
// when someone improves the wording.
import runtime from './runtime.js'

// A transport that can serve the build report declares itself here, at
// factory time, before any cycle runs.
//
// Recording was gated on --json alone, which is why the report existed only
// for a one-shot build someone piped to jq. An in-process reader is exactly
// as much of a consumer, and a watch server is where "what did the last
// cycle do, and why" is most worth asking.
//
// An opt-in call rather than report.js testing for known plugins: the list
// of things that can read a report is not report.js's to keep, and a third
// transport should not need an edit here to work.
export function requestReport() {
    runtime.options ??= {}
    runtime.options.reportRequested = true
}

// Is anything able to read the report?
//
// Not recorded unconditionally: the rendered/skipped/unchanged arrays are
// one entry per entity per cycle, which `gated` is already a bare count to
// avoid. Recording when there IS a reader keeps the default lean without
// making the data conditional on how you happen to have started mikser.
function reportWanted() {
    return !!(runtime.options?.json || runtime.options?.reportRequested)
}

// Cleared at the start of every cycle, so the report always describes the
// LAST one rather than everything since the process started.
//
// It did not need this while --json meant a single build that then exited.
// Under watch, without it, rendered/skipped grow without bound and the
// answer to "what did the last rebuild do" becomes "here is everything,
// find the end yourself".
//
// The failure store is deliberately NOT cleared here: a failure persists
// across cycles by design — it is the retry marker's in-memory twin, and
// the exit code depends on this cycle's count, which resetRenderErrors
// handles at the same point.
export function resetReport() {
    if (!runtime.state) return
    runtime.state.report = { rendered: [], skipped: [], unchanged: [], errors: [], warnings: [], gated: 0 }
    runtime.state.renderErrors = []
}

function store() {
    runtime.state ??= {}
    runtime.state.report ??= { rendered: [], skipped: [], unchanged: [], errors: [], warnings: [], gated: 0 }
    return runtime.state.report
}

// An entity whose SOURCE did not change is gated at import and never becomes
// a render task at all — so it appears in neither `rendered` nor `skipped`,
// and the two lists would not reconcile with the corpus size without saying
// so. Counted rather than listed: on a 14k-entity site the list would be
// almost the whole catalog on almost every build, which is noise in a
// document meant to answer "did my change land".
export function reportGated(count = 1) {
    if (!reportWanted()) return
    store().gated += count
}

// `decision` is the skipDecision that led here. Its detail travels with the
// reason, because a reason on its own answers a question nobody asked: WHICH
// input moved, WHICH query matched and what tripped it, WHICH dependency
// changed and how. All of it is in hand where the decision is made, and a
// consumer that has to go to the database for it is one the report failed.
//
// Detail keys are per-reason rather than one generic field — `changed`,
// `matched`, `dependency` each mean something specific, and a single
// polymorphic key would push the type switch onto every consumer.
export function reportRendered(entity, reason, decision = {}) {
    if (!reportWanted()) return
    store().rendered.push({
        id: entity?.id,
        destination: entity?.destination ?? null,
        reason,
        // Omitted rather than empty, so presence is meaningful.
        ...(decision.changed?.length ? { changed: decision.changed } : {}),
        ...(decision.matched ? { matched: decision.matched } : {}),
        ...(decision.dependency ? { dependency: decision.dependency } : {}),
    })
}

// A render that RAN and produced bytes identical to what was already on
// disk. Distinct from both other outcomes, and the interesting one of the
// three: `rendered` means the output moved, `skipped` means the manifest
// declined to look, and this means invalidation was coarser than it needed
// to be. Nothing downstream is disturbed, and the count measures what
// conservative invalidation costs.
export function reportUnchanged(entity) {
    if (!reportWanted()) return
    store().unchanged.push({ id: entity?.id, destination: entity?.destination ?? null })
}

export function reportSkipped(entity, reason) {
    if (!reportWanted()) return
    store().skipped.push({ id: entity?.id, destination: entity?.destination ?? null, reason })
}

// Called ALONGSIDE logger.warn, not instead of it: a human reading the
// terminal still needs the sentence, and the sentence is where the
// explanation lives. This carries the assertable part.
//
// `code` is the contract. Add fields freely; renaming a code is a breaking
// change to anyone asserting on it.
export function reportWarning(code, fields = {}) {
    if (!reportWanted()) return
    store().warnings.push({ code, ...fields })
}

// A render that RAN and THREW. Recorded unconditionally — not gated on
// --json like the other buckets — because the exit code depends on the
// count, and a build that fails 12 renders must not exit 0 just because
// nobody asked for a report.
//
// Failed entities do NOT appear in `rendered`. That bucket means the output
// moved, and a throw writes nothing: the previous good bytes stay on disk,
// which is what makes the failure survivable and also what makes it
// invisible. `rendered: 12` beside zero written files is the misleading
// half, and summing buckets should not require knowing that.
export function reportError(entity, err, context = {}) {
    const store = errorStore()
    store.push({
        id: entity?.id ?? null,
        destination: entity?.destination ?? null,
        error: err?.message ?? String(err),
        ...context,
    })
}

// Errors are counted even without --json, so they need a store that does
// not depend on the report being requested.
function errorStore() {
    runtime.state ??= {}
    runtime.state.renderErrors ??= []
    return runtime.state.renderErrors
}

// How many renders threw this cycle. Read by the engine to decide the
// process exit code.
export function renderErrorCount() {
    return errorStore().length
}

export function buildReport() {
    const report = store()
    return {
        rendered: report.rendered,
        skipped: report.skipped,
        unchanged: report.unchanged,
        // Renders that ran and threw. A build with a non-empty `errors` is a
        // failed build, whatever the other counts say.
        errors: errorStore(),
        warnings: report.warnings,
        summary: {
            rendered: report.rendered.length,
            errors: errorStore().length,
            // Of those renders, how many produced bytes identical to
            // what was already on disk — see reportUnchanged.
            unchanged: report.unchanged.length,
            // Renders that were CONSIDERED and skipped by the manifest.
            skipped: report.skipped.length,
            // Entities gated at import because their source was unchanged, so
            // no render was ever scheduled. Different question, different
            // number — see reportGated.
            gated: report.gated,
            warnings: report.warnings.length,
        },
    }
}

// Emitted once, after the cycle, on stdout — which the logger has vacated
// under --json precisely so this can be the only thing there.
export function emitReport() {
    // --json only, deliberately. Recording and PRINTING are different
    // questions: a server with the mcp plugin records so a tool can read it,
    // and must not write a document to stdout.
    if (!runtime.options?.json) return
    process.stdout.write(JSON.stringify(buildReport(), null, 2) + '\n')
}
