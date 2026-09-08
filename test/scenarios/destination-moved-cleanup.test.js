// When an entity's destination moves, the old output goes with it.
//
// Snapshots are keyed by (id, destination), so recording a render at a new
// path INSERTS a row rather than replacing the old one. Nothing used to remove
// the old row, and nothing removed the file it claimed — so changing a
// layout's `destination:` template, or flipping `cleanUrls`, left the previous
// page on disk and a snapshot still vouching for it.
//
// The state is self-consistent, which is what makes it dangerous: the stale
// file still matches the hash its own render recorded, so --audit-output
// reports OK — 0 missing, 0 orphaned — while the site serves a page the
// project no longer produces. No tool said otherwise, on any build, ever.
//
// The delicate half is what must NOT be cleaned up. "This entity did not
// render to that path this cycle" is not the same claim as "this entity no
// longer produces that path", and three ordinary situations look identical
// from here unless the difference is respected:
//
//   - a render SKIPPED as already current
//   - a render that FAILED (its snapshot is kept on purpose, so the last good
//     bytes survive)
//   - one entity matching SEVERAL layouts, where a dependency invalidates one
//     and not the other
//
// Each of those has its own case below, because getting any of them wrong
// deletes a live page — a far worse failure than the staleness being fixed.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, readManifest, stripAnsi } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [documents(), frontMatter(), yaml(), layouts({ layoutsFolder: 'layouts' }), renderHbs()],
}
`

const claims = async (workdir) =>
    (await readManifest(workdir)).map(s => `${s.id} -> ${s.destination}`).sort()

describe('an entity whose destination moves', () => {
    const workdir = freshWorkdir('destination-moved')
    after(() => cleanup(workdir))

    it('loses the old output and the snapshot that claimed it', async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.hbs': '---\ndestination: /old/{{entity.name}}.html\n---\n<i>{{entity.meta.title}}</i>',
            'documents/thing.md': '---\nlayout: page\ntitle: Thing\n---\nbody\n',
        })
        let build = await runMikser(workdir)
        assert.equal(build.code, 0, stripAnsi(build.stderr))
        assert.deepEqual(await claims(workdir), ['/documents/thing.md -> /old/thing.html'])
        assert.ok(existsSync(path.join(workdir, 'out', 'old', 'thing.html')))

        // The layout renames its own output. Same entity, same id, new path.
        await writeFile(path.join(workdir, 'layouts', 'page.hbs'),
            '---\ndestination: /new/{{entity.name}}.html\n---\n<i>{{entity.meta.title}}</i>')
        build = await runMikser(workdir)
        assert.equal(build.code, 0, stripAnsi(build.stderr))

        assert.deepEqual(await claims(workdir), ['/documents/thing.md -> /new/thing.html'],
            'one entity, one claim — the old row must not linger beside the new one')
        assert.ok(existsSync(path.join(workdir, 'out', 'new', 'thing.html')),
            'the new output is written')
        assert.equal(existsSync(path.join(workdir, 'out', 'old', 'thing.html')), false,
            'and the page nobody produces any more is gone from disk')

        // Green for the right reason: nothing claimed, nothing left over. The
        // bug passed this same check while serving a stale page.
        const audit = await runMikser(workdir, ['--audit-output'])
        assert.equal(audit.code, 0, stripAnsi(audit.stdout))
        assert.match(stripAnsi(audit.stdout), /Audit OK: 1 snapshots, 0 missing, .*0 orphaned/,
            stripAnsi(audit.stdout))
    })

    it('keeps the output of a sibling layout that was skipped', async () => {
        // Two layouts on one entity, and only ONE of them is edited. A
        // layout's template hash is part of its own snapshot's refClosure, so
        // editing `feed.hbs` invalidates the feed render alone — the main
        // render is skipped as already current.
        //
        // Its output is not abandoned, and reading its silence as abandonment
        // would unlink a live page. That is a far worse failure than the
        // staleness this whole pass exists to fix, which is why it gets its
        // own case rather than a line in the one above.
        const wd = freshWorkdir('destination-moved-sibling')
        try {
            await setupFixture(wd, {
                'mikser.config.js': CONFIG,
                'layouts/main.hbs': '---\ndestination: /main/{{entity.name}}.html\n---\n<i>{{entity.meta.title}}</i>',
                'layouts/feed.hbs': '---\ndestination: /feed/{{entity.name}}.xml\n---\n<feed>one</feed>',
                'documents/thing.md': '---\nlayouts: [main, feed]\ntitle: Thing\n---\nbody\n',
            })
            let build = await runMikser(wd)
            assert.equal(build.code, 0, build.combined)
            const both = ['/documents/thing.md -> /feed/thing.xml', '/documents/thing.md -> /main/thing.html']
            assert.deepEqual(await claims(wd), both, 'both layouts claim their own destination')

            await writeFile(path.join(wd, 'layouts', 'feed.hbs'),
                '---\ndestination: /feed/{{entity.name}}.xml\n---\n<feed>two</feed>')
            build = await runMikser(wd)
            assert.equal(build.code, 0, build.combined)
            assert.match(stripAnsi(build.combined), /Manifest skipped: 1/,
                'precondition: the main render really was skipped, or this asserts nothing')

            assert.deepEqual(await claims(wd), both,
                'the layout that did not re-render keeps its claim')
            assert.ok(existsSync(path.join(wd, 'out', 'main', 'thing.html')),
                'and above all keeps its FILE — deleting it is the regression this guards')
        } finally {
            await cleanup(wd)
        }
    })
    it('drops the claim when the entity stops rendering altogether', async () => {
        // The other half of the same staleness, and the one the manifest
        // cannot see on its own: with no render task there is nothing to
        // compare a claim against. mikser-io-layouts reports it instead —
        // "I dispatched this and matched no layout" — through
        // manifest.recordNoOutput.
        const wd = freshWorkdir('renders-nothing')
        try {
            await setupFixture(wd, {
                'mikser.config.js': CONFIG,
                'layouts/page.hbs': '<i>{{entity.meta.title}}</i>',
                'documents/thing.md': '---\nlayout: page\ntitle: Thing\n---\nbody\n',
            })
            let build = await runMikser(wd)
            assert.equal(build.code, 0, build.combined)
            assert.deepEqual(await claims(wd), ['/documents/thing.md -> /thing/index.html'])
            assert.ok(existsSync(path.join(wd, 'out', 'thing', 'index.html')))

            // The layout declaration goes away. The entity survives and is
            // re-imported; nothing renders it any more.
            await writeFile(path.join(wd, 'documents', 'thing.md'), '---\ntitle: Thing\n---\nbody\n')
            build = await runMikser(wd)
            assert.equal(build.code, 0, build.combined)

            assert.deepEqual(await claims(wd), [],
                'nothing produces that page now, so nothing may claim it')
            assert.equal(existsSync(path.join(wd, 'out', 'thing', 'index.html')), false,
                'and the page itself is gone')

            const audit = await runMikser(wd, ['--audit-output'])
            assert.equal(audit.code, 0, stripAnsi(audit.stdout))
            assert.match(stripAnsi(audit.stdout), /Audit OK: 0 snapshots/, stripAnsi(audit.stdout))
        } finally {
            await cleanup(wd)
        }
    })

    it('keeps the page when the declared layout merely cannot be found', async () => {
        // A typo, or a layout file renamed. The entity still says which
        // layout it wants, so this is an error to fix rather than a page to
        // withdraw — and mikser's rule through an error is that the last good
        // output survives. Without the distinction, renaming one layout file
        // would delete every page that names it.
        const wd = freshWorkdir('renders-nothing-typo')
        try {
            await setupFixture(wd, {
                'mikser.config.js': CONFIG,
                'layouts/page.hbs': '<i>{{entity.meta.title}}</i>',
                'documents/thing.md': '---\nlayout: page\ntitle: Thing\n---\nbody\n',
            })
            let build = await runMikser(wd)
            assert.equal(build.code, 0, build.combined)
            const page = path.join(wd, 'out', 'thing', 'index.html')
            assert.ok(existsSync(page))

            await writeFile(path.join(wd, 'documents', 'thing.md'),
                '---\nlayout: pge\ntitle: Thing\n---\nbody\n')
            build = await runMikser(wd)
            assert.equal(build.code, 0, build.combined)
            assert.match(stripAnsi(build.combined), /Layout not found/,
                'precondition: it really did fail to resolve')

            assert.ok(existsSync(page),
                'a page must not be taken down on the strength of a typo')
            assert.deepEqual(await claims(wd), ['/documents/thing.md -> /thing/index.html'],
                'and the snapshot that describes it stays with it')
        } finally {
            await cleanup(wd)
        }
    })
    it('takes the paginated children with it', async () => {
        // A paginated entity that stops rendering leaves children behind
        // unless they are collected here. The pagination passes reach children
        // by parent, but only when a render told them this cycle's page count
        // — and an entity that renders nothing tells them nothing, so for it
        // they never fire.
        const wd = freshWorkdir('renders-nothing-paginated')
        try {
            await setupFixture(wd, {
                'mikser.config.js': CONFIG,
                'layouts/list.hbs': '<i>page {{document.page}} of {{document.pages}}</i>',
                'layouts/list.js': 'export async function load() { return { pages: 3 } }',
                'documents/archive.md': '---\nlayout: list\ntitle: Archive\n---\nbody\n',
            })
            let build = await runMikser(wd)
            assert.equal(build.code, 0, build.combined)
            const before = await claims(wd)
            assert.equal(before.length, 3, `precondition: three pages\n${before.join('\n')}`)
            const files = before.map(c => path.join(wd, 'out', c.split(' -> ')[1]))
            for (const f of files) assert.ok(existsSync(f), `precondition: ${f} written`)

            await writeFile(path.join(wd, 'documents', 'archive.md'), '---\ntitle: Archive\n---\nbody\n')
            build = await runMikser(wd)
            assert.equal(build.code, 0, build.combined)

            assert.deepEqual(await claims(wd), [], 'every page claim goes, not just page one')
            for (const f of files) {
                assert.equal(existsSync(f), false, `${f} must be gone`)
            }
        } finally {
            await cleanup(wd)
        }
    })
})
