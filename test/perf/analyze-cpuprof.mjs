// Analyze V8 CPU profiles. Reports top-N frames by self-time and by
// total time, plus per-module aggregates. Self-time = time the function
// was on the stack TOP. Total time = self + any descendants.

import { readFileSync } from 'node:fs'
import path from 'node:path'

const file = process.argv[2]
if (!file) {
    console.error('usage: analyze-cpuprof.mjs <file.cpuprofile> [topN]')
    process.exit(1)
}
const topN = Number(process.argv[3] ?? 25)

const prof = JSON.parse(readFileSync(file, 'utf8'))
const nodes = new Map(prof.nodes.map(n => [n.id, n]))

// Reconstruct sample durations. `timeDeltas[i]` is the delta from
// `startTime + sum(timeDeltas[0..i])` to that sample, in microseconds.
// We attribute each sample's delta to the corresponding `samples[i]`
// (the leaf node ON STACK at that tick) — that's self-time. Then walk
// the parent chain to accumulate total-time.
const selfUs = new Map()
const totalUs = new Map()
const parent = new Map()
for (const n of prof.nodes) {
    if (n.children) for (const c of n.children) parent.set(c, n.id)
}

let totalSamples = 0
let totalDuration = 0
for (let i = 0; i < prof.samples.length; i++) {
    const id = prof.samples[i]
    const dt = prof.timeDeltas[i] ?? 0
    if (dt <= 0) continue
    totalSamples++
    totalDuration += dt
    selfUs.set(id, (selfUs.get(id) ?? 0) + dt)
    let cur = id
    const seen = new Set()
    while (cur !== undefined && !seen.has(cur)) {
        seen.add(cur)
        totalUs.set(cur, (totalUs.get(cur) ?? 0) + dt)
        cur = parent.get(cur)
    }
}

const totalMs = totalDuration / 1000
console.log(`profile: ${path.basename(file)}`)
console.log(`samples: ${totalSamples}, wall total in samples: ${totalMs.toFixed(0)}ms`)
console.log()

function label(n) {
    const f = n.callFrame
    const name = f.functionName || '(anonymous)'
    let where = f.url || ''
    // Trim cwd prefix
    where = where.replace(process.cwd() + '/', '')
    where = where.replace(/^file:\/\/[^ ]*?mikser-io\//, '')
    where = where.replace(/^node:internal\//, 'internal/')
    const line = f.lineNumber >= 0 ? `:${f.lineNumber + 1}` : ''
    return `${name} ${where}${line}`.trim()
}

function topBy(map, kind) {
    const rows = [...map.entries()]
        .map(([id, us]) => ({ node: nodes.get(id), us }))
        .filter(r => r.node)
        .sort((a, b) => b.us - a.us)
        .slice(0, topN)
    console.log(`Top ${topN} by ${kind} time`)
    console.log(`${'ms'.padStart(8)}  ${'pct'.padStart(5)}  function`)
    for (const r of rows) {
        const pct = ((r.us / totalDuration) * 100).toFixed(1)
        const ms = (r.us / 1000).toFixed(0)
        console.log(`${ms.padStart(8)}  ${pct.padStart(5)}  ${label(r.node)}`)
    }
    console.log()
}

topBy(selfUs, 'self')

// Per-module aggregates by self-time. Group by URL bucket.
const byModule = new Map()
for (const [id, us] of selfUs) {
    const n = nodes.get(id)
    if (!n) continue
    let url = n.callFrame.url || '(unknown)'
    url = url.replace(process.cwd() + '/', '')
    url = url.replace(/^file:\/\/[^ ]*?mikser-io\//, '')
    // Bucket node_modules entries by package name
    const nm = url.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/)
    if (nm) url = `node_modules/${nm[1]}`
    else if (url.startsWith('node:')) url = 'node-internal'
    byModule.set(url, (byModule.get(url) ?? 0) + us)
}
const moduleRows = [...byModule.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
console.log(`Top 20 modules by self-time`)
console.log(`${'ms'.padStart(8)}  ${'pct'.padStart(5)}  module`)
for (const [m, us] of moduleRows) {
    const pct = ((us / totalDuration) * 100).toFixed(1)
    const ms = (us / 1000).toFixed(0)
    console.log(`${ms.padStart(8)}  ${pct.padStart(5)}  ${m}`)
}
