import path from 'node:path'
import { mkdir, writeFile, unlink, rmdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { globby } from 'globby'
import _ from 'lodash'
import { inputHashOf } from '../utils.js'
import { createTrack } from '../track.js'
import { queryContext } from '../catalog.js'
import { gateChecksum, sweepDeleted, scanSummary } from '../source.js'
import { checksumsByCollection } from '../catalog.js'

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

export default ({
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

    // Track an `href` against its source `uri` in the inverse index.
    // Both args optional — entities without a uri (rare; mostly layouts
    // themselves) just don't get indexed, which is fine because
    // `removePagesFromSitemap` looks up by uri.
    function indexHref(uri, href) {
        if (!uri || !href) return
        const { uriIndex } = runtime.state.layouts
        let set = uriIndex.get(uri)
        if (!set) {
            set = new Set()
            uriIndex.set(uri, set)
        }
        set.add(href)
    }

    function unindexHref(uri, href) {
        if (!uri || !href) return
        const { uriIndex } = runtime.state.layouts
        const set = uriIndex.get(uri)
        if (!set) return
        set.delete(href)
        if (set.size === 0) uriIndex.delete(uri)
    }

    function addToSitemap(entity) {
        const logger = useLogger()
        const { sitemap } = runtime.state.layouts
        const { href = '/' + entity.name, lang } = entity.meta || {}
        if (lang) {
            sitemap[href] = sitemap[href] || {};
            let previous = sitemap[href][lang];
            if (previous && (previous.id != entity.id)) {
                logger.warn('Entity with equal href: [%s] %s and %s', previous.collection, previous.id, entity.id);
                unindexHref(previous.uri, href)
            }
            sitemap[href][lang] = entity
        }
        else {
            let previous = sitemap[href];
            if (previous && (previous.id != entity.id)) {
                logger.warn('Entity with equal href: [%s] %s and %s', previous.collection, previous.id, entity.id);
                unindexHref(previous.uri, href)
            }
            sitemap[href] = entity
        }
        indexHref(entity.uri, href)
    }

    // Remove every sitemap entry whose entity matches by id or parent.
    // Still a full scan because the match predicate is by id, not by
    // href — but called rarely (only on DELETE journal entries, and
    // the inner cleanup branch of `removePagesFromSitemap`). For the
    // hot per-entity cleanup, see `removePagesFromSitemap`.
    function removeFromSitemap(entity) {
        const { sitemap } = runtime.state.layouts
        const matches = (current) =>
            current.id === entity.id || current.parent === entity.id
        for (let href in sitemap) {
            let entry = sitemap[href]
            if (entry.id) {
                if (matches(entry)) {
                    unindexHref(entry.uri, href)
                    delete sitemap[href]
                }
            } else {
                for (let lang in entry) {
                    if (matches(entry[lang])) {
                        unindexHref(entry[lang].uri, href)
                        delete entry[lang]
                    }
                }
            }
        }
    }

    // Remove any sitemap entries previously emitted from the same source
    // uri (the entity itself plus any paginated children). O(matches) via
    // the inverse index — typically 0 hits on cold (the entity hasn't been
    // added yet) and 1+ on warm restarts where the prior sitemap state
    // was restored from the catalog.
    //
    // Direct delete by href — we already know the exact slot from
    // `uriIndex`, no need to call `removeFromSitemap`'s id-based full
    // scan. That id-based scan is for DELETE journal entries where the
    // dispatcher only knows the entity id and has to find every sitemap
    // entry referencing it.
    function removePagesFromSitemap(entity) {
        const uri = entity.uri
        if (!uri) return
        const { sitemap, uriIndex } = runtime.state.layouts
        const hrefs = uriIndex.get(uri)
        if (!hrefs || hrefs.size === 0) return
        for (const href of hrefs) {
            const entry = sitemap[href]
            if (!entry) continue
            if (entry.id) {
                delete sitemap[href]
            } else {
                // Lang-grouped entry: drop only the variants from this
                // uri. Keep other-lang siblings (they belong to other
                // source files).
                for (const lang in entry) {
                    if (entry[lang].uri === uri) delete entry[lang]
                }
                // Collapse the group if every variant left.
                if (Object.keys(entry).length === 0) delete sitemap[href]
            }
        }
        // Single index reset for the whole uri — cheaper than per-href
        // `unindexHref` and correct because every href we just deleted
        // came from this uri.
        uriIndex.delete(uri)
    }

    function* getSitemapEntities() {
        const { sitemap } = runtime.state.layouts
        for (let href in sitemap) {
            let entry = sitemap[href]
            if (entry.id) {
                if (!entry.page || entry.page <= 1) {
                    yield entry
                }
            } else {
                for (let lang in entry) {
                    if (!entry[lang].page || entry[lang].page <= 1) {
                        yield entry[lang]
                    }
                }
            }
        }
    }

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
            const all = await findEntities()
            sampleEntities = all
                .filter(e => e.meta?.layout === layout.name)
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

        runtime.state.layouts = {
            layouts: {},
            sitemap: {},
            // Inverse index for `removePagesFromSitemap`. Maps an
            // entity.uri (source-file path) to the set of sitemap
            // hrefs that came from that uri — typically the entity
            // itself plus its paginated children. Without this,
            // `removePagesFromSitemap` has to scan the whole sitemap
            // on every CREATE/UPDATE and every render dispatch,
            // which is O(N) per call → O(N²) per cycle. With it,
            // lookup is O(matches) — usually 0 or 1.
            uriIndex: new Map(),
        }

        // Folder name resolved here (config override or default to the
        // collection name) and used immediately to build the absolute
        // path. No need to keep the bare folder-name string on
        // runtime.options — runtime.options.layoutsFolder is the only
        // useful form downstream.
        const layoutsFolderName = runtime.config.layouts?.layoutsFolder || collection
        runtime.options.layoutsFolder = path.join(runtime.options.workingFolder, layoutsFolderName)
        runtime.options.layoutsStateFolder = path.join(runtime.options.outputFolder, 'state')

        logger.debug('Layouts folder: %s', runtime.options.layoutsFolder)
        await mkdir(runtime.options.layoutsFolder, { recursive: true })

        watch(collection, runtime.options.layoutsFolder)

        // Rebuild the in-memory layouts map AND sitemap from the
        // persisted catalog. Required because the gate (below) now
        // suppresses CREATEs for unchanged layouts this cycle, so
        // neither map can be built from journal walks alone. Source-
        // of-truth is the catalog. Subsequent in-cycle mutations
        // still flow through createEntity / addToSitemap / onProcessed.
        //
        // Two indexed queries instead of one full-catalog walk: the
        // `collection` and `meta_href` / `meta_layout` columns are
        // indexed in catalog_entities, so the rebuild touches only
        // entities that actually contribute to the maps. For a typical
        // mixed corpus (documents + resources + schemas + ...) this
        // skips the bulk of the catalog. For a homogeneous one (a
        // 14k-blog where every doc has meta.layout) the sitemap query
        // still returns everyone, but the layouts-collection query
        // is small.
        //
        // Sitemap candidate filter: `meta.layout` (string ref to a
        // layout — the persisted intent) OR `meta.href` (explicit
        // redirect-style entry). Equivalent to the old `e.layout ||
        // e.meta?.href` check for entities whose layout resolution
        // succeeded last cycle; entities whose meta.layout pointed
        // at a missing layout now appear in the sitemap rebuild but
        // are harmless (downstream consumers check `e.layout` or
        // `e.meta?.href` anyway).
        const { layouts } = runtime.state.layouts
        for (const e of await findEntities({ collection })) {
            layouts[e.name] = e
        }
        for (const e of await findEntities({
            $or: [
                { 'meta.layout': { $exists: true } },
                { 'meta.href':   { $exists: true } },
            ],
        })) {
            if (e.collection === collection) continue   // skip layouts themselves
            addToSitemap(e)
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

        for await (let { entity, operation } of useJournal('Layouts processing', [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE], signal)) {
            if (entity.collection == collection) continue
            switch (operation) {
                case OPERATION.CREATE:
                case OPERATION.UPDATE:
                    removePagesFromSitemap(entity)
                    if (!entity.meta?.layout) {
                        for (let pattern in runtime.config.layouts?.match || []) {
                            if (matchEntity(entity, pattern)) {
                                const layoutName = runtime.config.layouts?.match[pattern]
                                entity.layout = await resolveLayout(layoutName)
                                break
                            }
                        }
                        if (!entity.layout && runtime.config.layouts?.autoLayouts && entity.id) {
                            const lookupBase = entity.id.replace(`/${entity.collection}/`,'')
                            const dir = path.dirname(lookupBase)
                            const base = path.basename(lookupBase)
                            const chunks = base.split('.')
                            const candidates = []

                            // Peel trailing chunks within the entity's directory only.
                            // "nginx.conf" (dir=".") -> ["nginx.conf", "nginx"]
                            // "styles/post.css" (dir="styles") -> ["styles/post.css", "styles/post"]
                            for (let i = chunks.length; i > 0; i--) {
                                const head = chunks.slice(0, i).join('.')
                                candidates.push(dir && dir !== '.' ? path.join(dir, head) : head)
                            }

                            const autoLayout = candidates.find(name => layouts[name])
                            if (autoLayout) {
                                entity.layout = await resolveLayout(autoLayout)
                                logger.debug('Auto layout matched %s -> %s for %s', entity.name, autoLayout, entity.id)
                            } else {
                                logger.trace('Auto layout no match for %s tried: %s', entity.id, candidates.join(', '))
                            }
                        }
                    } else {
                        entity.layout = await resolveLayout(entity.meta.layout)
                    }
                    if (entity.meta?.layout && !entity.layout) {
                        logger.warn('Layout not found for %s: %s', entity.collection, entity.id)
                    }
                    // A render-requested entity (carries useRenderer's
                    // correlationId) that resolved to no layout will
                    // silently produce nothing — the caller just gets
                    // api.js's "did not complete". Surface the real reason
                    // here, where we authoritatively know no layout matched.
                    // Gated on correlationId so the thousands of normal
                    // layout-less content files stay quiet.
                    if (!entity.layout && entity.options?.correlationId) {
                        logger.warn(
                            'Render requested for %s but no layout matched — set meta.layout, add a layouts.match rule, or name it to match a layout (auto-layout). Entities without a layout are not rendered.',
                            entity.id,
                        )
                    }

                    if (entity.layout && entity.meta?.postprocessor) {
                        entity.layout.postprocessor = entity.meta.postprocessor
                    }

                    if (entity.layout) {
                        logger.debug('Layout matched for %s: %s', entity.collection, entity.id)
                        addToSitemap(entity)
                    } else if (entity.meta?.href) {
                        logger.trace('Layout missing for %s: %s', entity.collection, entity.id)
                        addToSitemap(entity)
                    }
                    break
                case OPERATION.DELETE:
                    // DELETE journal entries are sparse (id/collection/type only),
                    // so the uri-based removePagesFromSitemap can't match. Walk
                    // the sitemap by id first; keep the uri-based sweep for any
                    // paginated children that match by uri.
                    removeFromSitemap(entity)
                    removePagesFromSitemap(entity)
                    break
            }

        }
    })

    onBeforeRender(async (signal) => {
        const logger = useLogger()
        const tasks = []

        // Sitemap entities with a matched layout are the full universe of
        // render candidates. `--force` (or a missing refs index) walks all
        // of them — the old behaviour, kept as a safety net.
        const allLayoutEntities = Array.from(getSitemapEntities()).filter(e => e.layout)

        let entities
        if (runtime.options.force || !runtime.refs?.inverseClosureOf) {
            entities = allLayoutEntities
            if (runtime.options.force) logger.debug('Force rebuild — dispatching all %d entities', entities.length)
        } else {
            // Hash-aware seeding: drop CREATE/UPDATE entries whose
            // post-processing inputHash matches the last manifest
            // snapshot. Cold-start file discovery emits CREATE for
            // every file even when content didn't change — without
            // this filter, every restart would seed every entity and
            // the closure walk would expand to the whole catalog.
            // DELETE seeds always count.
            //
            // Journal CREATE/UPDATE entries carry the *raw* entity
            // (file bytes + uri, before front-matter / yaml extraction
            // populate entity.meta). Hashes recorded in the manifest
            // are over the *processed* entity. We resolve through the
            // catalog to get the post-processing version for the hash
            // compare.
            //
            // Build an id → recorded inputHash Map up front so per-
            // mutation lookup is O(1). Paginated outputs share an id
            // with the parent; we keep the first-seen hash (they were
            // all written from the same parent's render, same inputHash).
            // Hash map built across all snapshots (entity inputHash +
            // dep target hashes) — manifest owns this view.
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

            // Opt-out: `meta.cache: false` on an entity puts it in
            // every cycle's dispatch regardless of refs. Escape hatch
            // for renders mikser can't track precisely (external data,
            // sidecars with API calls, ECT partials).
            const optOuts = new Set()
            for (const e of allLayoutEntities) {
                if (e.meta?.cache === false) optOuts.add(e.id)
            }

            if (seeds.length === 0 && optOuts.size === 0) {
                entities = []
            } else {
                const closure = seeds.length ? runtime.refs.inverseClosureOf(seeds) : new Set()
                entities = allLayoutEntities.filter(e => closure.has(e.id) || optOuts.has(e.id))
                logger.debug('Incremental dispatch: %d seeds + %d opt-outs → %d entities (of %d total)',
                    seeds.length, optOuts.size, entities.length, allLayoutEntities.length)
            }
        }

        entities.sort((a, b) => b.time - a.time)

        for (let original of entities) {
            if (signal.aborted) return

            delete original.page
            delete original.pages
            delete original.destination

            const entity = _.cloneDeep(original)
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

                            if (runtime.config.layouts?.cleanUrls && entity.layout.format == 'html') {
                                pageEntity.destination = path.join(entity.destination.replace('index', ''), pageEntity.page.toString(), `index.${entity.layout.format}`)
                            } else {
                                pageEntity.destination += page ? `.${pageEntity.page}.${entity.layout.format}` : `.${entity.layout.format}`
                            }
                        } else {
                            removePagesFromSitemap(original)
                            pageEntity.page = 1
                            if (runtime.config.layouts?.cleanUrls && !_.endsWith(entity.name, 'index') && entity.layout.format == 'html') {
                                pageEntity.destination = path.join(entity.destination, `index.${entity.layout.format}`)
                            } else {
                                pageEntity.destination += `.${entity.layout.format}`
                            }
                        }
                        addToSitemap(pageEntity)
                        tasks.push({
                            entity: pageEntity,
                            options: {
                                renderer: entity.layout.template,
                                postprocessor: entity.layout.postprocessor,
                                tasks: entity.meta?.task || TASKS.INLINE
                            },
                            context: { data, plugins, sidecarQueries: sidecarTrack.queries }
                        })
                    }
                }
            } else {
                removePagesFromSitemap(original)
                if (!_.endsWith(entity.name, entity.format)) {
                    if (runtime.config.layouts?.cleanUrls && !_.endsWith(entity.name, 'index') && entity.layout.format == 'html') {
                        entity.destination = path.join(entity.destination, `index.${entity.layout.format}`)
                    } else {
                        entity.destination += `.${entity.layout.format}`
                    }
                }
                addToSitemap(entity)
                if (entity.destination) {
                    tasks.push({
                        entity,
                        options: {
                            renderer: entity.layout.template,
                            postprocessor: entity.layout.postprocessor,
                            tasks: entity.meta?.task || TASKS.INLINE
                        },
                        context: { data, plugins }
                    })
                }
            }
        }
        await renderEntities(tasks)
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
        type
    }
}