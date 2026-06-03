import path from 'node:path'
import { mkdir, writeFile, unlink, rmdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { globby } from 'globby'
import _ from 'lodash'
import { z } from 'zod'
import { whenMcpActive } from '../mcp.js'

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

    function addToSitemap(entity) {
        const logger = useLogger()
        const { sitemap } = runtime.state.layouts
        const { href = '/' + entity.name, lang } = entity.meta || {}
        if (lang) {
            sitemap[href] = sitemap[href] || {};
            let previous = sitemap[href][lang];
            if (previous && (previous.id != entity.id)) {
                logger.warn('Entity with equal href: [%s] %s and %s', previous.collection, previous.id, entity.id);
            }
            sitemap[href][lang] = entity
        }
        else {
            let previous = sitemap[href];
            if (previous && (previous.id != entity.id)) {
                logger.warn('Entity with equal href: [%s] %s and %s', previous.collection, previous.id, entity.id);
            }
            sitemap[href] = entity
        }
    }

    function removeFromSitemap(entity) {
        const { sitemap } = runtime.state.layouts
        const matches = (current) =>
            current.id === entity.id || current.parent === entity.id
        for (let href in sitemap) {
            let entry = sitemap[href]
            if (entry.id) {
                if (matches(entry)) {
                    delete sitemap[href]
                }
            } else {
                for (let lang in entry) {
                    if (matches(entry[lang])) {
                        delete entry[lang]
                    }
                }
            }
        }
    }

    function removePagesFromSitemap(entity) {
        const entities = Array.from(getSitemapEntities())
        for (let current of entities) {
            if (entity.uri == current.uri) {
                removeFromSitemap(current)
            }
        }
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
            sitemap: {}
        }

        runtime.options.layouts = runtime.config.layouts?.layoutsFolder || collection
        runtime.options.layoutsFolder = path.join(runtime.options.workingFolder, runtime.options.layouts)
        runtime.options.layoutsStateFolder = path.join(runtime.options.outputFolder, 'state')

        logger.info('Layouts folder: %s', runtime.options.layoutsFolder)
        await mkdir(runtime.options.layoutsFolder, { recursive: true })

        watch(collection, runtime.options.layoutsFolder)
    })

    onImport(async () => {
        const { layouts } = runtime.state.layouts
        const paths = await globby('**/*', { cwd: runtime.options.layoutsFolder, ignore: ['**/*.js'] })
        for (let relativePath of paths) {
            const uri = path.join(runtime.options.layoutsFolder, relativePath)
            const layout = {
                id: path.join('/layouts', relativePath),
                uri,
                name: relativePath.replace(path.extname(relativePath), ''),
                collection,
                type,
            }
            Object.assign(layout, await getFormatInfo(relativePath))
            layouts[layout.name] = layout
            await createEntity(layout)
        }
    })

    onProcessed(async (signal) => {
        const logger = useLogger()
        const { layouts } = runtime.state.layouts

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
                                entity.layout = layouts[layoutName]
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
                                entity.layout = layouts[autoLayout]
                                logger.debug('Auto layout matched %s -> %s for %s', entity.name, autoLayout, entity.id)
                            } else {
                                logger.trace('Auto layout no match for %s tried: %s', entity.id, candidates.join(', '))
                            }
                        }
                    } else {
                        entity.layout = layouts[entity.meta.layout]
                    }
                    if (entity.meta?.layout && !entity.layout) {
                        logger.warn('Layout not found for %s: %s', entity.collection, entity.id)
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
        const entities = Array.from(getSitemapEntities())
            .filter(entity => entity.layout)
            .sort((a, b) => b.time - a.time)

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
            if (existsSync(sidecarPath)) {
                try {
                    ({ load, plugins = [] } = await import(`${sidecarPath}?stamp=${Date.now()}`))
                } catch (err) {
                    logger.error('Layout sidecar %s failed to load: %s', sidecarPath.replace(runtime.options.workingFolder + '/', ''), err.message)
                    throw err
                }
                if (load) {
                    try {
                        data = await load({ entity, findEntity, findEntities, runtime, signal })
                    } catch (err) {
                        logger.error('Layout sidecar %s load() threw: %s', sidecarPath.replace(runtime.options.workingFolder + '/', ''), err.message)
                        throw err
                    }
                }
            }

            if (data?.pages) {
                if (!_.endsWith(entity.name, entity.format)) {
                    for (let page = 0; page < data.pages - 1; page++) {
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
                                tasks: entity.meta?.task || TASKS.POOL
                            },
                            context: { data, plugins }
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
                            tasks: entity.meta?.task || TASKS.POOL
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
            // `_save: false` (stamped by useRenderer when called with
            // { save: false }) opts out of writing the final output to
            // disk. The bytes still come back to the caller via
            // output.result. Strict equality — only the literal `false`
            // opts out, matching the catalog-flag pattern.
            //
            // The intermediate file (when a postprocessor will run next)
            // must still be written so the postprocessor can consume it,
            // so we only honour `_save: false` for the FINAL output —
            // detected as either "no postprocessor configured" or "we're
            // running on the postprocess side already" (origin set).
            const isFinal = !entity.layout.postprocessor || entity.origin != null
            const skipWrite = entity._save === false && isFinal

            if (!skipWrite) {
                const destinationFile = path.join(runtime.options.outputFolder, entity.destination)
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
                const originFile = path.join(runtime.options.outputFolder, entity.origin)
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

    // ---- MCP tool: mikser_inspect_layout -----------------------------
    // Lives in the layouts plugin (not core) because "what does a layout
    // expect?" is layout-specific knowledge. Follows ADR-0006: domain
    // logic → plugin; the MCP substrate stays in core.
    whenMcpActive((mcp) => {
        mcp.simpleTool(
            'mikser_inspect_layout',
            'Inspect a layout: template source, variables it references, the postprocessor it produces, and sample entities currently using it. Use this to answer "what data does this layout need?" before drafting a preview render — saves a guess-and-render-empty cycle.',
            {
                id: z.string().describe('Layout id, e.g. "/layouts/reports/royalty.html-pdf.liquid". Use mikser_list_entities with { collection: "layouts" } to discover ids.'),
                samples: z.number().int().min(0).max(10).optional().describe('How many existing entities currently using this layout to include as data-shape examples. Default 3. Only entities with explicit meta.layout match; auto-matched layouts are not surfaced.'),
            },
            async ({ id, samples = 3 }) => {
                const logger = useLogger()
                try {
                    const layout = await findEntity({ id })
                    if (!layout || layout.collection !== collection) {
                        return {
                            isError: true,
                            content: [{ type: 'text', text: `Layout not found: ${id}` }],
                        }
                    }

                    let template = ''
                    try {
                        template = await readFile(layout.uri, 'utf8')
                    } catch (err) {
                        return {
                            isError: true,
                            content: [{
                                type: 'text',
                                text: `Layout entity exists but template file unreadable (${layout.uri}): ${err.message}`,
                            }],
                        }
                    }

                    const references = parseTemplateReferences(template)

                    let sampleEntities = []
                    if (samples > 0) {
                        const all = await findEntities()
                        sampleEntities = all
                            .filter(e => e.meta?.layout === layout.name)
                            .slice(0, samples)
                            .map(e => ({ id: e.id, name: e.name, meta: e.meta }))
                    }

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                layout: {
                                    id: layout.id,
                                    name: layout.name,
                                    uri: layout.uri,
                                    format: layout.format,
                                    template: layout.template,
                                    postprocessor: layout.postprocessor ?? null,
                                },
                                templateSource: template,
                                references,
                                samples: sampleEntities,
                                notes: [
                                    'references.variables is a naive regex pass across liquid/handlebars/eta — false positives possible, but covers the common `{{ document.meta.X }}` and `<%= entity.X %>` patterns.',
                                    'samples only includes entities with explicit meta.layout. Auto-matched layouts are not listed; use mikser_list_entities with a filename-pattern filter for those.',
                                ],
                            }, null, 2),
                        }],
                    }
                } catch (err) {
                    logger.error('MCP mikser_inspect_layout error: %s', err.message)
                    return {
                        isError: true,
                        content: [{ type: 'text', text: err.message }],
                    }
                }
            },
        )
        const logger = useLogger()
        logger.info('MCP tool registered: mikser_inspect_layout (layouts plugin)')
    })

    return {
        collection,
        type
    }
}