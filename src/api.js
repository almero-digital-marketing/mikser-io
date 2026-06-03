// Public, transport-agnostic primitives that the API plugin's HTTP
// endpoints are thin wrappers over. Library users embedding mikser
// programmatically can import these directly.

import { randomUUID } from 'node:crypto'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import path from 'node:path'
import './lifecycle.js' // side-effect: attaches runtime.create / update / delete

/**
 * Bind to the runtime and return an on-demand renderer that pipelines
 * concurrent calls into the minimum number of `runtime.process()` cycles.
 * The returned binding is stateful — each call to useRenderer() owns its
 * own pending queue and `completed`-hook lifecycle. Mount once per
 * consumer (the API plugin mounts one; a library service mounts its own).
 *
 * @example
 *   const { render } = useRenderer(runtime)
 *   const { output, entity } = await render(entityShape)
 *
 * @param {object} runtime                  - the mikser runtime singleton
 * @param {object} [opts]
 * @param {number} [opts.defaultTimeout]    - per-render timeout in ms (default 30_000)
 * @returns {{ render: (entity, { timeout? }?) => Promise<{ output, entity }> }}
 */
export function useRenderer(runtime, { defaultTimeout = 30_000 } = {}) {
    let pending = []
    let cycleRunning = false

    async function runBatch() {
        if (cycleRunning || pending.length === 0) return
        cycleRunning = true

        const batch = pending
        pending = []

        const remaining = new Map(batch.map(b => [b.correlationId, b]))
        const completedHooks = runtime.hooks.completed
        const hook = async (entry) => {
            const cid = entry.entity?.options?.correlationId
            if (!cid) return
            const item = remaining.get(cid)
            if (!item) return
            // Only resolve on the FINAL completion. For postprocessor-
            // equipped entities the engine fires runtime.complete twice:
            // once after render (intermediate bytes, entity.origin not
            // set) and once after postprocess (final bytes, entity.origin
            // set to the intermediate destination). useRenderer's
            // contract is "return the pipeline's final output", so we
            // skip the intermediate fire and wait for the final.
            const hasPostprocessor = entry.entity?.layout?.postprocessor
            const isFinal = !hasPostprocessor || entry.entity?.origin != null
            if (!isFinal) return
            remaining.delete(cid)
            clearTimeout(item.timer)
            item.resolve({ output: entry.output, entity: entry.entity })
        }
        completedHooks.push(hook)

        for (const item of batch) {
            item.timer = setTimeout(() => {
                if (remaining.delete(item.correlationId)) {
                    item.reject(new Error(`Render timeout for ${item.entity.id}`))
                }
            }, item.timeout)
        }

        try {
            for (const item of batch) {
                await runtime.update(item.entity).catch(item.reject)
            }
            await runtime.process()
        } catch (err) {
            for (const item of remaining.values()) {
                clearTimeout(item.timer)
                item.reject(err)
            }
            remaining.clear()
        } finally {
            for (const item of remaining.values()) {
                clearTimeout(item.timer)
                item.reject(new Error(`Render did not complete for ${item.entity.id}`))
            }
            const idx = completedHooks.indexOf(hook)
            if (idx >= 0) completedHooks.splice(idx, 1)
            cycleRunning = false
            if (pending.length) setImmediate(runBatch)
        }
    }

    /**
     * Submit an entity for rendering. Resolves with `{ output, entity }`
     * where `output.result` is whatever the renderer/postprocessor returned
     * (a string for HTML/text outputs, a Buffer for PDFs, etc.).
     *
     * Requests arriving concurrently are coalesced into the next available
     * `runtime.process()` cycle — within that cycle, mikser's worker pool
     * renders the batch in parallel.
     *
     * Two control flags mirror mikser's default-keep-everything behavior;
     * both opt-out via strict `=== false`:
     *
     * - `catalog: true` (default) — keep the entity in the catalog after
     *   the render. Pass `catalog: false` to prune the catalog row;
     *   useful for on-demand renders where the metadata row would just
     *   accumulate.
     * - `save: true` (default) — write the rendered output to disk at
     *   `<outputFolder>/<entity.destination>`. Pass `save: false` to
     *   skip the final disk write; the bytes still come back via
     *   `output.result` for you to pipe wherever you want (HTTP
     *   response, S3, …). For layouts with a postprocessor (e.g.
     *   `*.html-pdf.*`), the intermediate is written to a scratch path
     *   under `runtime.options.previewFolder` (engine-owned, never
     *   in outputFolder) so the postprocessor can consume it; only
     *   the FINAL output is skipped from disk. `output.result` is
     *   always the FINAL pipeline output — PDF bytes for a
     *   `*.html-pdf.*` layout, MJML-derived HTML for
     *   `*.html-mjml.*`, etc., not the intermediate.
     *
     * The rendered output's bytes are always returned in `output.result`
     * regardless of either flag — `save` only affects whether they also
     * end up on disk.
     *
     * Per-entity engine state (correlation id, control flags) lives at
     * `entity.options.*` — same noun mikser uses for engine config
     * (`runtime.options`) and plugin params, scoped to one entity's
     * pass through the lifecycle. Consumers should not set
     * `entity.options.correlationId` themselves; useRenderer owns it.
     *
     * @param {object} entity                - any entity-shaped object
     * @param {object} [opts]
     * @param {number}  [opts.timeout]       - override the default timeout
     * @param {boolean} [opts.catalog=true]  - keep the catalog row after render
     * @param {boolean} [opts.save=true]     - write the rendered output to disk
     * @returns {Promise<{output, entity}>}
     */
    async function render(entity, { timeout = defaultTimeout, catalog = true, save = true } = {}) {
        const result = await new Promise((resolve, reject) => {
            const correlationId = randomUUID()
            // Engine-set fields live under entity.options. The caller's
            // render(entity, { save: false }) becomes
            // entity.options.save = false here — same noun mikser uses
            // for engine config (runtime.options) and plugin params,
            // just scoped to one entity's pass through the lifecycle.
            //
            // Only set `save` when explicitly opting out — leaves the
            // entity.options as a clean { correlationId } in the common
            // case rather than carrying a redundant save:true.
            const prepared = {
                ...entity,
                options: {
                    ...entity.options,
                    correlationId,
                    ...(save === false ? { save: false } : {}),
                },
            }
            pending.push({
                entity: prepared,
                correlationId,
                timeout,
                resolve,
                reject,
                timer: null,
            })
            if (!cycleRunning) setImmediate(runBatch)
        })

        if (catalog === false) {
            // Explicit opt-out: prune the catalog row so it doesn't
            // accumulate. The rendered output file stays on disk — the
            // bytes are the work product. We deliberately bypass the
            // journal/DELETE path here (which would also unlink the file
            // via engine.js's manifest cleanup) and splice the entity
            // out of the in-memory catalog directly. Strict equality so
            // ambiguous inputs (null, "false", 0) fall through to the
            // default of keeping the row.
            const entities = runtime.catalog?.data?.entities
            if (entities) {
                const idx = entities.findIndex(e => e.id === result.entity.id)
                if (idx >= 0) entities.splice(idx, 1)
            }
        }

        return result
    }

    return { render }
}

/**
 * Bind to a single collection's source folder and return file-level
 * `write` / `remove` operations against it. Each collection plugin sets
 * `runtime.options.<name>Folder` during its onLoaded hook; this looks
 * that up lazily, so it's safe to call useCollection() anywhere after
 * `runtime.start()`.
 *
 * Distinct from `lifecycle.updateEntity` / `lifecycle.deleteEntity` —
 * those write journal entries. These write actual files; in watch mode
 * the resulting fs change is what kicks the next sync→process cycle.
 *
 * @example
 *   const documents = useCollection(runtime, 'documents')
 *   await documents.write('en/draft.md', '# Hi')
 *   await documents.remove('en/old.md')
 *
 * @param {object} runtime         - the mikser runtime singleton
 * @param {string} name            - collection name (e.g. 'documents')
 * @returns {{
 *   name: string,
 *   folder: string,
 *   write(relativePath: string, content?: string): Promise<string>,
 *   remove(relativePath: string): Promise<void>,
 * }}
 */
export function useCollection(runtime, name) {
    function resolveFolder() {
        const folder = runtime?.options?.[`${name}Folder`]
        if (!folder) throw new Error(`Unknown collection: ${name}`)
        return folder
    }

    return {
        name,
        get folder() { return resolveFolder() },

        async write(relativePath, content = '') {
            const uri = path.join(resolveFolder(), relativePath)
            await mkdir(path.dirname(uri), { recursive: true })
            await writeFile(uri, content, 'utf8')
            return uri
        },

        async remove(relativePath) {
            const uri = path.join(resolveFolder(), relativePath)
            await unlink(uri)
        },
    }
}
