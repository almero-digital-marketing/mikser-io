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

        const { default: express } = await import('express').catch(() => {
            throw new Error('express is required for the api plugin — run: npm install express')
        })

        const ownApp = !runtime.options.app
        const app = runtime.options.app ?? express()

        const router = express.Router()
        router.use(express.json())

        const token = runtime.config.api?.token
        const auth = (req, res, next) => {
            if (!token) return next()
            if (req.headers.authorization === `Bearer ${token}`) return next()
            res.status(401).json({ error: 'Unauthorized' })
        }

        // Reuse the transport-agnostic primitives from src/api.js so the
        // library entry point and the Api endpoints share the exact same
        // batching/timeouts/error semantics.
        const { render } = useRenderer(runtime, {
            defaultTimeout: runtime.config.api?.renderTimeout ?? 30_000,
        })

        router.get('/entities', async (req, res) => {
            try {
                const { page: rawPage, limit: rawLimit, ...filter } = req.query
                const page = Math.max(1, parseInt(rawPage) || 1)
                const limit = Math.min(100, Math.max(1, parseInt(rawLimit) || (runtime.config.api?.pageSize ?? 10)))
                const query = Object.keys(filter).length ? filter : undefined

                const all = await findEntities(query)
                const total = all.length
                const totalPages = Math.ceil(total / limit)
                const items = all.slice((page - 1) * limit, page * limit)

                res.json({
                    items,
                    page,
                    limit,
                    total,
                    totalPages,
                    hasNext: page < totalPages,
                    hasPrev: page > 1,
                })
            } catch (err) {
                logger.error('Api list error: %s', err.message)
                res.status(500).json({ error: err.message })
            }
        })

        router.put('/entities', auth, async (req, res) => {
            try {
                const { collection, relativePath, content = '' } = req.body
                await useCollection(runtime, collection).write(relativePath, content)
                res.status(202).json({ ok: true })
            } catch (err) {
                logger.error('Api update error: %s', err.message)
                res.status(/Unknown collection/.test(err.message) ? 400 : 500).json({ error: err.message })
            }
        })

        router.delete('/entities', auth, async (req, res) => {
            try {
                const { collection, relativePath } = req.body
                await useCollection(runtime, collection).remove(relativePath)
                res.status(202).json({ ok: true })
            } catch (err) {
                logger.error('Api delete error: %s', err.message)
                res.status(/Unknown collection/.test(err.message) ? 400 : 500).json({ error: err.message })
            }
        })

        router.post('/render', auth, async (req, res) => {
            try {
                const { output, entity } = await render(req.body)
                await sendRenderOutput(res, output, entity)
            } catch (err) {
                logger.error('Api render error: %s', err.message)
                if (!res.headersSent) {
                    res.status(500).json({ error: err.message })
                }
            }
        })

        const base = runtime.config.api?.base ?? '/api'
        app.use(base, router)

        if (ownApp) {
            const port = runtime.config.api?.port ?? 3001
            const url = runtime.config.api?.url ?? 'http://localhost'
            app.listen(port, () => {
                logger.info('Api listening: %s:%d%s', url, port, base)
            })
        } else {
            logger.info('Api mounted: %s', base)
        }
    })
}
