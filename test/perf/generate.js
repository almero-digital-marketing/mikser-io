// Generate a corpus of `COUNT` posts for the perf test. Run before
// the test to seed test/perf/documents/posts/. Idempotent — clears
// the folder first so re-runs don't accumulate.
//
// The corpus is deterministic for reproducibility (no Math.random),
// so timing differences between runs reflect engine changes, not
// content variance. Title / date / tags / body all derive from the
// post index via simple modular arithmetic.
//
// SIZE env var picks entity weight:
//   - `light`     (default) — minimal frontmatter; ~2-3KB per catalog entry.
//                  Fine for measuring engine code paths; misses
//                  serialization/memory costs at scale.
//   - `realistic` — full SEO meta, hero + gallery image objects, $-refs
//                  to author/category/related, ~10-20 paragraph body.
//                  ~12-18KB per catalog entry. Closer to a real CMS
//                  blog post.

import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const COUNT = Number(process.argv[2]) || 10_000
const SIZE  = process.env.SIZE || 'light'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT  = path.join(HERE, 'documents', 'posts')

// Optional: set TASK=worker to add `task: worker` to each post's
// frontmatter. That dispatches renders through the Piscina pool
// (TASKS.WORKER) instead of the default main-thread async dispatch
// (TASKS.INLINE). For sub-millisecond Handlebars renders the IPC
// overhead almost cancels the parallelism gain (~14% faster); for
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
    const n = SIZE === 'realistic' ? (10 + (i % 11)) : (3 + (i % 5))
    const paras = pickN(PARAGRAPHS, n, i + 1)
    return paras.map(p => `<p>${p}</p>`).join('\n\n')
}

// Realistic frontmatter additions. Modeled on a typical headless-CMS
// blog post: full SEO sub-object, hero image with responsive variants,
// 3–5 inline gallery images, $-refs to author / category / related
// posts, search keywords. Pushes per-entity catalog weight from ~3KB
// → ~12-18KB.
function makeRealisticMeta(i, baseTags) {
    const heroId = 1 + (i % 200)
    const srcset = [320, 640, 960, 1280, 1920].map(w => ({
        url: `/images/heroes/hero-${heroId}-${w}w.webp`,
        width: w,
    }))
    const gallery = Array.from({ length: 3 + (i % 3) }, (_, k) => ({
        url: `/images/galleries/post-${i}-${k}.webp`,
        alt: `Figure ${k + 1} for post ${i}`,
        width: 1200,
        height: 800,
        caption: PARAGRAPHS[(i + k) % PARAGRAPHS.length].slice(0, 120),
    }))
    const relatedIds = pickN(
        Array.from({ length: Math.min(COUNT, 500) }, (_, k) => k + 1),
        5,
        i * 11 + 1,
    ).filter(j => j !== i).slice(0, 4)
    return {
        $author:   `/authors/author-${1 + (i % 25)}`,
        $category: `/categories/cat-${1 + (i % 12)}`,
        $related:  relatedIds.map(j => `/blog/perf-${String(j).padStart(6, '0')}`),
        keywords:  pickN([...baseTags, 'mikser', 'guide', 'how-to', 'tutorial', 'best-practices', 'long-read', 'opinion'], 8, i + 7),
        excerpt:   PARAGRAPHS[i % PARAGRAPHS.length],
        hero: {
            url:    `/images/heroes/hero-${heroId}.webp`,
            alt:    `Hero image for ${makeTitle(i)}`,
            width:  1920,
            height: 1080,
            srcset,
            credit: `Photo by Contributor ${1 + (i % 50)}`,
        },
        gallery,
        seo: {
            ogTitle:       makeTitle(i),
            ogDescription: PARAGRAPHS[(i + 1) % PARAGRAPHS.length].slice(0, 200),
            ogImage:       `/images/heroes/hero-${heroId}-og.webp`,
            twitterCard:   'summary_large_image',
            twitterSite:   '@mikserio',
            canonical:     `https://example.com/blog/perf-${String(i).padStart(6, '0')}`,
            robots:        'index,follow',
            jsonLd: {
                '@context':    'https://schema.org',
                '@type':       'BlogPosting',
                headline:      makeTitle(i),
                datePublished: makeDate(i),
                dateModified:  makeDate(i),
                wordCount:     1500 + (i % 800),
                articleSection: `Section-${1 + (i % 12)}`,
            },
        },
        translations: {
            de: `/de/blog/perf-${String(i).padStart(6, '0')}`,
            fr: `/fr/blog/perf-${String(i).padStart(6, '0')}`,
            es: `/es/blog/perf-${String(i).padStart(6, '0')}`,
        },
        readingTime:    1 + (i % 14),
        wordCount:      1500 + (i % 800),
        commentsClosed: i % 7 === 0,
    }
}

function yamlKey(k) {
    // YAML 1.1 reserves leading `@`, `\``, etc. as indicators; safest
    // to quote any key with non-identifier characters.
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k)) return k
    return JSON.stringify(k)
}

function yamlValue(v, indent) {
    if (v === null || v === undefined) return 'null'
    if (typeof v === 'boolean' || typeof v === 'number') return String(v)
    if (typeof v === 'string') {
        // Quote strings containing YAML-special characters
        if (/[:#@&*!|>'"\[\]{}%,]/.test(v) || v.includes('\n')) {
            return JSON.stringify(v)
        }
        return v
    }
    if (Array.isArray(v)) {
        if (v.length === 0) return '[]'
        return '\n' + v.map(item => {
            if (typeof item === 'object' && item !== null) {
                // Item lines: first key prefixed with `- `, subsequent
                // keys with no prefix. Join glue carries the column
                // alignment (`- ` is 2 chars, so subsequent keys indent
                // by indent + 2 to land at the same column as the
                // first key).
                const inner = Object.entries(item)
                    .map(([k, vv], idx) => `${idx === 0 ? '- ' : ''}${yamlKey(k)}: ${yamlValue(vv, indent + 4)}`)
                    .join('\n' + ' '.repeat(indent + 2))
                return ' '.repeat(indent) + inner
            }
            return ' '.repeat(indent) + '- ' + yamlValue(item, indent + 2)
        }).join('\n')
    }
    // Object
    const lines = Object.entries(v).map(([k, vv]) =>
        ' '.repeat(indent) + `${yamlKey(k)}: ${yamlValue(vv, indent + 2)}`
    )
    return '\n' + lines.join('\n')
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

        let fm
        if (SIZE === 'realistic') {
            const extras = makeRealisticMeta(i, tags)
            const extrasYaml = Object.entries(extras)
                .map(([k, v]) => `${yamlKey(k)}: ${yamlValue(v, 2)}`)
                .join('\n')
            fm = `---
layout: post
lang: en
href: /blog/${slug}
title: ${title}
description: Perf-test article ${n} — exercises the render pipeline.
author: B#tter Truth
date: ${date}
tags: [${tags.join(', ')}]${TASK ? `\ntask: ${TASK}` : ''}
${extrasYaml}
---

`
        } else {
            fm = `---
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
        }
        writes.push(writeFile(path.join(OUT, `${slug}.html`), fm + body, 'utf8'))

        // Flush in batches so we don't hold 10k pending promises at once
        if (writes.length >= 500) {
            await Promise.all(writes)
            writes.length = 0
        }
    }
    await Promise.all(writes)

    const ms = Date.now() - t0
    console.log(`Wrote ${COUNT} posts (SIZE=${SIZE}) to ${OUT} in ${ms}ms`)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
