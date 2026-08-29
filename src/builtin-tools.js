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
// Names are BARE — `explain`, not `mikser_explain`. The prefix exists because
// MCP tool names share one flat namespace across every server a client has
// connected to, so an unprefixed `verify` would collide with any other server
// offering one. That is the protocol's constraint, not the engine's: on the CLI
// `mikser --tool mikser_explain` says mikser twice. So the registry holds the
// bare name and `mikser-io-mcp` adds the prefix when it binds a tool into a
// session — the boundary where it is actually needed.
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
        'explain',
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
        'verify',
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
        'search',
        {
            description:
                'Find a string across the catalog in ONE call — "where does this appear?". Searches entity meta '
                + 'values and, when asked, the source files themselves and the built output, returning '
                + '{ id, collection, path, field, snippet } per hit.\n\n'
                + 'This is how you locate content you can only describe by what it says: a menu label, a phone '
                + 'number, a sentence you were asked to change. Paging the catalog to find it means reading '
                + 'everything, most of which is fonts and image derivatives, and finding a SECOND copy of the same '
                + 'label somewhere else is then a matter of luck.\n\n'
                + 'in: ["meta"] searches structured values, no file I/O. in: ["content"] reads source files, '
                + 'binaries skipped. Default is both. in: ["output"] searches the BUILT files instead and reports '
                + '`occurrences` per destination — the blast-radius question, which is what you want before editing '
                + 'anything shared. The scopes answer different questions and none implies another: a string can be '
                + 'in the output because a layout writes it, with no source entity containing it anywhere.',
            inputSchema: {
                query: { type: 'string', required: true,
                    description: 'Text to find. A plain substring unless `regex` is true. Case-sensitive by default.' },
                collection: { type: 'string',
                    description: 'Restrict to one collection (e.g. "documents"). Omit to search all.' },
                in: { type: 'array',
                    description: 'Where to look: "meta", "content", "output". Default is meta + content.' },
                regex: { type: 'boolean',
                    description: 'Treat `query` as a JavaScript regular expression rather than a literal substring.' },
                ignoreCase: { type: 'boolean', description: 'Case-insensitive matching. Default false.' },
                limit: { type: 'number', description: 'Maximum hits to return (default 50).' },
            },
        },
        async (args) => {
            try {
                const { searchEntities } = await import('./search.js')
                return ok(await searchEntities(args ?? {}))
            } catch (err) {
                return fail(err.message)
            }
        },
    )

    registerTool(
        'sources',
        {
            description:
                'Reverse lookup: what SOURCE entities produced this built destination, and how each one got there. '
                + 'Read from the engine\'s refClosure — its own record of what a render consumed — so a bundle '
                + 'assembled from a catalog query resolves to the actual parts that went in, each tagged with the '
                + 'route that reached it (layout, partial, ref, or the recorded query it matched).\n\n'
                + 'More than one claimant means a destination collision; the sources of all of them are unioned, and '
                + '`explain` names the competitors. To locate a STRING or a CSS selector inside these sources, '
                + 'use `which` (mikser-io-mcp), which answers this question and then searches the answer.',
            inputSchema: {
                destination: { type: 'string', required: true,
                    description: 'Output-relative destination, e.g. "/bg/styles/site.css".' },
            },
        },
        async ({ destination }) => {
            try {
                if (!destination) return fail('destination is required')
                if (!runtime.manifest?.snapshotsAt) {
                    return fail('No manifest available — nothing has been rendered yet.')
                }
                const { sourcesOf } = await import('./manifest.js')
                const claimants = runtime.manifest.snapshotsAt(destination).map(snap => snap.id)
                const sources = await sourcesOf(destination)
                return ok({
                    destination,
                    claimants,
                    sources,
                    count: sources.length,
                    // An empty list reads as "nothing produced this", when the
                    // usual cause is a file COPIED there by the files/shares/
                    // data plugins, which write without a render snapshot.
                    ...(claimants.length ? {} : {
                        hint: 'No render claims this destination. It may be a file copied there without a render '
                            + 'snapshot, or the path may be wrong.',
                    }),
                    ...(claimants.length > 1 ? {
                        contested: 'More than one entity renders here — see the `explain` tool. The sources below are '
                            + 'the union of what all of them consumed.',
                    } : {}),
                })
            } catch (err) {
                return fail(err.message)
            }
        },
    )

    registerTool(
        'build_report',
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
