// Two entities, one destination — the failure this makes visible.
//
// documents/bg/index.md (an empty stub) and documents/bg/index.yml both
// render to /bg/index.html. Whichever renders last wins and the other's
// output is discarded. Before this, every signal read clean: the build was
// green with warnings: 0, explain showed the destination and a confident
// "would be SKIPPED", and verify said OK.
//
// verify said OK for a reason worth stating, because it means content
// hashing cannot catch this: each render records the hash of the file AFTER
// it wrote, so with concurrent renders the loser reads the winner's bytes
// and BOTH snapshots agree with disk. Measured on this fixture — the two
// snapshots carried the same outputHash. The collision is only visible
// structurally: two snapshots claiming one destination.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), frontMatter(), yaml(),
        layouts({ autoLayouts: false, match: { '@/**': 'page' } }),
        renderHbs(),
    ],
}
`

const FIXTURE = {
    'mikser.config.js': CONFIG,
    // The bytes must differ per entity or the collision is invisible for a
    // second reason: two identical renders really are interchangeable.
    'layouts/page.hbs': '<html><body data-src="{{document.id}}">{{{document.content}}}</body></html>',
    'documents/bg/index.yml': 'href: /bg/index\nlang: bg\ntitle: Home\n',
    'documents/bg/index.md': '',
    'documents/bg/about.md': '---\nhref: /about\nlang: bg\n---\nAbout\n',
}

describe('destination collisions', () => {
    const workdir = freshWorkdir('destination-collision')
    after(() => cleanup(workdir))

    const build = async () => {
        const result = await runMikser(workdir, ['--json'])
        return { code: result.code, report: JSON.parse(result.stdout) }
    }
    const explain = async (id) => {
        const result = await runMikser(workdir, ['--explain', id, '--json'])
        return JSON.parse(result.stdout)
    }

    it('warns in the build report when two entities write one destination', async () => {
        await setupFixture(workdir, FIXTURE)
        const { report } = await build()
        const warning = report.warnings.find(w => w.code === 'destination-collision')
        assert.ok(warning, `expected a collision warning, got ${JSON.stringify(report.warnings)}`)
        assert.equal(warning.destination, '/bg/index.html')
        assert.deepEqual(warning.entities.sort(),
            ['/documents/bg/index.md', '/documents/bg/index.yml'])
        assert.notEqual(report.summary.warnings, 0,
            'a build that discarded half its output must not report warnings: 0')
    })

    it('explain names the competing entity and leads the verdict with it', async () => {
        const report = await explain('/documents/bg/index.yml')
        assert.deepEqual(report.competingDestinations, [{
            destination: '/bg/index.html',
            entities: ['/documents/bg/index.md'],
        }])
        assert.match(report.verdict, /CONTESTED/)
        assert.match(report.verdict, /index\.md/, 'names who it is contested with')
    })

    it('explain is unbothered for an entity with a destination of its own', async () => {
        const report = await explain('/documents/bg/about.md')
        assert.deepEqual(report.competingDestinations, [])
        assert.doesNotMatch(report.verdict, /CONTESTED/)
    })

    it('verify names both claimants and exits non-zero', async () => {
        const result = await runMikser(workdir, ['--verify'])
        const text = (result.stdout + result.stderr).replace(/\x1b\[[0-9;]*m/g, '')

        assert.match(text, /Collision:\s+\/bg\/index\.html/, 'names the destination')
        assert.match(text, /index\.md/, 'names one claimant')
        assert.match(text, /index\.yml/, 'names the other')
        assert.match(text, /Verify WARN/, 'a discarded output is not an OK verdict')
        assert.equal(result.code, 1,
            'WARN exits 1 — visible to a gate, distinct from the 2 that means real drift')
    })

    it('deleting one side keeps the shared output, and says the state is stale', async () => {
        // Deleting the stub used to take /bg/index.html with it — the live
        // homepage — because the unlink did not check whether anything else
        // claimed that destination. The survivor's own source had not
        // changed, so nothing re-rendered it and verify reported it missing.
        //
        // Keeping the file is not enough on its own: the bytes on disk came
        // from the entity that just went away, and the survivor's snapshot
        // recorded that same hash (each render hashes the file after writing,
        // so the loser recorded the winner's bytes). Verify would then bless
        // it. Dropping that snapshot makes the file an orphan, which is what
        // it now is, so the state stays visible instead of turning silent.
        const { rm, readFile } = await import('node:fs/promises')
        const path = await import('node:path')
        await rm(path.join(workdir, 'documents', 'bg', 'index.md'))
        const rebuild = await runMikser(workdir)

        const html = await readFile(path.join(workdir, 'out', 'bg', 'index.html'), 'utf8')
        assert.ok(html.length > 0, 'the live page must survive the delete')
        assert.match((rebuild.stdout + rebuild.stderr).replace(/\x1b\[[0-9;]*m/g, ''),
            /keeping the file/, 'and the build must say why it is stale')

        const result = await runMikser(workdir, ['--verify'])
        const text = (result.stdout + result.stderr).replace(/\x1b\[[0-9;]*m/g, '')
        assert.doesNotMatch(text, /Collision:/, 'one claimant left, so no collision')
        assert.match(text, /Orphan:\s+bg\/index\.html/, 'but the file is unclaimed and says so')
        assert.equal(result.code, 1, 'visible to a gate rather than reported OK')
    })
})
