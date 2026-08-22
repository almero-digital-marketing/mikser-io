// A config edit must invalidate the derived cache.
//
// Before this, editing mikser.config.js invalidated NOTHING: flipping an
// option that changes every page's destination reported "36 unchanged" and
// left the previous output in place. The config WAS read — `--force` applied
// it immediately — it simply took part in no invalidation, so the only
// symptom was output that did not match the config, and nothing said so.
//
// End-to-end against a real subprocess, because the whole point is what
// lands on disk across two separate runs — which the unit harness, holding
// one in-process database, cannot observe.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, stripAnsi } from './_harness.js'

const config = (cleanUrls) => `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(),
        frontMatter(),
        yaml(),
        layouts({ autoLayouts: true, cleanUrls: ${cleanUrls} }),
        renderHbs(),
    ],
}
`

const FILES = {
    'mikser.config.js': config(true),
    'documents/hera.md': '---\ntitle: Hera\n---\nbody\n',
    'layouts/hera.hbs': '<h1>{{document.meta.title}}</h1>',
}

describe('a config change invalidates the cache', () => {
    const workdir = freshWorkdir('config-change')
    after(() => cleanup(workdir))

    it('re-renders to the new destination shape without --force', async () => {
        await setupFixture(workdir, FILES)

        const first = await runMikser(workdir)
        assert.equal(first.code, 0, stripAnsi(first.stderr))
        assert.ok(existsSync(path.join(workdir, 'out', 'hera', 'index.html')),
                  'cleanUrls:true should produce hera/index.html')
        assert.ok(!existsSync(path.join(workdir, 'out', 'hera.html')))

        // Flip the option. Nothing else changes — no source file is touched,
        // so without config invalidation every entity is "unchanged".
        await writeFile(path.join(workdir, 'mikser.config.js'), config(false))

        const second = await runMikser(workdir)
        assert.equal(second.code, 0, stripAnsi(second.stderr))
        const log = stripAnsi(second.stdout + second.stderr)
        assert.match(log, /Config changed/, 'the run should say why it rebuilt')
        assert.ok(existsSync(path.join(workdir, 'out', 'hera.html')),
                  'cleanUrls:false should now produce hera.html — this is the bug')
    })

    it('does not rebuild when the config is untouched', async () => {
        // The invalidation must be driven by an actual change, or every run
        // becomes a cold build and the cache stops meaning anything.
        const third = await runMikser(workdir)
        assert.equal(third.code, 0, stripAnsi(third.stderr))
        const log = stripAnsi(third.stdout + third.stderr)
        assert.ok(!/Config changed/.test(log), 'an unchanged config must not invalidate')
        assert.ok(!/schema mismatch/i.test(log))
    })
})
