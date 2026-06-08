// Generate a corpus of `COUNT` posts for the perf test. Run before
// the test to seed test/perf/documents/posts/. Idempotent — clears
// the folder first so re-runs don't accumulate.
//
// The corpus is deterministic for reproducibility (no Math.random),
// so timing differences between runs reflect engine changes, not
// content variance. Title / date / tags / body all derive from the
// post index via simple modular arithmetic.

import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const COUNT = Number(process.argv[2]) || 10_000
const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT  = path.join(HERE, 'documents', 'posts')

// Optional: set TASK=worker to add `task: worker` to each post's
// frontmatter. That dispatches renders through the Piscina pool
// (constants.js TASKS.WORKER) instead of the default in-process async
// dispatch (TASKS.POOL — misleading name; it's main-thread `await`,
// not a worker pool). For sub-millisecond Handlebars renders the IPC
// overhead almost cancels the parallelism gain (~12% faster); for
// expensive renders (PDF, MJML, image compose) Piscina wins big.
const TASK = process.env.TASK || null

const TOPICS = [
    'static site generators', 'reactive frontends', 'incremental builds', 'reverse-reference indexes',
    'idempotent renderers', 'cache invalidation', 'shape preservation', 'workflow ergonomics',
    'graceful degradation', 'observability', 'plugin composition', 'lifecycle contracts',
    'declarative config', 'AI-assisted editing', 'data integrity', 'concurrency', 'eventual consistency',
    'streaming responses', 'progressive enhancement', 'edge-side caching',
]
const VERBS = [
    'Building', 'Rethinking', 'Measuring', 'Debugging', 'Designing',
    'Shipping', 'Maintaining', 'Avoiding',
]
const QUALIFIERS = [
    'in practice', 'at scale', 'without surprises', 'one cycle at a time',
    'with fewer moving parts', 'across many writers', 'when nothing matches',
    'under load', 'past v1', 'after the rewrite',
]
const TAG_POOL = [
    'design', 'performance', 'pipeline', 'plugins', 'lifecycle', 'observability',
    'ai', 'caching', 'concurrency', 'refs', 'config', 'rendering', 'tooling',
    'debugging', 'architecture',
]
const PARAGRAPHS = [
    'The interesting property of this system is that it composes from small primitives, each of which is independently testable. The whole behaves predictably because every part does.',
    'When the spec changed, we expected a cascade of small adjustments. What we got instead was a single edit at the substrate level, and the rest of the codebase carried on as if nothing had happened.',
    'Most performance problems in this kind of pipeline come from doing extra work, not from doing work slowly. Once we found the unnecessary rebuilds, the wall-clock dropped by half.',
    'Idempotence is the property that lets us run the same operation twice without consequences. It is also the property that lets the watcher reprocess on every save without thinking.',
    'The reverse-reference index pays for itself the first time we ask "who depends on this?" — and again the second time we ask it during a delete.',
    'There is a particular flavor of bug that only appears at the seam between two systems. Single-system invariants pass. Cross-system invariants pass. The interaction breaks.',
    'A good config knob is one that defaults to the right answer. A great one is one you never have to set because the default proved correct under every load we measured.',
    'Reading the journal entries in order is the only honest way to reconstruct what happened in a cycle. Logs are summaries; journals are the trace.',
    'The temptation to add a flag is strong. The temptation to remove one is what separates clean libraries from museums of past decisions.',
    'When the render fails, the error message decides whether the next twenty minutes are useful or wasted.',
    'Plugins that compose against shared primitives stay simple. Plugins that import each other stay coupled forever.',
    'The catalog is the source of truth for content, and the file system is the source of truth for the catalog. The chain is short, on purpose.',
    'Live-reload feels like magic until you watch the network panel. Then it feels like reading mail at the post office, which is what it is.',
    'We deferred the optimization for three weeks because the workload did not need it. Then it needed it, and we landed the fix in an afternoon because the abstraction was right.',
    'The build either succeeds completely or fails with a single root cause. There is no in-between, and that property has saved us from more outages than any monitoring rule.',
]

function pickN(arr, n, seed) {
    const out = []
    const used = new Set()
    let s = seed
    while (out.length < n && used.size < arr.length) {
        s = (s * 16807) % 2147483647        // deterministic LCG
        const i = s % arr.length
        if (used.has(i)) continue
        used.add(i)
        out.push(arr[i])
    }
    return out
}

function makeTitle(i) {
    return `${VERBS[i % VERBS.length]} ${TOPICS[(i * 7) % TOPICS.length]} ${QUALIFIERS[(i * 13) % QUALIFIERS.length]}`
}

function makeDate(i) {
    const start = new Date('2025-01-01').getTime()
    const end = new Date('2026-06-30').getTime()
    return new Date(start + ((end - start) * i) / COUNT).toISOString().slice(0, 10)
}

function makeBody(i) {
    const n = 3 + (i % 5)
    const paras = pickN(PARAGRAPHS, n, i + 1)
    return paras.map(p => `<p>${p}</p>`).join('\n\n')
}

async function main() {
    await rm(OUT, { recursive: true, force: true })
    await mkdir(OUT, { recursive: true })

    const t0 = Date.now()
    const writes = []
    for (let i = 1; i <= COUNT; i++) {
        const n = String(i).padStart(6, '0')
        const title = makeTitle(i)
        const slug = `perf-${n}`
        const date = makeDate(i)
        const tags = pickN(TAG_POOL, 2 + (i % 3), i)
        const body = makeBody(i)

        const fm = `---
layout: post
lang: en
href: /blog/${slug}
title: ${title}
description: Perf-test article ${n} — exercises the render pipeline.
author: B#tter Truth
date: ${date}
tags: [${tags.join(', ')}]${TASK ? `\ntask: ${TASK}` : ''}
---

`
        writes.push(writeFile(path.join(OUT, `${slug}.html`), fm + body, 'utf8'))

        // Flush in batches so we don't hold 10k pending promises at once
        if (writes.length >= 500) {
            await Promise.all(writes)
            writes.length = 0
        }
    }
    await Promise.all(writes)

    const ms = Date.now() - t0
    console.log(`Wrote ${COUNT} posts to ${OUT} in ${ms}ms`)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
