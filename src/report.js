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

function store() {
    runtime.state ??= {}
    runtime.state.report ??= { rendered: [], skipped: [], unchanged: [], warnings: [], gated: 0 }
    return runtime.state.report
}

// An entity whose SOURCE did not change is gated at import and never becomes
// a render task at all — so it appears in neither `rendered` nor `skipped`,
// and the two lists would not reconcile with the corpus size without saying
// so. Counted rather than listed: on a 14k-entity site the list would be
// almost the whole catalog on almost every build, which is noise in a
// document meant to answer "did my change land".
export function reportGated(count = 1) {
    if (!runtime.options?.json) return
    store().gated += count
}

export function reportRendered(entity, reason) {
    if (!runtime.options?.json) return
    store().rendered.push({ id: entity?.id, destination: entity?.destination ?? null, reason })
}

// A render that RAN and produced bytes identical to what was already on
// disk. Distinct from both other outcomes, and the interesting one of the
// three: `rendered` means the output moved, `skipped` means the manifest
// declined to look, and this means invalidation was coarser than it needed
// to be. Nothing downstream is disturbed, and the count measures what
// conservative invalidation costs.
export function reportUnchanged(entity) {
    if (!runtime.options?.json) return
    store().unchanged.push({ id: entity?.id, destination: entity?.destination ?? null })
}

export function reportSkipped(entity, reason) {
    if (!runtime.options?.json) return
    store().skipped.push({ id: entity?.id, destination: entity?.destination ?? null, reason })
}

// Called ALONGSIDE logger.warn, not instead of it: a human reading the
// terminal still needs the sentence, and the sentence is where the
// explanation lives. This carries the assertable part.
//
// `code` is the contract. Add fields freely; renaming a code is a breaking
// change to anyone asserting on it.
export function reportWarning(code, fields = {}) {
    if (!runtime.options?.json) return
    store().warnings.push({ code, ...fields })
}

export function buildReport() {
    const report = store()
    return {
        rendered: report.rendered,
        skipped: report.skipped,
        unchanged: report.unchanged,
        warnings: report.warnings,
        summary: {
            rendered: report.rendered.length,
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
    if (!runtime.options?.json) return
    process.stdout.write(JSON.stringify(buildReport(), null, 2) + '\n')
}
