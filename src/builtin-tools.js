// The engine's own diagnostics, registered as tools.
//
// `explain()`, `manifest.verify()` and `buildReport()` are engine functions,
// but the tools wrapping them were registered by the mcp plugin — so
// `--tool mikser_explain` needed an agent surface configured while `--explain`
// did not. That is backwards for the engine's own diagnostics, and it is why
// `--verify` and `--explain` could not simply become `--tool` invocations.
//
// Registering them here fixes the direction: they exist on a bare engine, the
// CLI flags become renderings of them rather than parallel implementations,
// and the mcp plugin exposes them over a session without owning them.
//
// Schemas are declared in a neutral vocabulary rather than zod, because the
// engine does not depend on zod and should not: the registry is transport
// agnostic. `mikser-io-mcp` converts these to zod at bind time. The vocabulary
// is deliberately small — a name, a type, whether it is required, a
// description — since anything richer would be a schema language, and the
// engine has no business owning one.

import runtime from './runtime.js'
import { registerTool } from './tools.js'
import { buildReport, cycleHistory } from './report.js'

// The MCP content envelope, so a CLI caller and a session caller see the same
// bytes. Built here rather than imported from the plugin, because the plugin
// is the thing that must not be required.
const ok = (data) => ({
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
})
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] })

export function registerBuiltinTools() {
    registerTool(
        'mikser_explain',
        {
            description:
                'Explain ONE entity: which layout claimed it and why, its destination, which inputs moved since it '
                + 'last rendered, every dependency edge with what it resolved to, whether its last render attempt '
                + 'threw, and a verdict on whether a build would re-render it. Accepts an id, a meta.href, or an id '
                + 'without its extension. The first thing to reach for when a page will not rebuild and nothing says '
                + 'why. Compares the CATALOG against the manifest, so an edit not yet imported reports as "source '
                + 'differs from the catalog".',
            inputSchema: {
                reference: { type: 'string', required: true,
                    description: 'Entity id, meta.href, or id without its extension.' },
            },
        },
        async ({ reference }) => {
            try {
                // Imported here rather than at module scope: explain.js pulls
                // in the formatter and the manifest, and a build that never
                // asks should not pay for them.
                const { explain } = await import('./explain.js')
                // found:false is an answer, not a failure — it carries a hint
                // about why nothing matched, which is the useful half when a
                // caller has guessed at an id.
                return ok(await explain(reference))
            } catch (err) {
                return fail(err.message)
            }
        },
    )

    registerTool(
        'mikser_verify',
        {
            description:
                'Check the output folder against what the manifest recorded: files missing, files whose bytes no '
                + 'longer match, snapshots with no recorded hash, files on disk no snapshot claims, and destinations '
                + 'claimed by more than one entity. Answers "is what is deployed what mikser thinks it produced". '
                + 'Does not build or write anything.',
            inputSchema: {},
        },
        async () => {
            try {
                if (!runtime.manifest?.verify) return fail('No manifest available — nothing to verify against')
                // The verdict comes FROM the manifest, which is the single
                // place that rule lives. Three consumers deriving it from
                // counts is how one of them silently stopped counting
                // collisions.
                return ok({
                    snapshots: runtime.manifest.size?.() ?? null,
                    ...(await runtime.manifest.verify()),
                })
            } catch (err) {
                return fail(err.message)
            }
        },
    )

    registerTool(
        'mikser_build_report',
        {
            description:
                'What a build cycle did, and why: entities rendered (each with a reason — inputs-changed, '
                + 'ref-changed, query-matched, retry-failed — and the detail behind it), skipped, rendered-but-'
                + 'byte-identical, renders that threw, warnings, and a count of entities gated at import. Each '
                + 'report carries the cycleId it describes. Pass cycles: N for the last N FINISHED cycles, newest '
                + 'first; history keeps the last 10 of this process.',
            inputSchema: {
                cycles: { type: 'number',
                    description: 'How many finished cycles to return, newest first. Omit for the current one.' },
            },
        },
        async ({ cycles }) => {
            try {
                if (cycles) return ok({ reports: cycleHistory(cycles) })
                return ok(buildReport())
            } catch (err) {
                return fail(err.message)
            }
        },
    )
}
