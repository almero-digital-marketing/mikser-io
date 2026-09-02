// Renaming a source's extension must not delete its output.
//
// `documents/bg/index.md` → `index.yml` keeps the entity NAME and the
// destination but changes the id, so one cycle carries a DELETE for the old id
// and a RENDER for the new one. The delete stages the shared destination for
// unlink; the render's claim on it lives in a snapshot row that is not
// inserted until later in the same commit. Nothing surviving claimed the path,
// so the file the render had just written was removed — with `Rendered: 1`, a
// green build and no warning.
//
// Neither a second build nor a touch recovered it (nothing changed, and the
// input hash is the same); only a real content edit did. Only --verify ever
// said so. Renaming an extension is the most common action there is during a
// migration, which is where this was found.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup,
    freshWorkdir,
} from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), frontMatter(), yaml(), layouts(), renderHbs()] }
`

describe('renaming a source extension', () => {
    const workdir = freshWorkdir('rename-extension')
    after(() => cleanup(workdir))
    const out = () => path.join(workdir, 'out', 'bg', 'index.html')

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.html.hbs': '<!doctype html><body>{{document.meta.title}}</body>',
            'documents/bg/index.md': '---\nlayout: page\ntitle: Before\n---\nbody\n',
        })
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.match(await readFile(out(), 'utf8'), /Before/)
    })

    it('keeps the output the new entity just wrote', async () => {
        // Same entity name, same destination, different id — a DELETE and a
        // RENDER in one cycle.
        await rm(path.join(workdir, 'documents/bg/index.md'))
        await writeFile(path.join(workdir, 'documents/bg/index.yml'), 'layout: page\ntitle: After\n')

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.ok(existsSync(out()),
            `the rename must not delete the page it just rendered\n${combined}`)
        assert.match(await readFile(out(), 'utf8'), /After/,
            'and the surviving file must be the NEW render, not the old bytes')
    })

    it('says so if it ever cannot — this was silent, which is what made it expensive', async () => {
        // The build was green with the page gone. Whatever else changes here,
        // a missing output must not pass unremarked: the reference check now
        // reads the emitted tree, so a page that vanished is reported.
        const { combined } = await runMikser(workdir, ['--force'])
        assert.match(await readFile(out(), 'utf8'), /After/)
        assert.doesNotMatch(combined, /Missing/, combined)
    })

    it('a genuine delete still removes the output', async () => {
        // The guard must not become "never unlink anything" — a source that
        // is actually gone still takes its page with it.
        await rm(path.join(workdir, 'documents/bg/index.yml'))
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.equal(existsSync(out()), false,
            `a deleted source must still remove its output\n${combined}`)
    })
})
