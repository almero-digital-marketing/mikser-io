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
import { isReportOnlyRun } from './tools.js'

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

// How many finished cycles to keep. Small on purpose: this is "what did my
// last few edits do", not an audit log, and each entry holds one record per
// entity rendered in that cycle.
const HISTORY_LIMIT = 10

function history() {
    runtime.state ??= {}
    runtime.state.reportHistory ??= []
    return runtime.state.reportHistory
}

// The id the NEXT cycle will carry.
//
// A caller that writes a file needs to name the cycle its write will be
// picked up by BEFORE that cycle exists — otherwise "did my edit land" is
// unanswerable except by watching the clock. Writes go through the
// watcher's debounce, so the cycle after the current one is the answer.
export function nextCycleId() {
    return (runtime.state?.cycle?.id ?? 0) + 1
}

export function currentCycle() {
    return runtime.state?.cycle ?? null
}

// Finished cycles, newest first. `n` of them.
export function cycleHistory(n = 1) {
    return history().slice(-Math.max(1, n)).reverse()
}

// Resolves when a cycle with at least this id has finished. Used by a
// caller that wants its write and the resulting report in one round trip
// instead of polling.
export function whenCycleCompletes(id) {
    const done = history().find(c => c.id >= id)
    if (done) return Promise.resolve(done)
    // Nothing will ever complete in a report-and-exit run, and an unsettleable
    // promise here does not hang — it is worse. Node drains the event loop and
    // exits 0 having printed nothing, so a caller sees success and no result
    // and cannot tell whether the work happened.
    if (isReportOnlyRun()) {
        return Promise.reject(new Error(
            'No build runs in a --tool/--explain/--verify invocation, so there is no cycle to wait '
            + 'for. The write itself has landed. Run `mikser` to build it, or use --server with the '
            + 'MCP endpoint, where a watch cycle exists to await.'))
    }
    runtime.state.cycleWaiters ??= []
    return new Promise(resolve => runtime.state.cycleWaiters.push({ id, resolve }))
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
//
// Reset and IDENTITY are the same event — a report that describes "the last
// cycle" is only meaningful if something names which cycle that was, and a
// caller waiting on its own write needs to compare against something.
export function resetReport() {
    if (!runtime.state) return
    const previous = runtime.state.cycle
    if (previous && !previous.finishedAt) finishCycle()
    runtime.state.cycle = { id: nextCycleId(), startedAt: Date.now(), finishedAt: null }
    runtime.state.report = { rendered: [], skipped: [], unchanged: [], errors: [], warnings: [], gated: 0 }
    runtime.state.renderErrors = []
}

// End of a cycle: stamp it, file it, and wake anyone waiting on it.
export function finishCycle() {
    if (!runtime.state?.cycle || runtime.state.cycle.finishedAt) return
    runtime.state.cycle.finishedAt = Date.now()
    const record = { ...runtime.state.cycle, ...buildReport() }
    const kept = history()
    kept.push(record)
    while (kept.length > HISTORY_LIMIT) kept.shift()

    const waiters = runtime.state.cycleWaiters ?? []
    runtime.state.cycleWaiters = waiters.filter(w => {
        if (record.id < w.id) return true
        w.resolve(record)
        return false
    })
}

function store() {
    // The first cycle never passes through resetReport — that fires on the
    // watcher's trigger, and a cold build has no earlier cycle to reset from.
    // Without this the build everyone looks at first reports cycleId: null.
    runtime.state ??= {}
    runtime.state.cycle ??= { id: 1, startedAt: Date.now(), finishedAt: null }
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

// Fed by the log stream, not called directly. `warnings` is a VIEW of what
// went through logger.warn — there is no second way to raise one, because a
// second way is a second thing to forget: every warning the engine, a plugin,
// or a template emits is a warn-level log record, and this is where those get
// kept for the report.
//
// So the contract is the log call: `logger.warn({ code, ...fields }, msg)`.
// `code` is what anyone asserting on the report matches on, and renaming one
// is a breaking change. captureFault below is the same contract at error
// level, where the code is required rather than conventional.
//
// Still gated on the report being wanted: in a long watch session nobody asked
// to report on, this would otherwise grow without bound.
export function captureWarning(record) {
    if (!reportWanted()) return
    const { level, time, pid, hostname, msg, ...fields } = record
    store().warnings.push({ ...fields, ...(msg ? { message: msg } : {}) })
}

// The same view, one level up. An error carrying a `code` is a FAULT: a named
// condition a subsystem reported about ITSELF, as distinct from `errors`,
// which is one render that ran and threw.
//
// The contract is again the log call — `logger.error({ code, ...fields }, msg)`
// — so there is no second way to raise one, exactly as there is no second way
// to raise a warning. What differs is that the code is REQUIRED rather than
// merely conventional: uncoded error records are events about one thing
// (`Render error: doc-1`), already carried in `errors` with the entity
// attached, and a build failing forty renders must not report forty faults.
// The code is the fault's identity, and identity is what makes forty
// occurrences one condition with a count.
//
// Deliberately NOT gated on reportWanted(), and never cleared per cycle:
//
//   A subsystem that cannot do its job goes on not doing it after the cycle
//   that noticed ends. And the reader who most needs to know is not the
//   operator watching the terminal — they saw the log line — but an agent
//   connecting an hour later, for which the log is a channel it never reads.
//   A search returning [] because it is broken and one returning [] because
//   nothing matched are otherwise the same answer.
//
// Bounded by the number of distinct codes, which is why deduping is not
// optional here the way it would be for a per-cycle list.
export function captureFault(record) {
    const { level, time, pid, hostname, msg, code, ...fields } = record
    const at = time ?? Date.now()
    const seen = faultStore().get(code)
    if (seen) {
        // The first occurrence keeps its fields. A later one is the same
        // condition reported again, not new information about it.
        seen.count++
        seen.last = at
        return
    }
    faultStore().set(code, {
        code,
        ...fields,
        ...(msg ? { message: msg } : {}),
        count: 1,
        first: at,
        last: at,
    })
}

function faultStore() {
    runtime.state ??= {}
    runtime.state.faults ??= new Map()
    return runtime.state.faults
}

// Every fault raised since the process started, most recently seen first.
//
// `last` is what tells a reader whether it is still happening: a fault whose
// only occurrence was at boot and one still firing every cycle are different
// facts, and presence alone expresses neither.
export function faults() {
    return [...faultStore().values()].sort((a, b) => b.last - a.last)
}

// For tests. Nothing in a running engine decides on a subsystem's behalf that
// it has recovered — the condition that raised a fault is fixed by an
// operator, and the restart that follows is what clears it.
export function resetFaults() {
    faultStore().clear()
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
    const cycle = runtime.state?.cycle
    return {
        // Which cycle this describes. Without it, two reports read the same
        // and "is this my edit's cycle or the one before it" has no answer.
        cycleId: cycle?.id ?? null,
        startedAt: cycle?.startedAt ?? null,
        finishedAt: cycle?.finishedAt ?? null,
        rendered: report.rendered,
        skipped: report.skipped,
        unchanged: report.unchanged,
        // Renders that ran and threw. A build with a non-empty `errors` is a
        // failed build, whatever the other counts say.
        errors: errorStore(),
        warnings: report.warnings,
        // Named conditions reported at error level: a subsystem saying it
        // cannot work, as opposed to `errors`, which is a render that threw.
        // Carried whole rather than filtered to this cycle — a fault raised at
        // boot is still true during this build, and `last` says when it was
        // last seen.
        faults: faults(),
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
            faults: faults().length,
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
