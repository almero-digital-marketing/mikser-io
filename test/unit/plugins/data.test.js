import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { data } from '../../../src/plugins/data.js'
import { createHarness } from '../plugin-harness.js'

async function withTempOutput(fn) {
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-data-'))
    try {
        return await fn({ workingFolder: dir, outputFolder: path.join(dir, 'out') })
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

describe('data plugin', () => {
    it('registers core lifecycle hooks', () => {
        const h = createHarness()
        data()(h.core)
        assert.ok(h.hooks.loaded.length >= 1)
        assert.ok(h.hooks.afterRender.length >= 1)
        assert.ok(h.hooks.finalize.length >= 1)
        assert.ok(h.hooks.beforeRender.length >= 1)
    })

    it('computes dataFolder under outputFolder on onLoaded', async () => {
        await withTempOutput(async ({ workingFolder, outputFolder }) => {
            const h = createHarness({ options: { workingFolder, outputFolder } })
            data()(h.core)
            await h.runHook('loaded')
            assert.equal(h.runtime.options.dataFolder, path.join(outputFolder, 'data'))
        })
    })

    it('writes entity exports to <dataFolder>/<token>/ when a per-config token is set', async () => {
        await withTempOutput(async ({ workingFolder, outputFolder }) => {
            const h = createHarness({
                options: { workingFolder, outputFolder },
                journal: [{
                    entity: { id: '/d/post.md', collection: 'documents', name: 'post', type: 'document', time: Date.now() },
                    operation: 'create',
                }],
            })
            data({
                entities: {
                    document: { query: () => true, token: 'tenant-a' },
                },
            })(h.core)
            await h.runHook('loaded')
            await h.runHook('beforeRender')

            const expected = path.join(outputFolder, 'data', 'tenant-a', 'post.document.json')
            assert.ok(existsSync(expected), `expected file at ${expected}`)
            // And the un-tokenized path should NOT exist
            assert.equal(existsSync(path.join(outputFolder, 'data', 'post.document.json')), false)
        })
    })

    it('writes entity exports to <dataFolder>/ when no token is set (no regression)', async () => {
        await withTempOutput(async ({ workingFolder, outputFolder }) => {
            const h = createHarness({
                options: { workingFolder, outputFolder },
                journal: [{
                    entity: { id: '/d/post.md', collection: 'documents', name: 'post', type: 'document', time: Date.now() },
                    operation: 'create',
                }],
            })
            data({
                entities: {
                    document: { query: () => true },
                },
            })(h.core)
            await h.runHook('loaded')
            await h.runHook('beforeRender')

            assert.ok(existsSync(path.join(outputFolder, 'data', 'post.document.json')))
        })
    })

    it('honors a different token per named entity config', async () => {
        await withTempOutput(async ({ workingFolder, outputFolder }) => {
            const h = createHarness({
                options: { workingFolder, outputFolder },
                journal: [
                    { entity: { id: '/d/post.md', name: 'post', type: 'document', time: Date.now() }, operation: 'create' },
                    { entity: { id: '/l/page.hbs', name: 'page', type: 'layout', time: Date.now() }, operation: 'create' },
                ],
            })
            data({
                entities: {
                    docs: { query: e => e.type === 'document', token: 'tenant-a' },
                    layouts: { query: e => e.type === 'layout', token: 'tenant-b' },
                },
            })(h.core)
            await h.runHook('loaded')
            await h.runHook('beforeRender')

            assert.ok(existsSync(path.join(outputFolder, 'data', 'tenant-a', 'post.docs.json')))
            assert.ok(existsSync(path.join(outputFolder, 'data', 'tenant-b', 'page.layouts.json')))
        })
    })

    it('writes catalog exports under <dataFolder>/<token>/ when set', async () => {
        await withTempOutput(async ({ workingFolder, outputFolder }) => {
            const documents = [
                { id: '/d/a.md', name: 'a', type: 'document', time: Date.now(), collection: 'documents', format: 'md', destination: '/a.html', stamp: 1, meta: {} },
                { id: '/d/b.md', name: 'b', type: 'document', time: Date.now(), collection: 'documents', format: 'md', destination: '/b.html', stamp: 1, meta: {} },
            ]
            const h = createHarness({
                options: { workingFolder, outputFolder },
                entities: documents,
            })
            data({
                catalog: {
                    sitemap: { query: () => true, token: 'cat-namespace' },
                },
            })(h.core)
            await h.runHook('loaded')
            await h.runHook('finalize')

            const expected = path.join(outputFolder, 'data', 'cat-namespace', 'sitemap.json')
            assert.ok(existsSync(expected))
            const parsed = JSON.parse(await readFile(expected, 'utf8'))
            assert.equal(parsed.length, 2)
        })
    })

    it('writes context exports under <dataFolder>/<token>/ when set', async () => {
        await withTempOutput(async ({ workingFolder, outputFolder }) => {
            const h = createHarness({
                options: { workingFolder, outputFolder },
                journal: [{
                    entity: { id: '/d/post.md', name: 'post', type: 'document', time: Date.now() },
                    operation: 'render',
                    context: { data: { hello: 'world' } },
                }],
            })
            data({
                context: {
                    full: { query: () => true, token: 'ctx-ns' },
                },
            })(h.core)
            await h.runHook('loaded')
            await h.runHook('afterRender')

            const expected = path.join(outputFolder, 'data', 'ctx-ns', 'post.full.json')
            assert.ok(existsSync(expected), `expected ${expected}`)
        })
    })
})
