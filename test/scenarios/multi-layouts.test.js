// Multi-layouts scenario tests. End-to-end against a real subprocess:
// set up documents/ + layouts/ + mikser.config.js in a temp workdir,
// run mikser one-shot, assert on what landed in out/.
//
// Three behaviors locked in here:
//
//   1. Two layouts both match the same entity; each produces its own
//      output file on disk. Both should exist after the cycle.
//
//   2. Two layouts that resolve to the same destination collide —
//      neither output exists, the build's stdout carries a
//      "Layout collision" error mentioning both layout names.
//
//   3. A layout with a frontmatter `destination:` template writes to
//      the custom path instead of `<entity.name>.<format>`.
//
// These are end-to-end signals — the unit tests cover the in-engine
// matching / collision / template paths in isolation; this file
// covers the actual file-on-disk shape, which the unit harness can't
// observe.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup,
    freshWorkdir,
} from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(),
        frontMatter(),
        yaml(),
        layouts({ autoLayouts: true }),
        renderHbs(),
    ],
}
`

describe('multi-layouts: same entity, two output files', () => {
    let workdir
    before(async () => {
        workdir = freshWorkdir('multi-layouts-fanout')
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'documents/welcome.md': '---\nlayouts: [post, post-email]\ntitle: Welcome\n---\nhello',
            'layouts/post.html.hbs':       '<html><body><h1>{{document.meta.title}}</h1>{{{document.content}}}</body></html>',
            'layouts/post-email.eml.hbs':  '<email><greet>{{document.meta.title}}</greet>{{{document.content}}}</email>',
        })
    })
    after(() => cleanup(workdir))

    it('writes BOTH output files — one per matched layout', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, `mikser exit ${code}:\n${combined}`)

        // Both outputs on disk.
        const html = path.join(workdir, 'out', 'welcome.html')
        const eml  = path.join(workdir, 'out', 'welcome.eml')
        assert.ok(existsSync(html), `expected ${html}`)
        assert.ok(existsSync(eml),  `expected ${eml}`)

        const htmlBody = await readFile(html, 'utf8')
        const emlBody  = await readFile(eml, 'utf8')
        assert.match(htmlBody, /<h1>Welcome<\/h1>/)
        assert.match(emlBody,  /<greet>Welcome<\/greet>/)
    })
})

describe('multi-layouts: destination collision drops both tasks', () => {
    let workdir
    before(async () => {
        workdir = freshWorkdir('multi-layouts-collision')
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'documents/welcome.md': '---\nlayouts: [post, post-card]\ntitle: Welcome\n---\nhello',
            // Both layouts produce .html → collision at /welcome.html
            'layouts/post.html.hbs':      '<html><body>POST {{document.meta.title}}</body></html>',
            'layouts/post-card.html.hbs': '<html><body>CARD {{document.meta.title}}</body></html>',
        })
    })
    after(() => cleanup(workdir))

    it('skips the entity, logs the collision, leaves no output on disk', async () => {
        const { code, combined } = await runMikser(workdir)
        // Build proceeds (build doesn't crash on a per-entity collision);
        // the entity itself just produces no output.
        assert.equal(code, 0, `mikser exit ${code}:\n${combined}`)

        const html = path.join(workdir, 'out', 'welcome.html')
        assert.equal(existsSync(html), false, 'no output file when both layouts collided')

        assert.match(combined, /Layout collision/, 'should log a Layout collision diagnostic')
        assert.match(combined, /post/,             'message should name the layouts')
        assert.match(combined, /post-card/,        'message should name both layouts')
    })
})

describe('multi-layouts: frontmatter destination template', () => {
    let workdir
    before(async () => {
        workdir = freshWorkdir('multi-layouts-destination-template')
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'documents/welcome.md': '---\nlayouts: [post, summary]\ntitle: Welcome\n---\nhello',
            'layouts/post.html.hbs':    '<html><body>POST {{document.meta.title}}</body></html>',
            // Same .html format as post — without the destination
            // override, this would collide. The override sends the
            // summary output to /summaries/welcome.html — no collision.
            'layouts/summary.html.hbs': '---\ndestination: /summaries/{{entity.name}}.html\n---\n<html><body>SUMMARY {{document.meta.title}}</body></html>',
        })
    })
    after(() => cleanup(workdir))

    it('writes the summary to the templated path, post.html stays at default', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, `mikser exit ${code}:\n${combined}`)

        const post    = path.join(workdir, 'out', 'welcome.html')
        const summary = path.join(workdir, 'out', 'summaries', 'welcome.html')

        assert.ok(existsSync(post),    `expected ${post}`)
        assert.ok(existsSync(summary), `expected ${summary}`)

        const postBody    = await readFile(post, 'utf8')
        const summaryBody = await readFile(summary, 'utf8')
        assert.match(postBody,    /POST Welcome/)
        assert.match(summaryBody, /SUMMARY Welcome/)
    })
})
