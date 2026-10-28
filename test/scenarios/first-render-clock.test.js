// How long a cycle took to get a render started, in the log.
//
// Between a restart and the first render there is planning — a plugin
// deciding what to dispatch — and nothing in the log measured it. On a site
// with 6,800 entities and 29 asset presets that gap was two minutes, and the
// only evidence was the distance between two journal lines, which reads as a
// hang rather than as work. One line turns the gap into a number.
//
// The clock starts where a restart's clock starts: the process, for the first
// cycle. `cycle.startedAt` is deliberately narrower — it spans the processing
// cycle, so on a cold build it lands after the import scan, which is most of
// what the reader is waiting through.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

// Derivatives, because a preset dispatch is the case the line was written
// for: the site that spent two minutes planning 20,000 of them before the
// first one ran.
const CONFIG = `
import { files } from 'mikser-io'
import { assets, renderPreset } from 'mikser-io-assets'
export default {
    plugins: [files(), assets({ presets: { web: { match: ['/files/media/**'] } } }), renderPreset()],
}
`

const PRESET = [
    "import { mkdir, copyFile } from 'node:fs/promises'",
    "import path from 'node:path'",
    "export const revision = 1",
    "export default async function web({ entity }) {",
    "    await mkdir(path.dirname(entity.destination), { recursive: true })",
    "    await copyFile(entity.source ?? entity.uri, entity.destination)",
    "}",
].join('\n')

const firstRenderLine = (combined) =>
    combined.split('\n').find(line => line.includes('First render after')) ?? null

describe("the time to a cycle's first render", () => {
    const workdir = freshWorkdir('first-render-clock')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'presets/web.js': PRESET,
            'files/media/one.jpg': 'one',
            'files/media/two.jpg': 'two',
        })
    })

    it('is reported once, on the render that actually ran', async () => {
        const { code, combined } = await runMikser(workdir, [])
        assert.equal(code, 0, combined)

        const line = firstRenderLine(combined)
        assert.ok(line, `no "First render after" line in:\n${combined}`)
        // Once per cycle, not once per render — two derivatives were produced.
        assert.equal(combined.split('First render after').length - 1, 1, combined)
        // A duration, in the same shape every other phase reports.
        assert.match(line, /First render after \d/, combined)
    })

    it('says nothing on a cycle that rendered nothing', async () => {
        // The second build over an unchanged corpus renders nothing, so there
        // is no first render to report. On a watch session this is most
        // cycles, and a line on every one of them would be noise claiming to
        // be a measurement.
        //
        // What this does NOT reach: a cycle that dispatches tasks and renders
        // none of them. Both of the ways to produce one — the manifest's skip
        // and a preset's reuse — need the sources back in the journal with
        // their outputs still current, which a second one-shot build over an
        // unchanged folder does not give. The line sits past both gates in
        // render-cycle.js; that placement is read there, not proved here.
        const { code, combined } = await runMikser(workdir, [])
        assert.equal(code, 0, combined)
        assert.equal(firstRenderLine(combined), null, combined)
    })
})
