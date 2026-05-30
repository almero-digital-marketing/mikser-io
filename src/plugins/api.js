import path from 'node:path'
import { access } from 'node:fs/promises'
import { useRenderer, useCollection } from '../api.js'

// MIME type lookup used when streaming a postprocessor's output back over
// HTTP. The renderer's output extension lives on entity.destination
// (assigned by the layouts plugin), so we use it as the source of truth.
const MIME_BY_EXT = {
    pdf: 'application/pdf',
    html: 'text/html; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    xhtml: 'application/xhtml+xml; charset=utf-8',
    rss: 'application/rss+xml; charset=utf-8',
    atom: 'application/atom+xml; charset=utf-8',
    json: 'application/json; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
}

export function mimeForEntity(entity) {
    if (!entity?.destination) return null
    const ext = path.extname(entity.destination).toLowerCase().replace(/^\./, '')
    return MIME_BY_EXT[ext] ?? null
}

// Decide how to send the render output over HTTP. Exported (and pure-ish)
// so tests can exercise the branching without spinning up a real server.
export async function sendRenderOutput(res, output, entity) {
    if (output == null || output.result == null) {
        return res.status(204).send()
    }
    const result = output.result
    const mime = mimeForEntity(entity)

    if (Buffer.isBuffer(result)) {
        if (mime) res.type(mime)
        return res.send(result)
    }
    if (typeof result === 'string') {
        // A few postprocessors might return an absolute path to a generated
        // file rather than its contents. Only attempt this when the string
        // looks plausibly path-shaped — short, starts with a slash, and the
        // file actually exists. Otherwise treat it as content.
        if (result.length < 4096 && (result.startsWith('/') || /^[A-Za-z]:[\\/]/.test(result))) {
            try {
                await access(result)
                return res.sendFile(result)
            } catch { /* not a path, fall through */ }
        }
        if (mime) res.type(mime)
        return res.send(result)
    }
    // Anything else (plain object, etc.) is sent as JSON.
    return res.json(result)
}

export default ({
    runtime,
    onLoaded,
    useLogger,
    findEntities,
}) => {
    onLoaded(async () => {
        const logger = useLogger()

        // The api plugin no longer creates its own Express app. It mounts
        // onto an existing app provided either by --server (engine
        // creates one) or by a caller that programmatically passed
        // setup({ app: ... }). Without an app there's nowhere to mount
        // routes, so fail fast with a message that points at the fix.
        const app = runtime.options.app
        if (!app) {
            throw new Error(
                'API plugin requires runtime.options.app — run mikser with --server, ' +
                'or pass { app: yourExpressInstance } to setup() before loading the api plugin'
            )
        }

        const endpoints = runtime.config.api?.endpoints
        if (!endpoints || !Object.keys(endpoints).length) {
            logger.warn('Api plugin loaded but no endpoints configured (api.endpoints) — nothing to mount')
            return
        }

        const { default: express } = await import('express').catch(() => {
            throw new Error('Express is required for the api plugin — run: npm install express')
        })

        const base = runtime.config.api?.base ?? '/api'
        const globalPageSize = runtime.config.api?.pageSize ?? 10
        const globalRenderTimeout = runtime.config.api?.renderTimeout ?? 30_000

        // The plugin mirrors the vector / data plugin shape: a named map
        // of endpoints, each with its own optional `token`, `query`
        // scope, allowed `operations`, and overrides for pageSize /
        // renderTimeout. Each endpoint mounts under <base>/<name>.
        //
        //   api.endpoints.public  { query: e => e.meta?.published, operations: ['list'] }
        //   api.endpoints.admin   { token: '...', operations: ['list','update','delete','render'] }
        for (const [name, ep] of Object.entries(endpoints)) {
            const router = express.Router()
            router.use(express.json())

            // Operations default to the safer shape when no token is set
            // (read-only) and full access when token-gated. Explicit
            // `operations` always wins.
            const defaultOps = ep.token
                ? ['list', 'update', 'delete', 'render']
                : ['list']
            const allowedOps = new Set(ep.operations ?? defaultOps)

            const query = typeof ep.query === 'function' ? ep.query : null
            const pageSize = ep.pageSize ?? globalPageSize
            const renderTimeout = ep.renderTimeout ?? globalRenderTimeout

            const auth = (req, res, next) => {
                if (!ep.token) return next()
                if (req.headers.authorization === `Bearer ${ep.token}`) return next()
                res.status(401).json({ error: 'Unauthorized' })
            }

            const allow = (op) => (req, res, next) => {
                if (!allowedOps.has(op)) {
                    return res.status(403).json({
                        error: `Operation '${op}' is not allowed on endpoint '${name}'`,
                    })
                }
                next()
            }

            // Reuse the transport-agnostic primitives from src/api.js so
            // the library entry point and the HTTP endpoints share the
            // exact same batching/timeouts/error semantics. One renderer
            // per endpoint so per-endpoint renderTimeout overrides land.
            const { render } = useRenderer(runtime, { defaultTimeout: renderTimeout })

            router.get('/entities', allow('list'), auth, async (req, res) => {
                try {
                    const { page: rawPage, limit: rawLimit, ...filter } = req.query
                    const page = Math.max(1, parseInt(rawPage) || 1)
                    const limit = Math.min(100, Math.max(1, parseInt(rawLimit) || pageSize))
                    const reqQuery = Object.keys(filter).length ? filter : undefined

                    let all = await findEntities(reqQuery)
                    // Endpoint-level scope: a public endpoint can be
                    // restricted to e.g. published documents even when
                    // the caller asks for everything.
                    if (query) all = all.filter(query)
                    const total = all.length
                    const totalPages = Math.ceil(total / limit) || 1
                    const items = all.slice((page - 1) * limit, page * limit)

                    res.json({
                        items, page, limit, total, totalPages,
                        hasNext: page < totalPages,
                        hasPrev: page > 1,
                    })
                } catch (err) {
                    logger.error('Api[%s] list error: %s', name, err.message)
                    res.status(500).json({ error: err.message })
                }
            })

            router.put('/entities', allow('update'), auth, async (req, res) => {
                try {
                    const { collection, relativePath, content = '' } = req.body
                    await useCollection(runtime, collection).write(relativePath, content)
                    res.status(202).json({ ok: true })
                } catch (err) {
                    logger.error('Api[%s] update error: %s', name, err.message)
                    res.status(/Unknown collection/.test(err.message) ? 400 : 500).json({ error: err.message })
                }
            })

            router.delete('/entities', allow('delete'), auth, async (req, res) => {
                try {
                    const { collection, relativePath } = req.body
                    await useCollection(runtime, collection).remove(relativePath)
                    res.status(202).json({ ok: true })
                } catch (err) {
                    logger.error('Api[%s] delete error: %s', name, err.message)
                    res.status(/Unknown collection/.test(err.message) ? 400 : 500).json({ error: err.message })
                }
            })

            router.post('/render', allow('render'), auth, async (req, res) => {
                try {
                    // Body shape mirrors the JS API: entity fields at top
                    // level, control flags grouped under `options`. Forwarded
                    // straight to render(entity, options). Defaults match
                    // mikser's lifecycle (save and keep the catalog row);
                    // strict opt-outs via the literal `false`:
                    //   options.catalog: false → prune the catalog row
                    //   options.save:    false → skip the final disk write
                    //                            (bytes still in the response)
                    const { options = {}, ...entityShape } = req.body
                    // When the endpoint declares a scope, reject anything
                    // outside it BEFORE pushing through the renderer.
                    if (query && !query(entityShape)) {
                        return res.status(403).json({ error: 'Entity is outside this endpoint\'s scope' })
                    }
                    const { output, entity } = await render(entityShape, options)
                    await sendRenderOutput(res, output, entity)
                } catch (err) {
                    logger.error('Api[%s] render error: %s', name, err.message)
                    if (!res.headersSent) {
                        res.status(500).json({ error: err.message })
                    }
                }
            })

            app.use(`${base}/${name}`, router)
            logger.info('Api endpoint mounted: %s/%s (ops=[%s] %s)',
                base, name, [...allowedOps].join(','),
                ep.token ? '[token]' : '[public]')
        }
    })
}
