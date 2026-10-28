// A cap must not mean "on the main thread".
//
// A renderer that spawns an external process needs a limit on how many of
// itself run. It cannot hold that limit itself: under WORKER dispatch its
// code runs in a worker, so a counter it keeps is per thread and the limit
// comes out multiplied by the pool size. mikser-io-assets paid for that by
// pinning every preset declaring `concurrency` to INLINE — which made a
// capped, CPU-bound preset impossible to run in parallel at all, on any
// machine. A site drawing image marks on a 24-core box built its own worker
// pool inside the preset to get around it.
//
// The dispatcher holds it now, around the dispatch and before
// INLINE/SERIAL/WORKER is chosen. A cap no longer FORCES inline — it also
// does not force worker: a preset that wants the pool asks for it with
// `tasks: 'worker'`, exactly as a layout does, and keeps its cap. These run a
// real build: the preset records
// which thread it ran on and how many of it were in flight, into a file the
// test reads back, because a claim about threads is not one to take from a
// log line.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs, sources } from 'mikser-io'
import { assets, renderPreset } from 'mikser-io-assets'
export default {
    threads: 8,
    plugins: [
        documents(), frontMatter(), yaml(),
        sources({ media: { folder: 'media', content: false } }),
        assets({ presets: { mark: { match: '/media/**/*.bin', options: { concurrency: 2, tasks: 'worker' } } } }),
        renderPreset(),
    ],
}
`
// Records the INTERVAL each render occupied, and the thread it ran on.
//
// Not a counter inside the preset: under worker dispatch each thread holds
// its own module instance, so a counter there reads 1 however many are in
// flight — it measures exactly the thing it cannot see, and a test built on
// it passes with the gate removed. Intervals are comparable across threads.
const PRESET = `
import { appendFile, writeFile } from 'node:fs/promises'
import { threadId } from 'node:worker_threads'
export const revision = 1
export const format = 'out'
export default async ({ entity, options }) => {
    const start = Date.now()
    await new Promise(resolve => setTimeout(resolve, 120))
    await writeFile(entity.destination, 'done')
    await appendFile(options.workingFolder + '/runs.log', \`\${start} \${Date.now()} \${threadId}\n\`)
}
`

describe('a render with a declared concurrency cap', () => {
    const workdir = freshWorkdir('capped-render')
    let lines = []

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'presets/mark.js': PRESET,
        })
        await mkdir(path.join(workdir, 'media'), { recursive: true })
        for (let i = 0; i < 8; i++) {
            await writeFile(path.join(workdir, `media/m${i}.bin`), `source ${i}`)
        }
        const { code, combined } = await runMikser(workdir, ['--force'])
        assert.equal(code, 0, combined)
        lines = (await readFile(path.join(workdir, 'runs.log'), 'utf8'))
            .split('\n').filter(Boolean).map(l => l.split(' '))
    })
    after(async () => { await cleanup(workdir) })

    it('renders every source', () => {
        assert.equal(lines.length, 8, `only ${lines.length} of 8 renders ran`)
    })

    it('runs on worker threads, not pinned to the main one', () => {
        // The whole point. threadId is 0 on the main thread and non-zero in a
        // Piscina worker, so this is the claim stated as a measurement.
        const threads = new Set(lines.map(([thread]) => thread))
        assert.ok(!threads.has('0'),
            `a render ran on the main thread; threads seen: ${[...threads].join(', ')}`)
        assert.ok(threads.size > 1,
            `every render landed on one thread (${[...threads].join(', ')}) — not parallel`)
    })

    it('still holds the cap across those threads', () => {
        // Maximum overlap, swept from the intervals. With `threads: 8` and
        // eight sources, an ungated dispatch runs all eight at once; the gate
        // is on the main thread, so it bounds them however many threads they
        // land on.
        const events = lines.flatMap(([start, end]) => [
            { at: Number(start), delta: 1 },
            { at: Number(end), delta: -1 },
        ]).sort((a, b) => a.at - b.at || a.delta - b.delta)
        let running = 0
        let peak = 0
        for (const event of events) {
            running += event.delta
            peak = Math.max(peak, running)
        }
        assert.ok(peak <= 2, `${peak} overlapped under a cap of 2`)
        assert.ok(peak > 1, `nothing overlapped at all (${peak}) — the build was serial, so this proves nothing`)
    })
})
