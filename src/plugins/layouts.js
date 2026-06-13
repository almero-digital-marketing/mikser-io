import path from 'node:path'
import { mkdir, writeFile, unlink, rmdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { globby } from 'globby'
import _ from 'lodash'
import handlebars from 'handlebars'
import { inputHashOf } from '../utils.js'
import { createTrack } from '../track.js'
import { queryContext } from '../catalog.js'
import { gateChecksum, sweepDeleted, scanSummary } from '../source.js'
import { checksumsByCollection } from '../catalog.js'
import { useDatabase } from '../database/index.js'

// Compile-once cache for per-layout `destination:` frontmatter
// templates. Keyed by the template source string so multiple layouts
// sharing the same template share the compiled function.
const destinationTemplateCache = new Map()
function compileDestinationTemplate(template) {
    if (!destinationTemplateCache.has(template)) {
        destinationTemplateCache.set(template, handlebars.compile(template))
    }
    return destinationTemplateCache.get(template)
}

// Path-traversal sanitization for destinations resolved from
// frontmatter templates. Rejects anything that would escape the output
// folder via `..` segments. Matches the forms-plugin sanitizer.
function sanitizeDestination(p) {
    if (p == null) return null
    const s = String(p).replace(/\\/g, '/')
    const leading = s.startsWith('/') ? '/' : ''
    const normalized = path.posix.normalize(s.replace(/^\/+/, ''))
    if (normalized === '..' || normalized.startsWith('../')) {
        throw new Error(`layouts: rejected path-traversal in destination: ${p}`)
    }
    return leading + normalized
}

// Liquid / Handlebars / Eta keywords we don't want surfaced as
// "variables this layout references." Anything that looks like a path
// (`document.meta.X`) survives; bare keywords filter out.
const TEMPLATE_KEYWORDS = new Set([
    'if', 'else', 'elsif', 'endif', 'unless', 'endunless',
    'for', 'endfor', 'each', 'break', 'continue', 'in', 'of',
    'case', 'when', 'endcase', 'switch',
    'capture', 'endcapture', 'assign', 'include', 'layout', 'block',
    'endblock', 'comment', 'endcomment', 'raw', 'endraw',
    'true', 'false', 'nil', 'null', 'and', 'or', 'not', 'with',
])

// Naive multi-engine template scan. Hits liquid (`{{ X }}`, `{% ... %}`),
// handlebars (`{{ X }}`, `{{#each X}}`), and eta (`<%= X %>`,
// `<% for X of Y %>`). Returns up to three buckets:
//   variables  — bare identifier paths used in output position
//   includes   — referenced sub-templates (liquid `include` / `layout`)
//   iterations — `for X in Y` / `each X` shapes so the caller knows
//                where array fields are expected
//
// "Naive" is the right word: regex pass, not an AST walk. False positives
// possible; per-engine plugins can register smarter parsers later.
function parseTemplateReferences(source) {
    const empty = { variables: [], includes: [], iterations: [] }
    if (typeof source !== 'string' || !source) return empty

    const variables = new Set()
    const includes = new Set()
    const iterations = []

    // {{ X.Y.Z }} and <%= X.Y.Z %> — output expressions. Capture leading
    // identifier path; ignore filters (`| upcase`), pipes, and anything
    // after a space.
    const outputExpr = /(?:\{\{=?|<%=)\s*([^}%|]+?)(?:\s*\||\s*\}\}|\s*-?%>)/g
    for (const m of source.matchAll(outputExpr)) {
        const expr = m[1].trim()
        const ident = expr.match(/^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*/)
        if (ident && !TEMPLATE_KEYWORDS.has(ident[0])) {
            variables.add(ident[0])
        }
    }

    // Liquid include / layout — sub-template references.
    for (const m of source.matchAll(/\{%\s*include\s+['"]([^'"]+)['"]/g)) {
        includes.add(m[1])
    }
    for (const m of source.matchAll(/\{%\s*layout\s+['"]([^'"]+)['"]/g)) {
        includes.add(m[1])
    }

    // Liquid `{% for X in Y %}` and `{% for X in Y.Z %}`.
    for (const m of source.matchAll(/\{%\s*for\s+(\w+)\s+in\s+([\w.]+)/g)) {
        iterations.push({ item: m[1], collection: m[2] })
        variables.add(m[2])
    }
    // Handlebars `{{#each X.Y}}`.
    for (const m of source.matchAll(/\{\{#each\s+([\w.]+)/g)) {
        iterations.push({ item: '(each)', collection: m[1] })
        variables.add(m[1])
    }
    // Eta `<% for (const X of Y) { %>` / `<% for X of Y %>`.
    for (const m of source.matchAll(/<%\s*for\s*\(?\s*(?:const|let|var)?\s*(\w+)\s+of\s+([\w.]+)/g)) {
        iterations.push({ item: m[1], collection: m[2] })
        variables.add(m[2])
    }

    return {
        variables: Array.from(variables).sort(),
        includes: Array.from(includes).sort(),
        iterations,
    }
}

export function layouts(options = {}) {
    return ({
        runtime,
        onLoaded,
        useLogger,
        onImport,
        createEntity,
        updateEntity,
        deleteEntity,
        watch,
        onProcessed,
        onBeforeRender,
        useJournal,
        renderEntities,
        onComplete,
        onSync,
        matchEntity,
        changeExtension,
        getFormatInfo,
        findById,
        findEntity,
        findEntities,
        constants: { ACTION, OPERATION, TASKS },
    }) => {
    const collection = 'layouts'
    const type = 'layout'

    // Read a layout file's bytes into entity.content so the frontmatter
    // plugin can extract YAML metadata at onProcess. Defensive — sync
    // events can arrive ahead of file state in edge cases (rename races,
    // synthetic test sync calls). A missing file logs at debug and the
    // entity goes in with empty content; downstream renderers will
    // surface the real failure mode with a clearer error.
    async function readLayoutContent(uri) {
        try {
            return await readFile(uri, 'utf8')
        } catch (err) {
            useLogger().debug('Layout content unreadable at %s: %s', uri, err.message)
            return ''
        }
    }

    // Sitemap lookups live in the catalog — `meta_href` is indexed,
    // so any "find entity by href" query goes through findEntity or
    // (in workers) the read-only sqlite handle they open at first task.
    // The old `runtime.state.layouts.sitemap` in-memory map + `uriIndex`
    // are gone: every entity's "sitemap presence" IS its catalog row.

    // Domain primitive: inspect a layout entity end-to-end. Returns the
    // layout meta, template source bytes, a regex-derived view of the
    // variables / includes / iterations referenced by the template, and
    // up to N sample entities that explicitly target this layout.
    //
    // Throws on layout-not-found or template-unreadable — callers (the
    // mikser-io-mcp plugin's mikser_layouts_inspect tool wraps the
    // result in an MCP error envelope) choose how to surface failures.
    //
    // Lives here, not in mikser-io-mcp, because "what does it mean to
    // inspect a layout" is template-engine knowledge — naive Liquid /
    // Handlebars / Eta regex parsing. The MCP plugin should not know
    // those engines exist; it just wraps this in a tool.
    async function inspect(id, { samples = 3 } = {}) {
        const layout = await findEntity({ id })
        if (!layout || layout.collection !== collection) {
            const err = new Error(`Layout not found: ${id}`)
            err.code = 'LAYOUT_NOT_FOUND'
            throw err
        }

        let templateSource = ''
        try {
            templateSource = await readFile(layout.uri, 'utf8')
        } catch (err) {
            const wrapped = new Error(`Layout entity exists but template file unreadable (${layout.uri}): ${err.message}`)
            wrapped.code = 'LAYOUT_TEMPLATE_UNREADABLE'
            throw wrapped
        }

        const references = parseTemplateReferences(templateSource)

        let sampleEntities = []
        if (samples > 0) {
            // Indexed query on `meta_layout` — returns only the
            // entities that name this layout, not the whole catalog.
            const matching = await findEntities({ 'meta.layout': layout.name })
            sampleEntities = matching
                .slice(0, samples)
                .map(e => ({ id: e.id, name: e.name, meta: e.meta }))
        }

        return {
            layout: {
                id:            layout.id,
                name:          layout.name,
                uri:           layout.uri,
                format:        layout.format,
                template:      layout.template,
                postprocessor: layout.postprocessor ?? null,
            },
            templateSource,
            references,
            samples: sampleEntities,
        }
    }

    // Expose the layouts inspection surface for other plugins (the
    // mikser-io-mcp plugin wraps inspect() as the mikser_layouts_inspect
    // tool). Done at factory-eval time — before any onLoaded fires — so
    // a later plugin's onLoaded can see it. Matches the preview plugin
    // pattern (`runtime.options.preview = { store, get, stats, config }`).
    runtime.options.layouts = { inspect }

    onSync(collection, async ({ action, context }) => {
        if (!context.relativePath) return false
        const { relativePath } = context
        let id = path.join(`/${collection}`, relativePath)
        if (_.endsWith(id, '.js')) id = id.replace(new RegExp('.js$'), '')

        const uri = path.join(runtime.options.layoutsFolder, relativePath)
        const { layouts } = runtime.state.layouts
        switch (action) {
            case ACTION.CREATE:
                var layout = {
                    id,
                    uri,
                    collection,
                    type,
                    name: relativePath.replace(path.extname(relativePath), ''),
                    content: await readLayoutContent(uri),
                    ...getFormatInfo(relativePath)
                }
                layouts[layout.name] = layout
                await createEntity(layout)
                break
            case ACTION.UPDATE:
                var layout = {
                    id,
                    uri,
                    collection,
                    type,
                    name: relativePath.replace(path.extname(relativePath), ''),
                    content: await readLayoutContent(uri),
                    ...getFormatInfo(relativePath)
                }
                layouts[layout.name] = layout
                await updateEntity(layout)
                break
            case ACTION.DELETE:
                var layout = {
                    id,
                    collection,
                    type,
                    format: path.extname(relativePath).substring(1).toLowerCase(),
                }
                for (let name in layouts) {
                    if (layouts[name].id == layout.id) {
                        delete layouts[name]
                    }
                }
                await deleteEntity(layout)
                break
        }
    })

    onLoaded(async () => {
        const logger = useLogger()

        // Only the layouts collection map lives in memory now. The
        // sitemap was 14k+ entries at scale and got serialized to every
        // worker via Piscina; it now lives in the catalog and workers
        // query it directly through their read-only sqlite handle (see
        // src/render.js's ensureWorkerDb / lookupHrefViaDb).
        //
        // `layouts.layouts` (name → layout entity) stays because it's
        // small (typically 5-20 entries), referenced by template-engine
        // partial registration at render-plugin load time, and cheap to
        // both serialize and rebuild.
        runtime.state.layouts = {
            layouts: {},
        }

        // Folder name resolved here (config override or default to the
        // collection name) and used immediately to build the absolute
        // path. No need to keep the bare folder-name string on
        // runtime.options — runtime.options.layoutsFolder is the only
        // useful form downstream.
        const layoutsFolderName = options.layoutsFolder || collection
        runtime.options.layoutsFolder = path.join(runtime.options.workingFolder, layoutsFolderName)
        runtime.options.layoutsStateFolder = path.join(runtime.options.outputFolder, 'state')

        logger.debug('Layouts folder: %s', runtime.options.layoutsFolder)
        await mkdir(runtime.options.layoutsFolder, { recursive: true })

        watch(collection, runtime.options.layoutsFolder)

        // Rebuild the in-memory layouts map from the catalog. Indexed
        // on `collection`, returns the small layouts set — typically a
        // few entries, not the full corpus. Subsequent in-cycle
        // mutations to layouts flow through createEntity in onProcess
        // below.
        const { layouts } = runtime.state.layouts
        for (const e of await findEntities({ collection })) {
            layouts[e.name] = e
        }
    })

    onImport(async () => {
        const { layouts } = runtime.state.layouts
        const logger = useLogger()
        const paths = await globby('**/*', { cwd: runtime.options.layoutsFolder, ignore: ['**/*.js'] })
        const scanned = new Set()
        const stats = { emitted: 0, skipped: 0, deleted: 0 }

        // Same checksum gate + delete sweep mechanics as useSource
        // (source.js) — extracted into shared helpers so adding a
        // future scanning plugin doesn't repeat them again. Layouts
        // can't simply USE useSource because it owns the in-memory
        // `runtime.state.layouts.layouts` map (consumed by hbs's
        // partial registration, by resolveLayout below, and by
        // layouts.inspect), and the load step layers in
        // getFormatInfo. The gate + sweep + summary line shape are
        // shared regardless.
        // Bulk-prefetch this collection's (id → checksum) map once
        // before the loop; the gate hits a Map.get instead of a per-
        // file SQL lookup.
        const priorChecksums = checksumsByCollection(collection)
        for (let relativePath of paths) {
            const uri = path.join(runtime.options.layoutsFolder, relativePath)
            const id = path.join('/layouts', relativePath)
            scanned.add(id)

            const chksum = await gateChecksum(uri, id, { priorChecksums })
            if (chksum === null) {
                stats.skipped++
                continue
            }

            const layout = {
                id, uri,
                name: relativePath.replace(path.extname(relativePath), ''),
                collection,
                type,
                content: await readLayoutContent(uri),
                checksum: chksum,
            }
            Object.assign(layout, await getFormatInfo(relativePath))
            layouts[layout.name] = layout
            await createEntity(layout)
            stats.emitted++
        }

        stats.deleted = await sweepDeleted(collection, scanned, async (e) => {
            // Drop the layout from the in-memory map alongside the
            // journal DELETE so partial-resolution and consumer
            // renders this cycle don't reach for a layout whose file
            // is gone.
            for (let name in layouts) {
                if (layouts[name].id === e.id) delete layouts[name]
            }
            await deleteEntity({ id: e.id, type, collection })
            logger.debug('Layouts removed (file gone): %s', e.name)
        })

        logger.info(scanSummary({ cap: 'Layouts', loaded: paths.length, ...stats }))
    })

    onProcessed(async (signal) => {
        const logger = useLogger()
        const { layouts } = runtime.state.layouts

        // Resolve a layout name to the catalog entity (post-front-matter
        // strip) rather than the state-map entry (raw file bytes). The
        // state map is just an index — it's populated at sync time with
        // whatever readLayoutContent returned, before front-matter has
        // had a chance to lift YAML attributes into meta and strip them
        // from content. Attaching the raw state-map entry as
        // entity.layout makes the renderer emit YAML verbatim into the
        // rendered output (visible bug surfaced via MCP-UI previews).
        //
        // Catalog is the single source of truth for content; state map
        // is just the name → id lookup. Falls back to the state entry
        // only when the catalog hasn't caught up (sync races, synthetic
        // test setups where front-matter hasn't been wired).
        async function resolveLayout(name) {
            const stateEntry = layouts[name]
            if (!stateEntry) return undefined
            return (await findEntity({ id: stateEntry.id })) || stateEntry
        }

        // Resolve the set of layouts that should render `entity` this
        // cycle. Returns an array — empty if none matched. Rules:
        //   1. meta.layout (string) and meta.layouts (array) can't both
        //      be set; if both → throw, caught and logged below.
        //   2. Author-declared selection (meta.layout / meta.layouts)
        //      wins: every named layout is resolved; unknown names get
        //      a warning but don't break the rest.
        //   3. No author selection → multi-match across options.match
        //      patterns. Every matching pattern contributes a layout.
        //   4. No pattern matched AND options.autoLayouts → fall back
        //      to the existing peel ladder; first found wins (the
        //      ladder is a search-by-priority by design, not a list of
        //      independent matches).
        async function resolveLayoutsForEntity(entity) {
            if (entity.meta?.layout && entity.meta?.layouts) {
                throw new Error(
                    `Entity ${entity.id}: both 'meta.layout' and 'meta.layouts' are set — pick one.`
                )
            }
            const declared = Array.isArray(entity.meta?.layouts)
                ? entity.meta.layouts
                : entity.meta?.layout
                    ? [entity.meta.layout]
                    : null

            if (declared) {
                const resolved = []
                for (const name of declared) {
                    const layout = await resolveLayout(name)
                    if (layout) {
                        if (!resolved.find(l => l.name === layout.name)) resolved.push(layout)
                    } else {
                        logger.warn('Layout not found for %s: %s', entity.collection, entity.id, name)
                    }
                }
                return resolved
            }

            // Multi-match over config patterns.
            const matched = []
            for (const pattern in options.match || []) {
                if (matchEntity(entity, pattern)) {
                    const name = options.match[pattern]
                    const layout = await resolveLayout(name)
                    if (layout && !matched.find(l => l.name === layout.name)) {
                        matched.push(layout)
                    }
                }
            }

            // Auto-layout: only as a fallback when no pattern matched.
            // The peel ladder is intentionally first-wins — it's a
            // most-specific-name search, not a multi-match.
            if (matched.length === 0 && options.autoLayouts && entity.id) {
                const lookupBase = entity.id.replace(`/${entity.collection}/`, '')
                const dir = path.dirname(lookupBase)
                const base = path.basename(lookupBase)
                const chunks = base.split('.')
                const candidates = []
                for (let i = chunks.length; i > 0; i--) {
                    const head = chunks.slice(0, i).join('.')
                    candidates.push(dir && dir !== '.' ? path.join(dir, head) : head)
                }
                const autoLayout = candidates.find(name => layouts[name])
                if (autoLayout) {
                    const layout = await resolveLayout(autoLayout)
                    if (layout) matched.push(layout)
                    logger.debug('Auto layout matched %s -> %s for %s', entity.name, autoLayout, entity.id)
                } else {
                    logger.trace('Auto layout no match for %s tried: %s', entity.id, candidates.join(', '))
                }
            }

            return matched
        }

        for await (let { entity, operation } of useJournal('Layouts processing', [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE], signal)) {
            if (entity.collection == collection) continue
            switch (operation) {
                case OPERATION.CREATE:
                case OPERATION.UPDATE:
                    try {
                        entity.layouts = await resolveLayoutsForEntity(entity)
                    } catch (err) {
                        logger.error('Layout resolution for %s: %s', entity.id, err.message)
                        entity.layouts = []
                    }
                    // Back-compat alias. Most existing downstream code
                    // reads `entity.layout`; keep it pointing at the
                    // first matched layout so it stays useful. The
                    // onBeforeRender task-build phase iterates
                    // entity.layouts and reassigns entity.layout per
                    // task to the layout being processed.
                    entity.layout = entity.layouts[0]

                    // Mirror the matched name(s) into meta so the
                    // catalog's `meta_layout` index can find this
                    // entity via "anything with a layout" queries.
                    // Author-declared cases already have meta.layout
                    // (or meta.layouts) set; this covers the
                    // pattern-match / auto-layout paths.
                    if (entity.layouts.length && !entity.meta?.layout && !entity.meta?.layouts) {
                        entity.meta = entity.meta || {}
                        if (entity.layouts.length === 1) {
                            entity.meta.layout = entity.layouts[0].name
                        } else {
                            entity.meta.layouts = entity.layouts.map(l => l.name)
                        }
                    }

                    // A render-requested entity (carries useRenderer's
                    // correlationId) that resolved to no layout will
                    // silently produce nothing — the caller just gets
                    // api.js's "did not complete". Surface the real
                    // reason here, where we authoritatively know no
                    // layout matched. Gated on correlationId so the
                    // thousands of normal layout-less content files
                    // stay quiet.
                    if (entity.layouts.length === 0 && entity.options?.correlationId) {
                        logger.warn(
                            'Render requested for %s but no layout matched — set meta.layout / meta.layouts, add a layouts.match rule, or name it to match a layout (auto-layout). Entities without a layout are not rendered.',
                            entity.id,
                        )
                    }

                    // meta.postprocessor (string) / meta.postprocessors
                    // (array) override is read at task-build time (in
                    // onBeforeRender) because the layout entity is
                    // re-fetched from the catalog there — any mutation
                    // we did to it here would be reverted by the
                    // refresh. We just sanity-check the dual key here
                    // so authors see the error early.
                    if (entity.meta?.postprocessor && entity.meta?.postprocessors) {
                        logger.error(
                            'Entity %s: both meta.postprocessor and meta.postprocessors set — pick one. The chain will fall back to the singular.',
                            entity.id,
                        )
                    }

                    if (entity.layouts.length) {
                        logger.debug('Layouts matched for %s (%d): %s',
                            entity.id, entity.layouts.length,
                            entity.layouts.map(l => l.name).join(', '))
                    } else if (entity.meta?.href) {
                        logger.trace('Layout missing for %s: %s', entity.collection, entity.id)
                    }
                    break
                case OPERATION.DELETE:
                    // Catalog DELETE is the sole source of truth for "this
                    // entity is no longer in the sitemap" — sitemap lives
                    // in the catalog (queried via meta_href), so the
                    // DELETE alone removes it.
                    break
            }
            // Any layout/meta mutation above is auto-persisted by the
            // useJournal generator when this for-body completes (the
            // generator JSON.stringifies the entity post-yield and
            // UPDATEs the row if it diverged from the original).
        }
    })

    onBeforeRender(async (signal) => {
        const logger = useLogger()
        const tasks = []

        // Batched journal flush. tasks accumulate across many entities
        // (sidecar load, pagination expansion), so cap the in-memory
        // queue at FLUSH_BATCH and write to the journal in chunks. At
        // 1M --force the prior shape held the full tasks list in heap
        // (~10GB); chunked flushing keeps peak constant regardless of
        // corpus. Each renderEntities call is one journal transaction;
        // multiple calls land sequentially before onRender fires.
        const FLUSH_BATCH = 1000
        async function maybeFlush() {
            if (tasks.length >= FLUSH_BATCH) {
                await renderEntities(tasks)
                tasks.length = 0
            }
        }

        // Async generator over the entities-to-dispatch. Two shapes
        // depending on path:
        //   - --force / no refs: stream layout-bearing ids from SQL
        //     (ORDER BY time DESC; one-at-a-time findById hydration;
        //     no entity-array materialization regardless of corpus)
        //   - incremental: build seeds + closure + opt-outs in JS
        //     (bounded by graph reachability; typically tens to
        //     hundreds), sort the small set, yield in order.
        async function* dispatchSource() {
            if (runtime.options.force || !runtime.refs?.inverseClosureOf) {
                // --force path. Project ids only — ~50B vs ~7KB per
                // full entity body, ~140× smaller. SQL ORDER BY time
                // DESC handles the sort we'd otherwise do JS-side.
                // findById hydrates each in turn; entities without a
                // resolved .layout (meta.layout was set but no layout
                // file matched) drop here.
                const db = useDatabase()
                const ids = db.prepare(`
                    SELECT id FROM mikser_entities
                    WHERE meta_layout IS NOT NULL
                    ORDER BY time DESC
                `).all().map(r => r.id)
                if (runtime.options.force) {
                    logger.debug('Force rebuild — streaming %d candidate entities', ids.length)
                }
                for (const id of ids) {
                    if (signal.aborted) return
                    const entity = findById(id)
                    if (entity?.layout) yield entity
                }
                return
            }

            // Incremental path. Build seed list from journal mutations,
            // walk refs.inverseClosureOf to get the dispatch ids, then
            // findById each one. Crucially: we do NOT materialize the
            // full layout-bearing slice of the catalog into heap. At
            // 110k entities that allocation was 800MB; this path is
            // bounded by closure size (typically 10s-100s on warm).
            //
            // Hash-aware seeding: drop CREATE/UPDATE entries whose
            // post-processing inputHash matches the last manifest
            // snapshot. Cold-start file discovery emits CREATE for
            // every file even when content didn't change — without
            // this filter, every restart would seed every entity and
            // the closure walk would expand to the whole catalog.
            // DELETE seeds always count.
            const recordedHashes = runtime.manifest?.recordedHashes() ?? new Map()

            const seenSeeds = new Set()
            const seeds = []
            for await (let { entity, operation } of useJournal(
                'Layouts dispatch',
                [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE],
                signal,
            )) {
                if (!entity?.id || seenSeeds.has(entity.id)) continue
                if (operation === OPERATION.DELETE) {
                    seenSeeds.add(entity.id)
                    seeds.push(entity)
                    continue
                }
                const current = await findEntity({ id: entity.id }) ?? entity
                const priorHash = recordedHashes.get(current.id)
                if (priorHash && inputHashOf(current) === priorHash) continue
                seenSeeds.add(current.id)
                seeds.push(current)
            }

            // Opt-outs: `meta.cache: false` entities render every
            // cycle regardless of refs (escape hatch for external-data
            // sidecars, ECT partials, anything mikser can't precisely
            // track). Indexed query on the `meta_cache` column —
            // typical site has 0-10 of these, no full scan.
            const optOutEntities = await findEntities({ 'meta.cache': 0 })

            // Query-dep affected snapshots: aggregate layouts that
            // depend on findEntities(...) instead of static $-refs need
            // a second-pass dispatch hint. manifest.queryAffected walks
            // every snapshot whose refClosure contains a `query` entry
            // and sift-matches the recorded filter against the cycle's
            // mutated entities. Bounded by snapshots-with-query (small
            // — index pages, sitemaps, RSS) × seeds.
            const mutatedEntities = new Map(seeds.map(s => [s.id, s]))
            const queryAffected = runtime.manifest?.queryAffected(mutatedEntities) ?? new Set()

            if (seeds.length === 0 && optOutEntities.length === 0 && queryAffected.size === 0) return

            const closure = seeds.length ? runtime.refs.inverseClosureOf(seeds) : new Set()
            // Combine closure ids + opt-out ids + query-affected ids
            // into one dispatch set.
            const dispatchIds = new Set(closure)
            for (const e of optOutEntities) dispatchIds.add(e.id)
            for (const id of queryAffected) dispatchIds.add(id)

            // Hydrate each id via findById. LRU cache absorbs
            // duplicates (refs BFS revisits, partial dispatches
            // hitting the same layout, etc.). Bounded by closure
            // size — not by catalog size. We do materialize this
            // small set because the sort is intrinsically order-
            // sensitive — closure walk doesn't preserve time order.
            const entities = []
            for (const id of dispatchIds) {
                const entity = findById(id)
                if (entity?.layout) entities.push(entity)
            }
            entities.sort((a, b) => b.time - a.time)
            logger.debug('Incremental dispatch: %d seeds + %d opt-outs → %d entities',
                seeds.length, optOutEntities.length, entities.length)
            for (const entity of entities) {
                if (signal.aborted) return
                yield entity
            }
        }

        for await (const original of dispatchSource()) {
            if (signal.aborted) return

            delete original.page
            delete original.pages
            delete original.destination

            // Multi-layouts: one render task per matched layout.
            // entity.layouts is set in onProcessed; back-compat
            // single-layout entities fall back to [entity.layout].
            const layoutsForEntity = original.layouts?.length
                ? original.layouts
                : (original.layout ? [original.layout] : [])

            // Per-entity destination set, to detect collisions across
            // the layouts that match this same entity. On collision,
            // log a named-names error and skip ALL tasks for this
            // entity (no winner — fail-fast surfaces the design
            // decision back to the author).
            const tasksForEntity = []
            const destinationsForEntity = new Map() // destination → layout.name
            let collisionFound = false

            for (const staleLayout of layoutsForEntity) {
                if (collisionFound) break
                if (signal.aborted) return

            // Re-fetch the layout from the catalog. Front-matter
            // mutations to layout entities (e.g. `meta.destination`)
            // landed during onProcess but the snapshot stored on
            // `entity.layouts` at onProcessed time can be stale; the
            // catalog has the latest by onBeforeRender.
            const refreshedLayout = (await findEntity({ id: staleLayout.id })) || staleLayout

            // Apply entity-level postprocessor override per layout.
            // meta.postprocessors (array) wins over meta.postprocessor
            // (string); fall back to whatever the layout filename
            // encoded.
            const chainOverride = Array.isArray(original.meta?.postprocessors)
                ? original.meta.postprocessors
                : original.meta?.postprocessor
                    ? [original.meta.postprocessor]
                    : null
            const layout = chainOverride
                ? { ...refreshedLayout, postprocessors: chainOverride, postprocessor: chainOverride[0] }
                : refreshedLayout

            const entity = _.cloneDeep(original)
            // Per-task: pin entity.layout to the layout being processed
            // so downstream code (pagination, sidecar lookup, renderer
            // dispatch) sees the single-layout shape it expects.
            entity.layout = layout
            entity.destination = '/' + entity.name
            let data
            let load
            let plugins = []
            const sidecarPath = `${path.join(runtime.options.layoutsFolder, entity.layout.name)}.js`
            // Existence-check first so a real ERR_MODULE_NOT_FOUND inside the
            // sidecar (e.g. it imports a missing package) doesn't get swallowed
            // as "sidecar doesn't exist".
            // Sidecar queries flow into the render's refClosure as
            // `kind: 'query'` edges via the same track shape the engine
            // uses. Without this, layouts whose sidecars build their
            // data with findEntities/queryEntities would silently miss
            // invalidations when a newly-added entity should make the
            // listing change. partial slot disabled — sidecars don't
            // load partials themselves.
            const sidecarTrack = createTrack({ partial: false })
            if (existsSync(sidecarPath)) {
                try {
                    ({ load, plugins = [] } = await import(`${sidecarPath}?stamp=${Date.now()}`))
                } catch (err) {
                    logger.error('Layout sidecar %s failed to load: %s', sidecarPath.replace(runtime.options.workingFolder + '/', ''), err.message)
                    throw err
                }
                if (load) {
                    try {
                        data = await queryContext.run(
                            { entityId: entity.id, track: sidecarTrack },
                            () => load({ entity, findEntity, findEntities, runtime, signal }),
                        )
                    } catch (err) {
                        logger.error('Layout sidecar %s load() threw: %s', sidecarPath.replace(runtime.options.workingFolder + '/', ''), err.message)
                        throw err
                    }
                }
            }

            // Capture a candidate task without queueing yet. Collisions
            // (two layouts producing the same destination for the same
            // entity) are detected after all layouts have been processed,
            // and the whole entity's task set is dropped on the floor —
            // no winner. See the collision check after the per-layout
            // loop closes.
            const queueTask = (taskEntity, taskOptions, taskContext) => {
                if (destinationsForEntity.has(taskEntity.destination)) {
                    const firstLayout = destinationsForEntity.get(taskEntity.destination)
                    logger.error(
                        'Layout collision for %s:\n  - %s → %s\n  - %s → %s\nSet a `destination:` override on one of them, or change one\'s format. Skipping this entity for the cycle.',
                        original.id,
                        firstLayout, taskEntity.destination,
                        layout.name, taskEntity.destination,
                    )
                    collisionFound = true
                    return
                }
                destinationsForEntity.set(taskEntity.destination, layout.name)
                tasksForEntity.push({ entity: taskEntity, options: taskOptions, context: taskContext })
            }

            // Layout-owned destination template (frontmatter
            // `destination:` field). When set, it FULLY overrides the
            // default `entity.name + .format` (+ cleanUrls) derivation.
            // The template gets `{ entity }` as context — including
            // pagination fields (`entity.page`, `entity.pages`) when
            // populated below.
            const destinationTemplate = layout.meta?.destination
                ? compileDestinationTemplate(layout.meta.destination)
                : null

            if (data?.pages) {
                if (!_.endsWith(entity.name, entity.format)) {
                    // Loop bound is `< data.pages` (not `data.pages - 1`).
                    // With 4 pages and the old bound, iteration only ran
                    // page=0,1,2 and the 4th page was silently dropped —
                    // the sitemap claimed "Page X of 4" but the destination
                    // for page 4 was never produced.
                    for (let page = 0; page < data.pages; page++) {
                        const pageEntity = _.cloneDeep(entity)
                        pageEntity.pages = data.pages
                        if (page) {
                            pageEntity.page = page + 1
                            pageEntity.id = changeExtension(entity.id, `${pageEntity.page}.${entity.layout.format}`)
                            // Remember the source entity id so the render manifest
                            // can reclaim paginated outputs when the parent is deleted.
                            pageEntity.parent = entity.id
                            if (entity.meta) {
                                if (entity.meta.href) {
                                    pageEntity.meta.href = `${entity.meta.href}.${pageEntity.page}`
                                } else {
                                    pageEntity.meta.href = `/${entity.name}.${pageEntity.page}`
                                }
                            }
                        } else {
                            pageEntity.page = 1
                        }

                        if (destinationTemplate) {
                            pageEntity.destination = sanitizeDestination(destinationTemplate({ entity: pageEntity }))
                        } else if (page) {
                            if (options.cleanUrls && entity.layout.format == 'html') {
                                pageEntity.destination = path.join(entity.destination.replace('index', ''), pageEntity.page.toString(), `index.${entity.layout.format}`)
                            } else {
                                pageEntity.destination += `.${pageEntity.page}.${entity.layout.format}`
                            }
                        } else {
                            if (options.cleanUrls && !_.endsWith(entity.name, 'index') && entity.layout.format == 'html') {
                                pageEntity.destination = path.join(entity.destination, `index.${entity.layout.format}`)
                            } else {
                                pageEntity.destination += `.${entity.layout.format}`
                            }
                        }

                        queueTask(pageEntity, {
                            renderer: entity.layout.template,
                            postprocessor: entity.layout.postprocessor,
                            postprocessors: entity.layout.postprocessors ?? (entity.layout.postprocessor ? [entity.layout.postprocessor] : []),
                            tasks: entity.meta?.task || TASKS.INLINE,
                        }, { data, plugins, sidecarQueries: sidecarTrack.queries })
                    }
                }
            } else {
                if (destinationTemplate) {
                    entity.destination = sanitizeDestination(destinationTemplate({ entity }))
                } else if (!_.endsWith(entity.name, entity.format)) {
                    // cleanUrls turns `foo` into `foo/index.html` so the
                    // served URL is `/foo/`. Skip the transform when the
                    // layout declares a postprocessor — the HTML render
                    // is a throwaway stepping stone (a PDF stepping
                    // stone has no served URL), and leaving it flat
                    // means engine.onPostprocess's plain extension swap
                    // produces `/foo.<ext>` naturally. Postprocess is
                    // decoupled from cleanUrls by where the decision
                    // gets made — not by the engine knowing about it.
                    if (options.cleanUrls
                        && !_.endsWith(entity.name, 'index')
                        && entity.layout.format == 'html'
                        && !entity.layout.postprocessor
                    ) {
                        entity.destination = path.join(entity.destination, `index.${entity.layout.format}`)
                    } else {
                        entity.destination += `.${entity.layout.format}`
                    }
                }
                if (entity.destination) {
                    queueTask(entity, {
                        renderer: entity.layout.template,
                        postprocessor: entity.layout.postprocessor,
                        postprocessors: entity.layout.postprocessors ?? (entity.layout.postprocessor ? [entity.layout.postprocessor] : []),
                        tasks: entity.meta?.task || TASKS.INLINE,
                    },
                    // sidecarQueries threads the sidecar load()'s
                    // findEntities calls into manifest.collectEdges
                    // as `{kind: 'query', filter}` refClosure entries.
                    // Without it, aggregate layouts that don't
                    // paginate (sitemap.xml, index pages, RSS feeds)
                    // lose query-dep tracking and never invalidate
                    // when matching entities are added/modified/
                    // deleted. The paginated branch above already
                    // does this.
                    { data, plugins, sidecarQueries: sidecarTrack.queries })
                }
            }
            } // end per-layout for-loop

            // Commit this entity's tasks (only if no collision was
            // hit). A collision drops EVERYTHING for the entity — no
            // winner, no half-built output.
            if (!collisionFound) {
                tasks.push(...tasksForEntity)
            }
            await maybeFlush()
        }
        // Final flush — drain anything below the FLUSH_BATCH watermark.
        if (tasks.length) await renderEntities(tasks)
    })

    onComplete(async ({ entity, options, output }) => {
        const logger = useLogger()
        if (entity.layout && !options?.ignore && output.result != null) {
            // `entity.options.save === false` (set by useRenderer when
            // called with { save: false }) opts out of writing the
            // FINAL output to disk. The bytes still come back to the
            // caller via output.result. Strict equality — only the
            // literal `false` opts out, matching the catalog-flag pattern.
            //
            // The intermediate file (when a postprocessor will run next)
            // must still exist somewhere on disk so the postprocessor
            // can consume it. For save:true, that's outputFolder; for
            // save:false, that's runtime.options.previewFolder — an
            // engine-owned scratch path under runtimeFolder, never
            // exposed in user-visible outputFolder. The postprocess
            // task's outputFolder is rewritten in engine.js so post
            // plugins resolve `entity.origin` against the same base.
            const isFinal = !entity.layout.postprocessor || entity.origin != null
            const previewMode = entity.options?.save === false
            const skipWrite = previewMode && isFinal
            const writeBase = (previewMode && !isFinal)
                ? runtime.options.previewFolder
                : runtime.options.outputFolder

            if (!skipWrite) {
                const destinationFile = path.join(writeBase, entity.destination)
                await mkdir(path.dirname(destinationFile), { recursive: true })
                try {
                    await unlink(destinationFile)
                } catch { }
                await writeFile(destinationFile, output.result)
                logger.debug('Layout render finished: %s', entity.destination.replace(runtime.options.workingFolder, ''))
            } else {
                logger.debug('Layout render finished (save:false, bytes only): %s', entity.id)
            }

            if (entity.origin && entity.origin !== entity.destination) {
                // Don't unlink the origin if it was the same path we just
                // wrote to (post plugins that produce the same extension as
                // the renderer's output — e.g. MJML→HTML on `*.html-mjml.*`
                // layouts). Otherwise we'd delete our own final file.
                //
                // For preview flow (entity.options.save === false) the
                // intermediate lived in previewFolder; for normal flow
                // it lived in outputFolder. Pick the right base.
                const originBase = previewMode
                    ? runtime.options.previewFolder
                    : runtime.options.outputFolder
                const originFile = path.join(originBase, entity.origin)
                try {
                    await unlink(originFile)
                } catch { }
                // With cleanUrls the origin was `<name>/index.html`; once
                // the postprocessor wrote `<name>.<ext>` elsewhere, that
                // folder is left empty. Remove it if so. rmdir only
                // succeeds on an empty directory, so this is a no-op when
                // the folder still holds other outputs (e.g. paginated
                // pages).
                try {
                    await rmdir(path.dirname(originFile))
                } catch { }
            }
        }
    })

    return {
        collection,
        type,
    }
    }
}