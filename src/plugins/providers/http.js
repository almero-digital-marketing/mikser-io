// Built-in HTTP / HTTPS content provider.
//
// Handles `http://` and `https://` URIs inline — same way the fs reader
// handles plain paths and `file://`. Lives under src/plugins/providers/
// rather than embedded in utils/ because providers ARE a conceptually
// pluggable surface; even when they ship built-in, factoring them as
// separate files keeps the substrate honest and makes room for future
// schemes that earn engine-internal status (mailto:, gemini:, gopher:,
// kidding) to land alongside.
//
// Operationally:
//   - GET only. Mutations aren't a content-read concern.
//   - Conditional requests via cached ETag / Last-Modified. The second
//     poll on an unchanged URL costs ~200 bytes (a 304 response with
//     headers and no body) — way cheaper than re-downloading the
//     resource. Cache survives the process lifetime; not persisted.
//   - Concurrent reads of the same URL coalesce into one fetch. Useful
//     when the same URL appears as the source of multiple entities
//     (e.g. an aggregate layout iterating + a vector embedding refresh
//     happening at the same time).
//   - Text MIMEs → `{ content: <utf8> }`.
//   - Binary MIMEs → mirror to `runtime/http-cache/<sha-of-url>.<ext>`,
//     return `{ contentSkipped, cachedAt }`. Downstream plugins
//     (assets, post-pdf, etc.) read the cached file as a local path.
//   - Operator-supplied headers come from `entity.meta.httpHeaders`.
//     Source plugins that emit HTTP-backed entities put the
//     Authorization tokens / custom Accept / etc. there; this provider
//     just forwards them.

import path from 'node:path'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import runtime from '../../runtime.js'

// Module-level caches. Live for the process; rebuild on restart.
// Persisting these to sqlite would buy fewer round-trips on a cold
// boot — defer until someone proves they care.
const etagCache = new Map()   // url → { etag, lastModified, payload }
const inflight  = new Map()   // url → Promise — coalesce concurrent

const TEXT_MIMES = new Set([
    'text/plain',
    'text/markdown',
    'text/html',
    'text/css',
    'text/csv',
    'text/tab-separated-values',
    'text/xml',
    'text/javascript',
    'application/json',
    'application/yaml',
    'application/x-yaml',
    'application/xml',
    'application/javascript',
    'application/sql',
])

function isTextMime(mime) {
    if (!mime) return false
    const base = mime.split(';')[0].trim().toLowerCase()
    if (TEXT_MIMES.has(base)) return true
    if (base.startsWith('text/')) return true
    return false
}

function extFromMime(mime, urlStr) {
    const urlExt = (() => {
        try { return path.extname(new URL(urlStr).pathname).slice(1).toLowerCase() }
        catch { return '' }
    })()
    if (!mime) return urlExt || 'bin'
    const base = mime.split(';')[0].trim().toLowerCase()
    if (base === 'application/pdf')  return 'pdf'
    if (base === 'application/zip')  return 'zip'
    if (base.startsWith('image/'))   return base.slice('image/'.length)
    if (base.startsWith('audio/'))   return base.slice('audio/'.length)
    if (base.startsWith('video/'))   return base.slice('video/'.length)
    return urlExt || 'bin'
}

// Entry point invoked by readEntityContent for http:// / https:// URIs.
// Returns the same shape as the fs reader:
//   { content }         — text body fetched OK
//   { contentSkipped, cachedAt } — binary mirrored to local cache
//   { contentError }    — fetch failed (4xx/5xx, timeout, network)
export async function readHttpEntity(entity) {
    const url = entity?.uri
    if (!url) return { contentError: 'http: entity has no uri' }

    if (inflight.has(url)) return inflight.get(url)
    const p = doRead(entity, url).finally(() => inflight.delete(url))
    inflight.set(url, p)
    return p
}

async function doRead(entity, url) {
    const cached  = etagCache.get(url)
    const headers = { ...(entity.meta?.httpHeaders ?? {}) }
    if (cached?.etag)         headers['If-None-Match']     = cached.etag
    if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified

    const timeoutMs = entity.meta?.httpTimeoutMs ?? 30_000
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)

    let res
    try {
        res = await fetch(url, {
            method:   'GET',
            headers,
            signal:   ac.signal,
            redirect: 'follow',
        })
    } catch (err) {
        clearTimeout(timer)
        if (err.name === 'AbortError') {
            return { contentError: `http: timeout after ${timeoutMs}ms — ${url}` }
        }
        return { contentError: `http: fetch failed (${err.message}) — ${url}` }
    }
    clearTimeout(timer)

    if (res.status === 304 && cached) {
        return cached.payload
    }
    if (!res.ok) {
        return { contentError: `http: ${res.status} ${res.statusText} — ${url}` }
    }

    const mime = res.headers.get('content-type') ?? 'application/octet-stream'
    let payload
    if (isTextMime(mime)) {
        try {
            payload = { content: await res.text() }
        } catch (err) {
            return { contentError: `http: failed to read text body (${err.message}) — ${url}` }
        }
    } else {
        try {
            payload = await mirrorBinary(url, res, mime)
        } catch (err) {
            return { contentError: `http: failed to mirror binary (${err.message}) — ${url}` }
        }
    }

    etagCache.set(url, {
        etag:         res.headers.get('etag') ?? null,
        lastModified: res.headers.get('last-modified') ?? null,
        payload,
    })
    return payload
}

async function mirrorBinary(url, res, mime) {
    const baseFolder = runtime?.options?.runtimeFolder
        ?? path.join(runtime?.options?.workingFolder ?? '.', 'runtime')
    const cacheFolder = path.join(baseFolder, 'http-cache')
    await mkdir(cacheFolder, { recursive: true })

    const hash = createHash('sha256').update(url).digest('hex').slice(0, 16)
    const ext  = extFromMime(mime, url)
    const cachePath = path.join(cacheFolder, `${hash}.${ext}`)

    const bytes = Buffer.from(await res.arrayBuffer())
    await writeFile(cachePath, bytes)

    return {
        contentSkipped: `http: binary mirrored to ${cachePath}. Read directly via that path or set entity.uri to it for filesystem dispatch.`,
        cachedAt: cachePath,
    }
}

// Test affordance — readEntityContent unit tests clear the inflight +
// etag caches between scenarios. Module-level state would otherwise
// leak across the describe blocks.
export function __resetHttpCacheForTests() {
    etagCache.clear()
    inflight.clear()
}
