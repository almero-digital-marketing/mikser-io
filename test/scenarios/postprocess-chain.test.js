// Postprocess chain — multi-stage dispatch threading file paths.
//
// Two end-to-end checks against a real subprocess:
//
//   1. Filename convention `welcome.html-upper-tag.hbs` produces
//      postprocessors=['upper','tag']. Both stages run; final output
//      lives at welcome.eml (the last stage's `output`); the renderer's
//      intermediate at welcome.html is cleaned up.
//
//   2. Frontmatter dual key: `postprocessors: [upper, tag]` on the
//      entity surfaces the same shape. Layout filename can stay plain.
//
// Two project-local postprocessors (post-upper and post-tag) keep the
// test self-contained — no external sibling-package symlinks needed.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup,
    freshWorkdir,
} from './_harness.js'

// Stage 1 — read entity.origin, uppercase, write to entity.destination.
// `output: 'html'` so the intermediate keeps an .html extension.
const POST_UPPER = [
    "import path from 'node:path'",
    "import { readFile, writeFile, mkdir } from 'node:fs/promises'",
    "",
    "export const output = 'html'",
    "",
    "export async function postprocess({ entity, options }) {",
    "    const inputAbs  = path.join(options.outputFolder, entity.origin)",
    "    const outputAbs = path.join(options.outputFolder, entity.destination)",
    "    const body = await readFile(inputAbs, 'utf8')",
    "    await mkdir(path.dirname(outputAbs), { recursive: true })",
    "    await writeFile(outputAbs, body.toUpperCase())",
    "    return { success: true, result: entity.destination }",
    "}",
].join('\n')

// Stage 2 — read entity.origin, prepend a tag, write to entity.destination.
// `output: 'eml'` so the final output extension is .eml.
const POST_TAG = [
    "import path from 'node:path'",
    "import { readFile, writeFile, mkdir } from 'node:fs/promises'",
    "",
    "export const output = 'eml'",
    "",
    "export async function postprocess({ entity, options }) {",
    "    const inputAbs  = path.join(options.outputFolder, entity.origin)",
    "    const outputAbs = path.join(options.outputFolder, entity.destination)",
    "    const body = await readFile(inputAbs, 'utf8')",
    "    await mkdir(path.dirname(outputAbs), { recursive: true })",
    "    await writeFile(outputAbs, '<TAG>\\n' + body)",
    "    return { success: true, result: entity.destination }",
    "}",
].join('\n')

const CONFIG = `
import { documents, frontMatter, yaml, layouts, renderHbs } from 'mikser-io'
export default {
    plugins: [
        documents(),
        frontMatter(),
        yaml(),
        layouts(),
        renderHbs(),
    ],
}
`

describe('postprocess chain: filename convention (newsletter.html-upper-tag.hbs)', () => {
    let workdir
    before(async () => {
        workdir = freshWorkdir('postprocess-chain-filename')
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'plugins/post-upper.js': POST_UPPER,
            'plugins/post-tag.js':   POST_TAG,
            'documents/welcome.md':  '---\nlayout: newsletter\n---\nhello',
            'layouts/newsletter.html-upper-tag.hbs': '<html>{{{document.content}}}</html>',
        })
    })
    after(() => cleanup(workdir))

    it('runs both stages, writes the final .eml, drops the renderer intermediate', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, `mikser exit ${code}:\n${combined}`)

        // Final destination is the last stage's output extension.
        const eml = path.join(workdir, 'out', 'welcome.eml')
        assert.ok(existsSync(eml), `expected final .eml at ${eml}`)

        // Renderer's intermediate (welcome.html) should not be hanging
        // around — the dispatcher cleans it up after the chain
        // completes since origin !== final destination.
        const intermediateHtml = path.join(workdir, 'out', 'welcome.html')
        assert.equal(existsSync(intermediateHtml), false, 'renderer intermediate must be cleaned up')

        // Body: TAG line first (from stage 'tag'), then uppercased
        // HTML (stage 'upper').
        const body = await readFile(eml, 'utf8')
        assert.match(body, /^<TAG>\n/, 'tag stage prepended its marker')
        assert.match(body, /<HTML>HELLO<\/HTML>/, 'upper stage uppercased the renderer output')
    })
})

describe('postprocess chain: frontmatter postprocessors array', () => {
    let workdir
    before(async () => {
        workdir = freshWorkdir('postprocess-chain-frontmatter')
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'plugins/post-upper.js': POST_UPPER,
            'plugins/post-tag.js':   POST_TAG,
            // The author opts into the chain via meta.postprocessors;
            // layout filename doesn't encode any postprocessor.
            'documents/welcome.md': '---\nlayout: newsletter\npostprocessors: [upper, tag]\n---\nhello',
            'layouts/newsletter.html.hbs': '<html>{{{document.content}}}</html>',
        })
    })
    after(() => cleanup(workdir))

    it('chains through meta.postprocessors with the same result', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, `mikser exit ${code}:\n${combined}`)

        const eml = path.join(workdir, 'out', 'welcome.eml')
        assert.ok(existsSync(eml), `expected final .eml at ${eml}`)

        const body = await readFile(eml, 'utf8')
        assert.match(body, /^<TAG>\n/)
        assert.match(body, /<HTML>HELLO<\/HTML>/)
    })
})
