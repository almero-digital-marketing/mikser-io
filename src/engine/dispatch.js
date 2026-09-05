// Where the report-and-exit commands are dispatched from, and the reason it
// is two hooks rather than one — see the comments below.

import runtime from '../runtime.js'
import { completeCliParse } from '../cli.js'
import { onImport, onLoaded } from '../lifecycle.js'
import { useLogger } from '../use-logger.js'
import { runReportOnly } from './report-only.js'

export function registerReportDispatch() {

    onImport(async () => {
        const logger = useLogger()
        // --tools / --tool: the CLI half of the tool surface.
        //
        // There are two agent workflows against mikser — one speaking MCP over
        // HTTP, one running the CLI and reading its output — and every tool
        // built for the first was invisible to the second. Rather than growing
        // a flag per tool, which drifts the moment a tool is added, this
        // dispatches through the same registry a session uses. A tool
        // registered by any plugin is reachable from both surfaces the moment
        // it exists.
        //
        // Dispatched at `import` rather than `loaded`, and the difference is
        // load-bearing: the engine's own onLoaded is registered during setup(),
        // ahead of every plugin's — including the ones that register the tools.
        // Listing from there returned exactly one, the tool the mcp substrate
        // creates for itself. By `import` every onLoaded has run and the
        // registry is complete. Nothing is imported, because this exits first,
        // the same way --explain and --audit-output do.
        //
        // --audit-output is here for the same reason, found the same way. It
        // asks which trees hold outputs, and a plugin cannot answer until its
        // own onLoaded has run — the assets plugin resolves the folder its
        // derivatives live in there, because `--assets` is a plugin option
        // and stage two of the parse is what makes it readable. Dispatched
        // from the engine's onLoaded it ran ahead of all of them, so the one
        // check that reports unclaimed files could not see the one tree whose
        // files reach the site through a symlink it does not follow. It
        // reported `0 orphaned` over any amount of debris.
        if (runtime.options.tools || runtime.options.tool || runtime.options.auditOutput) {
            const code = await runReportOnly()
            if (code !== null) process.exit(code)
        }
    })

    onLoaded(async () => {
        // Stage two of the parse, before anything reads an option.
        //
        // Every plugin has been constructed by now and has had its chance to
        // declare, so the table is complete and argv is parsed against all of
        // it. This engine hook is registered when the module is imported, so
        // it runs ahead of every plugin's own onLoaded — which is what makes
        // it safe for a plugin to read its own option there.
        completeCliParse()

        const logger = useLogger()
        logger.debug(runtime.options, 'Mikser options')

        // --audit-output is a standalone read-only mode. Manifest has already
        // loaded in its own onLoaded (registered earlier at module
        // import). We diff disk against snapshots, print the report,
        // and exit. No build phases run.
        //
        // Exit codes match common CI conventions:
        //   0 — clean (output matches manifest exactly)
        //   1 — warnings (orphan files or unverifiable entries — no
        //                 corruption, but state is messy)
        //   2 — errors   (missing or mismatched files — output is
        //                 actually wrong on disk)
        // --explain: report on one entity and exit, like --audit-output. Placed
        // before it because a caller reaching for both means the explain.
        //
        // Exit codes:
        //   0 — the entity was found and described
        //   3 — not in the catalog (distinct from --audit-output's 1/2, which are
        //       about output drift; "no such entity" is neither clean nor
        //       corrupt, it is a question that could not be answered)
        // The same three commands the instance answers over the socket —
        // one implementation, so a forwarded --audit-output cannot disagree with a
        // local one about what it checked.
        //
        // --tools, --tool and --audit-output are NOT among them: they are
        // dispatched at `import` instead, because what they read is not
        // complete until every plugin's onLoaded has run and this hook runs
        // ahead of all of them — the tool registry for the first two, the set
        // of trees that hold outputs for the third.
        // The import dispatch existed already and was documented as
        // load-bearing, but this call reached the same code first and exited,
        // so it never ran — and every tool a plugin registers was missing from
        // the CLI while the listing looked healthy, just short.
        if (!runtime.options.tools && !runtime.options.tool && !runtime.options.auditOutput) {
            const code = await runReportOnly()
            if (code !== null) process.exit(code)
        }
    })
}
