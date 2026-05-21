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
            const cid = entry.entity?._correlationId
            if (!cid) return
            const item = remaining.get(cid)
            if (!item) return
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
     * @param {object} entity                - any entity-shaped object
     * @param {object} [opts]
     * @param {number} [opts.timeout]        - override the default timeout
     * @returns {Promise<{output, entity}>}
     */
    function render(entity, { timeout = defaultTimeout } = {}) {
        return new Promise((resolve, reject) => {
            const correlationId = randomUUID()
            pending.push({
                entity: { ...entity, _correlationId: correlationId },
                correlationId,
                timeout,
                resolve,
                reject,
                timer: null,
            })
            if (!cycleRunning) setImmediate(runBatch)
        })
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
