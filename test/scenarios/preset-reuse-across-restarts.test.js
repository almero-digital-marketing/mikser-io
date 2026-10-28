// A derivative that is already on disk is derived once, whatever happens to
// the catalog.
//
// The completed-render marker is the durable record: the preset's revision is
// in its name, the source checksum is in its body, and it sits beside the
// derivative where no cache wipe can reach it. Every restart below has that
// evidence available, so every one of them must reuse.
//
// The build this was written for had the opposite behaviour. Editing a config
// module wipes the catalog — mikser says so and it is the right thing, files
// are the source of truth — and the assets plugin then found no prior entity
// for any preset and read that as "every preset moved". One edit queued
// 12,944 renders on a live site, about two hours of drawing, over derivatives
// whose sources had not changed and whose markers were sitting beside them.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, cp, rm } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const config = (marker = '') => `
import { files } from 'mikser-io'
import { assets, renderPreset } from 'mikser-io-assets'
import { presets } from './config/presets.js'
export default {${marker}
    plugins: [files(), assets({ presets }), renderPreset()],
}
`

// A local module the config imports, so editing it moves the config stamp —
// which is exactly how the live site's catalog came to be wiped.
const presetsModule = `
export const presets = {
    web:   { match: ['/files/media/**'] },
    thumb: { match: ['/files/media/**'] },
}
`

const PRESET = (revision) => [
    "import { mkdir, writeFile } from 'node:fs/promises'",
    "import path from 'node:path'",
    `export const revision = ${revision}`,
    "export const format = 'webp'",
    "export default async function derive({ entity }) {",
    "    await mkdir(path.dirname(entity.destination), { recursive: true })",
    "    await writeFile(entity.destination, 'derived from ' + entity.id)",
    "}",
].join('\n')

// `Assets planning: <n> render task(s), <m> reused, …`
function planned(combined) {
    const line = combined.split('\n').find(l => l.includes('Assets planning:'))
    if (!line) return null
    const [, tasks, reused] = line.match(/Assets planning: (\d+) render task\(s\), (\d+) reused/) ?? []
    return tasks === undefined ? null : { tasks: Number(tasks), reused: Number(reused) }
}

describe('deriving the same sources again', () => {
    const workdir = freshWorkdir('preset-reuse')
    after(() => cleanup(workdir))

    // `--log debug`: the planning line is info only when the step takes a
    // second or more, and six derivatives take milliseconds. The line is the
    // whole measurement here, so the level has to make it speak.
    const build = async (args = []) => {
        const { code, combined } = await runMikser(workdir, ['--log', 'debug', ...args])
        assert.equal(code, 0, combined)
        return { combined, plan: planned(combined) }
    }

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': config(),
            'config/presets.js': presetsModule,
            'presets/web.js': PRESET(1),
            'presets/thumb.js': PRESET(1),
            'files/media/one.jpg': 'one',
            'files/media/two.jpg': 'two',
            'files/media/three.jpg': 'three',
        })
        // The build that produces the derivatives and their markers.
        const first = await build()
        assert.deepEqual(first.plan, { tasks: 6, reused: 0 }, first.combined)
    })

    it('reuses every derivative on an ordinary restart', async () => {
        const { plan, combined } = await build()
        // Nothing moved, so nothing is even scheduled — and what IS scheduled
        // must be reused, never re-derived.
        assert.equal(plan?.tasks ?? 0, plan?.reused ?? 0, combined)
    })

    it('reuses every derivative when a config change wipes the catalog', async () => {
        // The reported case. The wipe is correct and stays; what must not
        // follow from it is "the catalog does not remember this preset,
        // therefore it moved".
        await writeFile(path.join(workdir, 'config', 'presets.js'),
            `${presetsModule}\nexport const unrelated = true\n`)
        const { plan, combined } = await build()

        assert.match(combined, /Wiping the cache/, `expected the config change to wipe:\n${combined}`)
        assert.deepEqual(plan, { tasks: 6, reused: 6 },
            `every derivative was on disk with a current marker:\n${combined}`)
    })

    it('reuses every derivative after a restore onto new inodes', async () => {
        // A host move or a restore from backup: same paths, same contents,
        // same mtimes, different inodes. Nothing about a derivative's
        // identity lives in its inode, and nothing here may think it does.
        const aside = `${workdir}-moved`
        await rm(aside, { recursive: true, force: true })
        await cp(workdir, aside, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
        await rm(workdir, { recursive: true, force: true })
        await cp(aside, workdir, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
        await rm(aside, { recursive: true, force: true })

        const { plan, combined } = await build()
        if (plan) assert.equal(plan.tasks, plan.reused, combined)
        assert.doesNotMatch(combined, /Rendered: [1-9]/, `nothing should have been re-derived:\n${combined}`)
    })

    it('re-derives only the preset whose revision moved, even with the catalog wiped', async () => {
        // The other half: forgetting the catalog must not make a real change
        // invisible either. The marker carries the revision it was written
        // at, so a bump is still caught — by the marker, not by the catalog.
        await writeFile(path.join(workdir, 'presets', 'web.js'), PRESET(2))
        await writeFile(path.join(workdir, 'config', 'presets.js'),
            `${presetsModule}\nexport const alsoUnrelated = true\n`)

        const { plan, combined } = await build()
        assert.match(combined, /Wiping the cache/, combined)
        assert.deepEqual(plan, { tasks: 6, reused: 3 },
            `only web's three derivatives should re-derive:\n${combined}`)
    })

    it('reuses everything it rendered, on the restart after that', async () => {
        // Whatever a cycle rendered, it claimed — so the next start has
        // nothing to do. A cycle that leaves any derivative unclaimed turns
        // every later build into a full re-derive.
        const { plan, combined } = await build()
        assert.equal(plan?.tasks ?? 0, plan?.reused ?? 0, combined)
        assert.doesNotMatch(combined, /preset-unfinished/, combined)
    })
})
