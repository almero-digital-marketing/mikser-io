import crypto from 'node:crypto'
import { createHash } from 'node:crypto'
import { hashFile } from 'hasha'
import { stat, lstat, readFile, writeFile, mkdir, unlink, open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import _ from 'lodash'
import { minimatch } from 'minimatch'
import path from 'path'
import fm from 'front-matter'
import yaml from 'yaml'
import { contentType } from 'mime-types'
import runtime from './runtime.js'
import { trackedInfo, untrack, recordReads } from './track.js'

// Stable content fingerprint for entities — used by manifest snapshots,
// engine mutation tracking, and the layouts dispatcher's hash-aware
// seeding. Excludes volatile fields like stamp/time/uri so re-discovery
// on startup doesn't produce a different hash for an unchanged file.
// Pure: synchronous, no I/O, no engine state.
// The payload both `inputHashOf` and `inputPartsOf` describe. One
// definition, because a hash and an attribution of that hash that disagree
// about what went into it is worse than having no attribution.
function inputPayload(entity) {
    return {
        meta: entity.meta ?? null,
        content: entity.content ?? null,
        // The bytes' fingerprint, for entities whose content is not in
        // hand. Files are the reason it cannot be conditioned on `meta`
        // being absent: `files()` stamps meta.url on every file entity,
        // so a file always has meta, and a hash over {meta, content}
        // alone does not move when the bytes on disk change. The file is
        // copied rather than rendered, so that shows up nowhere in the
        // file itself — it freezes the refClosure dep-hash of every
        // dependent, whose skipDecision then always answers "unchanged".
        //
        // Excluded when content IS present: content is then the
        // authoritative copy of the same bytes, and folding in a
        // checksum computed a different way would make the hash depend
        // on how that checksum happens to be derived.
        checksum: entity.content == null ? entity.checksum ?? null : null,
        // `inputs` is how a plugin declares bytes that are NOT part of the
        // entity's own content but that its output depends on. Whatever is
        // put here participates in the hash, so a change to it invalidates
        // every consumer through the normal refClosure path.
        //
        // The case that needed it: a layout's `.js` sidecar. It is the
        // entity's data layer, it is not its content, and it was in no hash
        // at all — so editing it re-rendered nothing, silently, in a fresh
        // build. Moving the layout's gate `checksum` was not enough, because
        // an entity that HAS content is hashed on {meta, content} and its
        // checksum is ignored. This is the seam that was missing.
        inputs: entity.inputs ?? null,
    }
}

export function inputHashOf(entity) {
    if (!entity) return ''
    return crypto.createHash('sha1').update(JSON.stringify(inputPayload(entity))).digest('hex')
}

// Per-component hashes of the same payload, flat and one level deep:
//
//   { 'meta.title': 'ab12cd34', content: '…', 'inputs.shared': '…' }
//
// Recorded alongside the combined hash so a later run can say WHICH input
// moved rather than only that one did. `inputs-changed` on its own sends
// the reader to a database query to answer something already known here.
//
// Components that are null are omitted rather than hashed, so a component
// appearing or disappearing reads as an added or removed key — which is
// the answer in its own right when a document gains front-matter or a
// layout gains a sidecar.
//
// Depth one: naming `meta.title` is the difference between a useful answer
// and "something under meta". Deeper nesting would grow the snapshot for
// diminishing returns — the key names the field to look at, and the field
// is then in front of you.
export function inputPartsOf(entity) {
    if (!entity) return {}
    const parts = {}
    const short = (value) => crypto.createHash('sha1')
        .update(JSON.stringify(value ?? null)).digest('hex').slice(0, 8)
    const payload = inputPayload(entity)
    for (const [component, value] of Object.entries(payload)) {
        if (value == null) continue
        if (component === 'meta' || component === 'inputs') {
            if (typeof value !== 'object' || Array.isArray(value)) {
                parts[component] = short(value)
                continue
            }
            for (const [key, inner] of Object.entries(value)) {
                parts[`${component}.${key}`] = short(inner)
            }
            continue
        }
        parts[component] = short(value)
    }
    return parts
}

// What moved between two part maps. Returns the keys, split by how they
// differ, so a caller can say "content changed" or "meta.title added"
// without re-deriving the comparison.
export function diffInputParts(before, after) {
    const from = before ?? {}
    const to = after ?? {}
    const changed = [], added = [], removed = []
    for (const key of Object.keys(to)) {
        if (!(key in from)) added.push(key)
        else if (from[key] !== to[key]) changed.push(key)
    }
    for (const key of Object.keys(from)) {
        if (!(key in to)) removed.push(key)
    }
    return { changed: changed.sort(), added: added.sort(), removed: removed.sort() }
}

// Canonical lookup variants for an entity — the same four forms the
// schemas plugin, refs subscribers, and the catalog's findRef all use
// to resolve `$author: '/authors/jane'` against an entity at
// `/documents/authors/jane.yml` with `meta.href: '/authors/jane'`.
// Pure: synchronous, no I/O.
//
// MUST stay in lockstep with `refFilter` below, which is the forward
// direction of the same relation. A form present there and missing here
// makes every ref written in that form silently non-invalidating: the
// edge is recorded against the string the author wrote, and nothing the
// target expands to ever matches it. `meta.url` is the one to watch —
// a `$hero: /hero.txt` ref to a served path (ADR-0011) resolves through
// it, while the file entity's id is `/files/hero.txt`.
export function lookupKeys(entity) {
    const id = entity?.id
    if (!id) return []
    const keys = [id]
    if (entity.meta?.href) keys.push(entity.meta.href)
    if (entity.meta?.url) keys.push(entity.meta.url)
    if (typeof id === 'string') {
        const stripped = id.replace(/\.[^./]+$/, '')
        if (stripped !== id) keys.push(stripped)
    }
    return keys
}

// Predicate inverse of `lookupKeys`: does `entity` answer to `refValue`
// via any of the four canonical forms? Used by anywhere a per-entity
// JS test of "does this match the ref" is needed without going through
// the catalog (e.g. testing an in-hand entity).
//
// For *querying* the catalog by ref, use `refFilter(refValue)` and
// pass the result to `findEntities` / `findEntity` — that keeps the
// query as a structured sift filter that storage engines can index
// instead of forcing a full scan.
export function matchesRef(entity, refValue) {
    if (!entity || typeof refValue !== 'string') return false
    if (entity.id === refValue) return true
    if (entity.meta?.href === refValue) return true
    if (entity.meta?.url === refValue) return true
    if (typeof entity.id === 'string' && entity.id.replace(/\.[^./]+$/, '') === refValue) return true
    return false
}

// Structured sift filter equivalent of `matchesRef`. Matches an entity
// when its id, its meta.href, OR its id-minus-trailing-extension equals
// `refValue`. The third clause uses a regex anchored at `refValue` and
// matching exactly one trailing extension — the sift form of
// `id.replace(/\.[^./]+$/, '') === refValue`.
//
// Keep in lockstep with `matchesRef` above. If you change one, change
// both — tests cover the symmetry.
export function refFilter(refValue) {
    if (typeof refValue !== 'string') return { id: '__never__' }
    const escaped = refValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return {
        $or: [
            { id: refValue },
            { 'meta.href': refValue },
            // Served path (ADR-0011): a $-ref to a file/resource is the URL
            // content authors (`/img/x.jpg`, `/media/clip.mp4`), which is the
            // entity's meta.url — not its collection-prefixed id. Indexed.
            { 'meta.url': refValue },
            { id: { $regex: `^${escaped}\\.[^./]+$` } },
        ],
    }
}

// Extension → mime type lookup for rendered outputs. Used anywhere an
// entity's destination is being served over HTTP (the api plugin's
// /render endpoint, the preview plugin's /preview route, anywhere
// else that produces Content-Type from an entity). Pure function; no
// engine state — lives here rather than inside one plugin so other
// plugins don't have to reach across the plugin folder for it.
// Content types come from `mime-types` — the IANA registry via mime-db —
// rather than the nineteen-entry table this used to carry. That table was
// wrong by omission for everything it had not been taught: a .woff2, .avif,
// .wasm, .ico or .mp3 in the output got no content type at all, and a caller
// serving it had to guess.
//
// One deliberate change came with the swap: `.js` is `text/javascript`, which
// RFC 9239 made the registered type and `application/javascript` obsolete.
// Browsers have accepted both for years.
function mimeForExtension(ext) {
    const type = contentType(ext)
    if (!type) return null
    // mime-db assigns charsets from its own `charset` field, which the XML
    // family does not carry — so `application/rss+xml` came back bare where
    // the old table said `; charset=utf-8`. Restored as a RULE about XML
    // rather than as four more rows to keep. Deliberately not applied to
    // `image/svg+xml`, which the old table also served without a charset.
    return /charset=/i.test(type) || !/^application\/(xml$|.*\+xml$)/.test(type)
        ? type
        : `${type}; charset=utf-8`
}

export function mimeForEntity(entity) {
    if (!entity?.destination) return null
    return mimeForExtension(path.extname(entity.destination).toLowerCase())
}

// File-extension allowlist for "is this source readable as utf8?". Used
// by callers that want to gate file reads on text-shaped formats — e.g.
// MCP tools deciding whether to attach `entity.content` or return a
// hint to use the render API instead. The catalog itself does NOT gate
// (`readEntity({include:['content']})` unconditionally reads as utf8) —
// gating is the caller's choice, this helper just centralises the set
// so every gating consumer agrees on what "text" means.
const TEXT_EXTENSIONS = new Set([
    'md', 'markdown', 'html', 'htm', 'xhtml',
    'yml', 'yaml', 'json', 'jsonc',
    'txt', 'csv', 'tsv',
    'css', 'js', 'mjs', 'cjs', 'ts',
    'liquid', 'hbs', 'handlebars', 'eta', 'mustache',
    'svg', 'xml', 'mjml', 'rss', 'atom',
    'aml',
])

// True when the entity's source URI has a text-shaped extension.
// Returns false for binaries (png/pdf/mp4/etc.) and for entities
// without a uri. Pass the entity, not a bare extension — keeps the
// call site readable and lines up with mimeForEntity's signature.
//
// A HINT, not a verdict. The list above is hand-maintained, so it is wrong
// about every extension nobody has added yet — `.njk`, `.scss`, `.toml`, and
// `.ect`, which is an engine mikser itself ships a renderer for. Anything
// deciding whether content can be READ should ask looksTextual about the
// bytes instead; this stays for callers that want a cheap guess with no I/O.
export function isTextEntity(entity) {
    if (!entity?.uri) return false
    const ext = path.extname(entity.uri).slice(1).toLowerCase()
    return TEXT_EXTENSIONS.has(ext)
}

// How much of a file is enough to tell text from binary. A binary format that
// hides every NUL and every invalid sequence for 8KB is not one anybody
// stores in a content repository.
const SNIFF_BYTES = 8 * 1024

// Is this text? Asked of the BYTES, not of the extension.
//
// An extension allowlist is a list that goes stale silently, and it fails in
// the direction that costs most: it refuses a file it has no opinion about.
// That is how reading a `.liquid` template — from an engine that renders
// Liquid — came back "Non-text format".
//
// Bytes do not go stale. A file with no NUL that decodes as UTF-8 is text,
// whether it is Nunjucks, TOML, SQL or something nobody has written yet.
export function looksTextual(buf) {
    if (buf.includes(0)) return false
    try {
        new TextDecoder('utf8', { fatal: true }).decode(trimPartialTail(buf))
        return true
    } catch {
        return false
    }
}

// Drop a trailing codepoint a bounded read cut in half — and ONLY that.
//
// The tempting version retries the decode while chopping bytes off the end
// until it succeeds. That also chops away genuinely corrupt bytes: `74 65 78
// 74 C3 28` is invalid UTF-8, but drop two bytes and `text` decodes clean, so
// a JPEG whose tail happens to be bad reads as text. The tail is forgiven only
// when it is a valid multi-byte sequence that has not finished yet.
function trimPartialTail(buf) {
    // A lead byte is 11xxxxxx and starts a sequence of a known length; the
    // bytes after it are continuations, 10xxxxxx. Walk back over at most 3
    // continuations — a 4-byte sequence is the longest UTF-8 has.
    for (let back = 1; back <= 4 && back <= buf.length; back++) {
        const byte = buf[buf.length - back]
        if (byte < 0x80) return buf                       // ASCII: nothing pending
        if ((byte & 0xc0) === 0x80) continue              // continuation, keep walking
        const expected = (byte & 0xe0) === 0xc0 ? 2
                       : (byte & 0xf0) === 0xe0 ? 3
                       : (byte & 0xf8) === 0xf0 ? 4
                       : 0                                // not a lead byte at all
        // `back` bytes run from the lead to the end. Fewer than the sequence
        // needs means it was cut; anything else is complete, or corrupt, and
        // corrupt is the decoder's call to make rather than ours.
        return expected && back < expected ? buf.subarray(0, buf.length - back) : buf
    }
    return buf
}

// Read the first `limit` bytes of a file, for sniffing.
async function readPrefix(file, limit) {
    const handle = await open(file, 'r')
    try {
        const buf = Buffer.alloc(limit)
        const { bytesRead } = await handle.read(buf, 0, limit, 0)
        return buf.subarray(0, bytesRead)
    } finally {
        await handle.close()
    }
}

// Cache resolved provider modules so we don't re-import per read.
// Keyed by URI scheme — same scheme → same module → same auth state.
const providerModuleCache = new Map()

// Recognise URI schemes (`gdrive://abc123`, `notion://page/X`, `s3://bucket/key`,
// `file:///abs/path`, `http(s)://...`). Plain local paths (`/Users/...`,
// `C:\Users\...`, `./relative`) don't match and fall through to the
// built-in filesystem read.
const URI_SCHEME_RE = /^([a-z][a-z0-9+\-.]*):\/\//i

// Resolve `<scheme>` to the package `mikser-io-provider-<scheme>` and
// import it. Cached per scheme; same package convention as renderers
// (`mikser-io-render-<name>`) and postprocessors (`mikser-io-post-<name>`).
async function loadProviderModule(scheme, workingFolder) {
    if (providerModuleCache.has(scheme)) return providerModuleCache.get(scheme)
    const pkg = `mikser-io-provider-${scheme}`
    let resolved
    try {
        const require = createRequire(path.join(workingFolder ?? process.cwd(), 'package.json'))
        resolved = require.resolve(pkg)
    } catch {
        // Falls back to the import below trying the bare package name —
        // resolves against the engine's own node_modules when the package
        // lives there (workspace, hoisted dep, etc.).
    }
    const mod = await import(resolved ?? pkg)
    providerModuleCache.set(scheme, mod)
    return mod
}

// Read the source bytes for an entity. Returns an object callers
// Object.assign onto the entity (or use directly):
//
//   { content }                   — text content available
//   { contentError: message }     — read failed
//   { contentSkipped: message }   — content not readable as text
//                                   (binary file, oversized blob, ...)
//
// Returns `{}` when the entity itself is null.
//
// Three layers of dispatch:
//
//   1. Fast path: if a source plugin already populated `entity.content`
//      at sync time (small remote docs eager-fetched), use it. No I/O.
//
//   2. Built-in providers (handled inline, no package install needed):
//      - no scheme or `file://`  → src/plugins/providers (filesystem
//        read with the isTextEntity gate)
//      - `http://` / `https://`  → src/plugins/providers/http.js
//        (conditional GET with ETag caching, binary mirror, inflight
//        coalescing)
//
//   3. External providers: any other scheme (`gdrive://`, `notion://`,
//      `s3://`, etc.) → dynamic-import `mikser-io-provider-<scheme>`
//      (same naming convention as `mikser-io-render-*` and
//      `mikser-io-post-*`) and call its exported `read(entity)`.
//      Provider plugins initialize their auth/state via their own
//      onLoaded hook; module-level state survives between the
//      lifecycle setup and the read call.
//
// Usage:
//
//   Object.assign(entity, await readEntityContent(entity))
export async function readEntityContent(entity, { reload = false } = {}) {
    if (!entity) return {}
    // The fast path exists to avoid re-FETCHING a remote document a source
    // plugin already pulled in, and it short-circuits before any of the
    // dispatch below. That makes it a correctness problem for a caller asking
    // to see the SOURCE: between builds the catalog copy and the file on disk
    // part ways, and this handed back the catalog's — under a name that says
    // it read the file. An agent then rewrites the whole file from a version
    // it never saw, silently discarding whatever changed underneath it.
    //
    // `reload` is how a caller says it wants the bytes as they are now. An
    // entity with no uri has nothing fresher to offer, so it keeps what it
    // has rather than falling through to an error.
    if (typeof entity.content === 'string' && (!reload || !entity.uri)) return { content: entity.content }
    if (!entity.uri) return { contentError: 'entity has no uri' }

    const m = URI_SCHEME_RE.exec(entity.uri)
    const scheme = m?.[1].toLowerCase()

    // Built-in HTTP/HTTPS provider — ships in core because every
    // mikser project might consume a public URL (CSV pull, RSS feed,
    // remote config) and fetch is in Node 18+ already.
    if (scheme === 'http' || scheme === 'https') {
        const { readHttpEntity } = await import('./plugins/providers/http.js')
        return await readHttpEntity(entity)
    }

    // Built-in filesystem read: no scheme (plain path) or `file://`.
    if (!scheme || scheme === 'file') {
        const target = scheme === 'file' ? entity.uri.replace(/^file:\/\//i, '') : entity.uri
        try {
            // Decided by the bytes, not by the extension. The extension list
            // refused `.njk`, `.scss`, `.toml` and `.ect` — the last of which
            // mikser ships a renderer for — so reading a layout depended on
            // which engine it happened to be written in.
            if (!looksTextual(await readPrefix(target, SNIFF_BYTES))) {
                const ext = path.extname(entity.uri).slice(1).toLowerCase()
                return {
                    contentSkipped: `Not text${ext ? ` (.${ext})` : ''} — the bytes are binary, not an unrecognised `
                        + 'extension. Read the file directly at entity.uri, or use a render API to materialize output.',
                }
            }
            return { content: await readFile(target, 'utf8') }
        } catch (err) {
            return { contentError: err.message }
        }
    }

    // External provider via package naming convention.
    let providerMod
    try {
        providerMod = await loadProviderModule(scheme, runtime?.options?.workingFolder)
    } catch (err) {
        return { contentError: `Provider "${scheme}" not installed (mikser-io-provider-${scheme}): ${err.message}` }
    }
    if (typeof providerMod?.read !== 'function') {
        return { contentError: `Provider "mikser-io-provider-${scheme}" must export a \`read(entity)\` function` }
    }
    try {
        return await providerMod.read(entity)
    } catch (err) {
        return { contentError: `Provider "${scheme}" threw: ${err.message}` }
    }
}

// True when `ip` is a loopback address. Handles all three forms:
//   - IPv4: anything in 127.0.0.0/8
//   - IPv6: ::1
//   - IPv4-mapped-in-IPv6: ::ffff:127.x.y.z (what dual-stack stacks return)
//
// Used by mikser's auth middleware to honor the "loopback connections are
// trusted; non-loopback connections must authenticate" rule across plugins.
// Pass `req.ip` rather than `req.socket.remoteAddress` — Express's req.ip
// walks `X-Forwarded-For` when trust proxy is configured, which is what
// reveals the real client through a properly-configured reverse proxy.
export function isLoopback(ip) {
    if (!ip || typeof ip !== 'string') return false
    const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip
    if (addr === '::1') return true
    if (addr === '127.0.0.1') return true
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr)
}

// Express middleware factory: 403s any request whose `req.ip` isn't
// loopback. Plugins use this to protect routes that should be reachable
// only from the local machine. Customize the response with `message`.
//
// For more nuanced policies (token gate + loopback fallback), plugins
// usually inline the check using isLoopback() directly — this factory is
// for the simple "this route is local-only, period" case.
export function loopbackOnly({ message = 'Endpoint accepts loopback connections only.' } = {}) {
    return (req, res, next) => {
        if (isLoopback(req.ip)) return next()
        res.status(403).json({ error: message })
    }
}

export class AbortError extends Error {
    constructor(message) {
        super();
        this.name = 'AbortError';
        this.message = message;
    }
}

const CHECKSUM_MAX_BYTES = 300 * 1024

// Checksum from bytes the CALLER ALREADY HAS — no I/O, and therefore no
// second read to disagree with the first.
//
// The hazard this exists to remove: a plugin that stores content does
//
//     meta: { body: await readFile(source, 'utf8') },
//     checksum: await checksum(source),
//
// which is two independent reads of the same file. A watcher firing on the
// truncate half of a write gets '' from readFile while checksum(), a moment
// later, sees the finished file. The entity is stored with an empty body and
// a checksum that is CORRECT FOR THE FINAL CONTENT — so every later sync
// short-circuits on "unchanged" and the empty body is permanent. Only
// --clear recovers it, and nothing anywhere reports a problem.
//
// Byte-compatible with checksum(uri) below, deliberately: the two must be
// interchangeable or swapping a caller over would invalidate its catalog.
export function checksumOf(content) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
    if (buf.length < CHECKSUM_MAX_BYTES) {
        return createHash('md5').update(buf).digest('hex')
    }
    const head = createHash('md5').update(buf.subarray(0, CHECKSUM_MAX_BYTES)).digest('hex')
    const tail = createHash('md5').update(buf.subarray(buf.length - CHECKSUM_MAX_BYTES)).digest('hex')
    return `${buf.length}:${head}:${tail}`
}

// Checksum a file by path.
//
// Files under 300 KB are hashed whole. Larger ones are hashed at both ends
// plus their length, which reads 600 KB instead of gigabytes — the point of
// the truncation is that a 1.4 GB video must not be streamed on every cycle.
//
// The TAIL is new. The previous form was `size + md5(first 300KB)`, which
// silently misses any change beyond byte 307200 that preserves the file's
// length: the checksum matches, the sync reports "unchanged", and the edit
// is dropped exactly as permanently as the torn-read case above. Hashing
// both ends does not make this collision-proof — nothing short of a full
// hash does — but it turns "any late edit of the same length" into
// "a late edit that also collides on 128 bits".
export async function checksum(uri) {
    const { size } = await stat(uri)
    if (size < CHECKSUM_MAX_BYTES) {
        return await hashFile(uri, { algorithm: 'md5' })
    }
    const head = await hashRange(uri, 0, CHECKSUM_MAX_BYTES)
    const tail = await hashRange(uri, size - CHECKSUM_MAX_BYTES, CHECKSUM_MAX_BYTES)
    return `${size}:${head}:${tail}`
}

// md5 of `length` bytes starting at `start`. A positional read, so the
// bytes in between are never touched.
async function hashRange(uri, start, length) {
    const handle = await open(uri, 'r')
    try {
        const buf = Buffer.allocUnsafe(length)
        const { bytesRead } = await handle.read(buf, 0, length, start)
        return createHash('md5').update(buf.subarray(0, bytesRead)).digest('hex')
    } finally {
        await handle.close()
    }
}

export function normalize(object) {
    return _.pickBy(
        object,
        (value, key) => {
            let pick = value !== undefined &&
                value !== '' &&
                value !== null &&
                key !== 'undefined' &&
                key !== '' &&
                key !== 'null' &&
                (typeof (value) != 'number' || !isNaN(value))
            return pick
        }
    )
}

export function matchEntity(entity, match) {
    if (!match) return false
    if (typeof match == 'function') return match(entity)
    else if (typeof match == 'string') {
        if (match.substring(0, 2) == '@/') {
            return minimatch(typeof entity == 'string' ? entity : entity.name, match.substring(2))
        } else {
            return minimatch(typeof entity == 'string' ? entity : entity.id, match)
        }
    }
    else if (typeof match == 'object') return _.isMatch(entity, match)
    throw new Error('Invalid match type')
}

export function changeExtension(file, format) {
    let extension = path.extname(file)
    let result = file.substring(0, file.length - extension.length) + '.' + format
    return result
}

// Decode a layout filename into its parts. `template` is the outer
// extension (the renderer); `format` is the output format encoded as a
// second extension (defaults to 'html'); `postprocessors`, if present,
// is the array of postprocessor names from the format segment (split
// on `-`), threaded as a chain at dispatch time. `postprocessor` is
// the FIRST element of that chain — back-compat alias for code paths
// that only need the head.
//
// Examples:
//   foo.hbs                       -> { name:'foo',     format:'html', template:'hbs',    postprocessors:[],            postprocessor:undefined }
//   page.css.hbs                  -> { name:'page',    format:'css',  template:'hbs',    postprocessors:[],            postprocessor:undefined }
//   report.html-pdf.hbs           -> { name:'report',  format:'html', template:'hbs',    postprocessors:['pdf'],       postprocessor:'pdf' }
//   welcome.html-mjml.liquid      -> { name:'welcome', format:'html', template:'liquid', postprocessors:['mjml'],      postprocessor:'mjml' }
//   newsletter.html-mjml-email.hbs-> { name:'newsletter', format:'html', template:'hbs', postprocessors:['mjml','email'], postprocessor:'mjml' }
export function getFormatInfo(relativePath) {
    const template = path.extname(relativePath).substring(1).toLowerCase()
    const withoutTemplate = relativePath.replace(path.extname(relativePath), '')
    const formatExt = path.extname(withoutTemplate).substring(1).toLowerCase()
    const [format, ...postprocessors] = formatExt.split('-')
    const name = formatExt ? withoutTemplate.replace(path.extname(withoutTemplate), '') : withoutTemplate
    return {
        name,
        format: format || 'html',
        template,
        postprocessors,
        postprocessor: postprocessors[0],
    }
}

// Flatten template-helper args into a single human-readable message.
// Handlebars helpers receive a trailing options object (it has a `.hash`
// property) which we drop. Liquid filters and Eta calls don't.
export function formatLogArgs(args) {
    if (args.length && typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null && 'hash' in args[args.length - 1]) {
        args = args.slice(0, -1)
    }
    return args
        .map(arg => {
            if (arg == null) return String(arg)
            if (typeof arg === 'object') {
                try { return JSON.stringify(arg) } catch { return String(arg) }
            }
            return String(arg)
        })
        .join(' ')
}

// True when `key` is a reference marker per ADR-0007 — a string starting
// with `$` and at least one further character. Bare `$` is treated as a
// regular field name, not a marker, so existing meta that happens to use
// `$` as a key keeps working unchanged.
//
// Pure structural check — no semantic validation, no catalog lookup.
// Validation (does the ref resolve? does the target's layout match?) is
// the schemas plugin's job; see ADR-0007 A6 for the deferred-validation
// model.
export function isRefKey(key) {
    return typeof key === 'string' && key.length > 1 && key.charCodeAt(0) === 36
}

// Recursively project canonical meta into normalized form by stripping the
// `$` prefix from every reference key. Used at the render-context boundary
// and by the SDK to produce a view where templates do `{{ meta.author }}`
// instead of `{{ meta.[$author] }}`.
//
// On collision (both `author:` and `$author:` declared in the same entity),
// the `$`-keyed value wins — ADR-0007 A4. The plain key is dropped from
// the projection but is still visible in the canonical catalog row and in
// the source file. The schemas plugin (if loaded) surfaces the collision
// as a warning naming the entity.
//
// Pure function: returns a new tree; input is not mutated. Strings,
// numbers, booleans, null, and undefined pass through. Arrays are mapped
// element-wise. Objects are rebuilt with normalized keys.
export function projectMeta(meta) {
    if (meta === null || typeof meta !== 'object') return meta
    if (Array.isArray(meta)) return meta.map(projectMeta)
    const out = {}
    // Two passes so `$`-keyed values overwrite plain ones on collision.
    // Iterating once and conditionally overwriting works too, but two
    // passes are simpler to reason about — pass 1 establishes the
    // baseline, pass 2 promotes refs into the same namespace.
    for (const [k, v] of Object.entries(meta)) {
        if (!isRefKey(k)) out[k] = projectMeta(v)
    }
    for (const [k, v] of Object.entries(meta)) {
        if (isRefKey(k)) out[k.slice(1)] = projectMeta(v)
    }
    return out
}

// Walk `meta` and return every reference declaration — any `$`-keyed field
// whose value is a string, or whose value is an array containing strings.
// `$`-keys with other value shapes (numbers, plain objects, etc.) are
// skipped here; the schemas plugin walks meta itself when it needs to
// surface shape warnings.
//
// Returns an array of { path, ref } where `path` is a dotted string
// locating the reference inside `meta` — for example `$author`,
// `seo.$ogImage`, or `sections.0.$image`. Indexes are used for array
// positions so the path uniquely identifies one ref site.
//
// Pure: does not consult the catalog. Resolution is the caller's job.
export function extractRefs(meta) {
    const refs = []
    walk(meta, '')
    return refs

    function walk(node, prefix) {
        if (node === null || typeof node !== 'object') return
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                walk(node[i], prefix ? `${prefix}.${i}` : String(i))
            }
            return
        }
        for (const [k, v] of Object.entries(node)) {
            const path = prefix ? `${prefix}.${k}` : k
            if (isRefKey(k)) {
                if (typeof v === 'string') {
                    refs.push({ path, ref: v })
                } else if (Array.isArray(v)) {
                    for (let i = 0; i < v.length; i++) {
                        if (typeof v[i] === 'string') {
                            refs.push({ path: `${path}.${i}`, ref: v[i] })
                        }
                    }
                }
                // Other shapes are invalid; the schemas plugin warns.
            } else {
                walk(v, path)
            }
        }
    }
}

// Read-modify-write helper for entity source files. Reads the file at
// `entity.uri`, parses front-matter (if any), merges `patch` into the
// parsed attributes, re-serializes, writes back. Used by plugins that
// mutate entities programmatically — refs.rename's cascade is the
// primary consumer today; future PATCH-style api and auto-fix tooling
// land on the same primitive.
//
// The patch is applied LITERALLY. Caller is responsible for using the
// canonical key form they want on disk:
//
//   await writeEntity(entity, { $author: '/authors/dick-marinov' })
//   await writeEntity(entity, { title: 'New title', draft: null })
//
// Per ADR-0007, reference keys live with the `$` prefix on disk. A patch
// that writes a ref field must use the `$`-prefixed key. The helper does
// not infer `author` → `$author` from existing meta — that would mean
// "your patch's behavior depends on hidden state," which is exactly the
// kind of magic that turns into bugs months later.
//
// `null` values in the patch remove that key from the frontmatter:
//
//   await writeEntity(entity, { draft: null })
//
// Body content (everything after the closing `---`) is preserved verbatim.
// Other meta fields are preserved.
//
// If the source file doesn't exist (ENOENT), the helper writes a fresh
// file using the patch as the entire frontmatter. Any other read error
// propagates so callers see the real problem.
//
// Returns the absolute path that was written. The watcher will see the
// change just like any external edit — the entity re-enters the lifecycle
// naturally on the next cycle.
export async function writeEntity(entity, patch = {}) {
    if (!entity?.uri) {
        throw new Error('writeEntity: entity.uri is required')
    }

    let currentMeta = {}
    let body = ''
    try {
        const content = await readFile(entity.uri, 'utf8')
        if (fm.test(content)) {
            const parsed = fm(content)
            currentMeta = parsed.attributes ?? {}
            body = parsed.body ?? ''
        } else {
            body = content
        }
    } catch (err) {
        if (err.code !== 'ENOENT') throw err
        // Fresh file — start from an empty meta + body.
    }

    const newMeta = { ...currentMeta }
    for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete newMeta[k]
        else newMeta[k] = v
    }

    let newContent
    if (Object.keys(newMeta).length > 0) {
        // yaml.stringify always emits a trailing newline.
        const yamlStr = yaml.stringify(newMeta)
        newContent = `---\n${yamlStr}---\n${body}`
    } else {
        // No meta left — write just the body. Avoids `---\n---\n<body>`
        // shells that some tooling treats as "broken frontmatter."
        newContent = body
    }

    await mkdir(path.dirname(entity.uri), { recursive: true })
    await writeFile(entity.uri, newContent, 'utf8')
    // The other file-writing primitive. A rename cascade rewrites every
    // referring file through here, which is the largest fan-out any single
    // request has and therefore the one most worth being able to take back.
    runtime.recordChangeSetWrite?.({ uri: entity.uri })

    return entity.uri
}

// Expansion error — thrown by `expandEntity` when an `expand` request
// violates a structural cap (maxDepth, maxPaths, maxResolved). The
// `status` field is the HTTP code the api plugin returns. Per ADR-0007
// B6, missing targets and cycles do NOT throw; the ref string is left
// in place at the deepest position where resolution stopped.
export class ExpandError extends Error {
    constructor(message) {
        super(message)
        this.name = 'ExpandError'
        this.status = 422
    }
}

// Inline-expand reference fields in `entity.meta` per ADR-0007 B1-B7.
// Each entry in `paths` is a dotted path that walks through meta. At
// `$`-keyed fields the ref string is replaced with the resolved entity
// (looked up via `options.findRef`); intermediate non-`$` fields are
// just navigation; `*` iterates arrays. Both canonical (`$author`) and
// normalized (`author`) path segments are accepted.
//
// Caps surface as ExpandError (status 422):
//   - maxDepth    — single-path length, default 5
//   - maxPaths    — number of entries in `paths`, default 20
//   - maxResolved — unique entity resolutions per call, default 100
//
// Missing targets and cycles do NOT throw — per ADR-0007 B6 the ref
// stays as a string at the deepest resolved position. Consumers see
// "string at expected expansion point" as the signal to re-fetch or
// surface a warning.
//
// Returns a deep clone of `entity` with expansions applied in canonical
// form (`$`-keys preserved on disk shape). The api layer applies
// `projectMeta` after to produce the normalized response.
export async function expandEntity(entity, paths, options = {}) {
    const {
        findRef,
        maxDepth = 5,
        maxPaths = 20,
        maxResolved = 100,
    } = options

    if (!Array.isArray(paths) || paths.length === 0) return entity
    if (paths.length > maxPaths) {
        throw new ExpandError(
            `expand has ${paths.length} paths, exceeds maxPaths (${maxPaths})`,
        )
    }
    if (typeof findRef !== 'function') {
        throw new Error('expandEntity: options.findRef is required')
    }

    // Deep clone so the caller's entity (typically the catalog row) is
    // never mutated. `structuredClone` is in Node since 17.
    //
    // Unwrapped first. A sidecar is handed a read-recording view of its
    // entity's meta so the engine can see which keys it consumes, and that view
    // is a Proxy — which structuredClone rejects outright, because it copies
    // internal slots and a proxy has none. Cloning the raw data instead keeps
    // both properties that are in tension here: the caller's entity is still
    // never mutated, and unwrapping reads nothing through the view, so no key
    // is recorded as consumed merely because it was copied.
    const tracked = trackedInfo(entity?.meta)
    const result = structuredClone(untrack(entity))
    if (!result?.meta || typeof result.meta !== 'object') return result

    const ctx = {
        findRef,
        seen: new Set([entity?.id].filter(Boolean)),
        resolved: 0,
        max: maxResolved,
    }

    for (const pathStr of paths) {
        const parts = pathStr.split('.').filter(Boolean)
        if (parts.length === 0) continue
        if (parts.length > maxDepth) {
            throw new ExpandError(
                `Path '${pathStr}' has length ${parts.length}, exceeds maxDepth (${maxDepth})`,
            )
        }
        await walkExpandPath(result.meta, parts, ctx)
    }

    // Re-applied, so a sidecar reading from the EXPANDED copy is still
    // recorded. Without this the feature would quietly stop working for any
    // sidecar that expands refs — which is most of them — because the reads
    // that matter happen on what expandEntity returns, not on what it was
    // given.
    if (tracked && result?.meta && typeof result.meta === 'object') {
        result.meta = recordReads(result.meta, tracked.path, tracked.record)
    }
    return result
}

// Collect every `$`-ref site reachable under `node` by walking plain
// structure (objects + arrays). Stops AT ref keys — a ref's value is the
// next graph hop's concern, not descended here. Returns { container, key,
// value } so the caller can resolve and replace in place. Powers the `$`
// expand wildcard.
function collectRefSites(node, out = []) {
    if (node === null || typeof node !== 'object') return out
    if (Array.isArray(node)) {
        for (const item of node) collectRefSites(item, out)
        return out
    }
    for (const [k, v] of Object.entries(node)) {
        if (isRefKey(k)) out.push({ container: node, key: k, value: v })
        else collectRefSites(v, out)
    }
    return out
}

async function walkExpandPath(node, parts, ctx) {
    if (parts.length === 0) return
    if (node === null || typeof node !== 'object') return

    const [head, ...tail] = parts

    if (head === '*') {
        if (Array.isArray(node)) {
            for (const item of node) {
                await walkExpandPath(item, tail, ctx)
            }
        }
        return
    }

    // `$` wildcard: expand EVERY `$`-ref reachable by walking this node's
    // structure (recursively through plain objects/arrays), one graph hop
    // each. A tail applies to each resolved entity, so `$.$.$` walks the
    // resolved graph deeper. Structure-agnostic — the caller declares that
    // it wants refs resolved, not where they sit. Bounded by maxResolved
    // (and maxDepth caps the chain length); explicit, so the cost is visible
    // at the call site (ADR-0007).
    if (head === '$') {
        for (const site of collectRefSites(node)) {
            if (typeof site.value === 'string') {
                await expandSingleRef(site.container, site.key, site.value, tail, ctx)
            } else if (Array.isArray(site.value)) {
                await expandArrayRef(site.container, site.key, site.value, tail, ctx)
            }
        }
        return
    }

    // Accept both canonical (`$author`) and normalized (`author`) path
    // segments per ADR-0007 B3. If the caller used `$author`, look for
    // exactly that key; if they used `author`, prefer `$author` (the
    // canonical-on-disk form) and fall back to `author` only when the
    // entity stores it un-marked.
    const dollarKey = head.startsWith('$') ? head : `$${head}`
    const plainKey  = head.startsWith('$') ? head.slice(1) : head

    let key, value
    if (Object.prototype.hasOwnProperty.call(node, dollarKey)) {
        key = dollarKey; value = node[dollarKey]
    } else if (Object.prototype.hasOwnProperty.call(node, plainKey)) {
        key = plainKey; value = node[plainKey]
    } else {
        return // path doesn't exist on this branch — silently skip
    }

    const keyIsRef = key === dollarKey
        || (typeof key === 'string' && key.length > 1 && key.charCodeAt(0) === 36)

    if (keyIsRef) {
        if (typeof value === 'string') {
            await expandSingleRef(node, key, value, tail, ctx)
        } else if (Array.isArray(value)) {
            await expandArrayRef(node, key, value, tail, ctx)
        } else if (value && typeof value === 'object') {
            // Already-expanded entity (from an earlier path in this
            // request). Recurse into its meta if there's more to do.
            if (tail.length > 0 && value.meta) {
                await walkExpandPath(value.meta, tail, ctx)
            }
        }
        return
    }

    // Plain navigation field — descend if there's tail.
    if (tail.length > 0) {
        await walkExpandPath(value, tail, ctx)
    }
}

async function expandSingleRef(node, key, ref, tail, ctx) {
    if (ctx.seen.has(ref)) return                 // cycle — leave as string
    const resolved = await ctx.findRef(ref)
    if (!resolved) return                         // missing target — leave as string
    ctx.resolved++
    if (ctx.resolved > ctx.max) {
        throw new ExpandError(
            `Resolution count ${ctx.resolved} exceeds maxResolved (${ctx.max})`,
        )
    }
    // Clone the resolved entity before placing it in the result tree.
    // findRef typically returns a reference to the catalog row; without
    // the clone, subsequent expansions would mutate the catalog.
    const resolvedCopy = structuredClone(untrack(resolved))
    node[key] = resolvedCopy
    if (tail.length > 0 && resolvedCopy.meta) {
        const childCtx = { ...ctx, seen: new Set([...ctx.seen, ref]) }
        await walkExpandPath(resolvedCopy.meta, tail, childCtx)
        ctx.resolved = childCtx.resolved
    }
}

async function expandArrayRef(node, key, refs, tail, ctx) {
    const out = []
    for (const ref of refs) {
        if (typeof ref !== 'string') { out.push(ref); continue }
        if (ctx.seen.has(ref))       { out.push(ref); continue }
        const resolved = await ctx.findRef(ref)
        if (!resolved) { out.push(ref); continue }
        ctx.resolved++
        if (ctx.resolved > ctx.max) {
            throw new ExpandError(
                `Resolution count ${ctx.resolved} exceeds maxResolved (${ctx.max})`,
            )
        }
        // Clone — same reasoning as expandSingleRef.
        const resolvedCopy = structuredClone(untrack(resolved))
        if (tail.length > 0 && resolvedCopy.meta) {
            const childCtx = { ...ctx, seen: new Set([...ctx.seen, ref]) }
            await walkExpandPath(resolvedCopy.meta, tail, childCtx)
            ctx.resolved = childCtx.resolved
        }
        out.push(resolvedCopy)
    }
    node[key] = out
}

// Build a compact "[layouts/foo.hbs:12:4]" suffix from whatever the
// underlying template engine attached to its thrown error. Renderer
// plugins are expected to set `err.layoutUri` (and optionally `err.line` /
// `err.column`) before rethrowing.
export function formatErrorContext(entity, err, options) {
    const layoutUri = err?.layoutUri || entity?.layout?.uri || entity?.layout?.id
    if (!layoutUri) return ''
    const workingFolder = options?.workingFolder
    const rel = workingFolder && layoutUri.startsWith(workingFolder + '/')
        ? layoutUri.slice(workingFolder.length + 1)
        : layoutUri
    const line = err?.line ?? err?.lineNumber
    const column = err?.column ?? err?.col
    let pos = ''
    if (line) pos = `:${line}${column ? ':' + column : ''}`
    return ` [${rel}${pos}]`
}

/**
 * Bind to a single collection's source folder and return file-level
 * `write` / `remove` operations against it. Each collection plugin sets
 * `runtime.options.<name>Folder` during its onLoaded hook; this looks
 * that up lazily, so it's safe to call useCollection() anywhere after
 * `runtime.start()`.
 *
 * Distinct from `lifecycle.updateEntity` / `lifecycle.deleteEntity` —
 * those write journal entries. These write actual files; in watch mode
 * the resulting fs change is what kicks the next sync→process cycle.
 *
 * @example
 *   const documents = useCollection(runtime, 'documents')
 *   await documents.write('en/draft.md', '# Hi')
 *   await documents.remove('en/old.md')
 *
 * @param {object} runtime         - the mikser runtime singleton
 * @param {string} name            - collection name (e.g. 'documents')
 * @returns {{
 *   name: string,
 *   folder: string,
 *   write(relativePath: string, content?: string): Promise<string>,
 *   remove(relativePath: string): Promise<void>,
 * }}
 */
export function useCollection(runtime, name) {
    function resolveFolder() {
        const folder = runtime?.options?.[`${name}Folder`]
        if (!folder) throw new Error(`Unknown collection: ${name}`)
        return folder
    }

    // A path that cannot leave the collection folder.
    //
    // `path.join(folder, '../../x')` resolves outside the folder and writes
    // there, which turns a collection handle into an arbitrary-write
    // primitive the moment a relative path comes from a request body or a CMS
    // form. Resolved and then contained rather than rejected on a literal
    // `..`, so `a/../b.md` — which lands inside — still works.
    function resolveWithin(relativePath) {
        const folder = resolveFolder()
        const uri = path.resolve(folder, relativePath ?? '')
        const root = path.resolve(folder)
        if (uri !== root && !uri.startsWith(root + path.sep)) {
            throw new Error(
                `Path escapes the ${name} collection: ${JSON.stringify(relativePath)} resolves outside ${root}`)
        }
        return uri
    }

    return {
        name,
        get folder() { return resolveFolder() },
        resolveWithin,

        async write(relativePath, content = '') {
            const uri = resolveWithin(relativePath)
            await mkdir(path.dirname(uri), { recursive: true })
            await writeFile(uri, content, 'utf8')
            // Attributed to whatever change set is in effect, if any. Hooked
            // at the lowest write primitive so a plugin that has never heard
            // of change sets still produces undoable work — the alternative is
            // every writer remembering, and the one that forgets is the one
            // whose edit cannot be taken back.
            runtime.recordChangeSetWrite?.({ uri })
            return uri
        },

        async remove(relativePath) {
            const uri = resolveWithin(relativePath)
            await unlink(uri)
            runtime.recordChangeSetWrite?.({ uri, operation: 'delete' })
        },
    }
}

// Write `bytes` to `file`, unless the file already holds exactly those
// bytes. Returns true if it wrote, false if the file was already correct.
//
// Invalidation is deliberately conservative: an entity that merely READS
// another re-renders when that one changes, because the engine cannot
// know which field was read. That is the right default, and it means
// renders regularly produce byte-identical output. Three things
// downstream key off the file rather than its contents, so writing it
// anyway is not free:
//
//   - live reload watches the output folder, so one edited photograph
//     reloads the browser on every page that merely mentions it
//   - rsync, `aws s3 sync` and most CDN tools compare size plus mtime,
//     so unchanged pages re-upload
//   - `find out -newer` cannot answer "what did this build change?"
//
// The check belongs here rather than in the dependency edges: it covers
// every conservative-invalidation case at once, and stays correct as the
// graph gets more precise instead of becoming redundant.
//
// Ordering matters: the size check comes first so the common
// output-really-changed case never pays for a read, and lstat (not stat)
// because a destination that is currently a SYMLINK has to be replaced
// by a real file even when the bytes behind it match — the type of the
// destination is part of the output, not just its contents.
export async function writeOutput(file, bytes) {
    // Size first, and WITHOUT materialising a buffer: Buffer.byteLength
    // measures a string in place, while Buffer.from copies it (~250µs for
    // a 1MB page, against ~25µs for the lstat). Since a size mismatch is
    // the common outcome on a build that changed something, the cheap
    // path must not pay for the expensive one.
    const size = Buffer.isBuffer(bytes) ? bytes.length : Buffer.byteLength(bytes)
    let identical = false
    try {
        const info = await lstat(file)
        if (info.isFile() && info.size === size) {
            const existing = await readFile(file)
            identical = Buffer.isBuffer(bytes)
                ? bytes.equals(existing)
                : existing.equals(Buffer.from(bytes))
        }
    } catch (err) {
        // Missing or unreadable — fall through and write. Anything else
        // is a bug in this function, and swallowing it would look
        // exactly like "the file wasn't there": a missing `lstat` import
        // made every comparison fail open, so the skip silently never
        // happened while the tests still passed.
        if (err.code !== 'ENOENT' && err.code !== 'EACCES') throw err
    }
    if (identical) return false
    await mkdir(path.dirname(file), { recursive: true })
    // Unlink first so an existing hard link or symlink at this path is
    // broken rather than written through.
    try {
        await unlink(file)
    } catch { /* not there, or not removable — writeFile will say so */ }
    // Pass the original value through — writeFile encodes a string
    // directly, so converting first would add a copy for nothing.
    await writeFile(file, bytes)
    return true
}

// Did this cycle evaluate the whole corpus, or only what changed?
//
// The distinction is what makes a "declared X matched nothing" warning
// worth printing. On an incremental cycle only changed entities are
// re-evaluated, so a pattern or preset legitimately matches nothing in a
// run of two — printing it there means the warning fires on every healthy
// build, and a warning that always fires is one people filter out, taking
// the real instance with it.
//
// True for: --force, a first-run or wiped database, and a cache
// invalidation. Those are exactly the cases where the import gate is
// bypassed and every entity is presented for evaluation.
// Takes the runtime rather than reading the singleton, so a plugin passes
// the one it was injected with — which is the singleton in a real build and
// the harness's stand-in under test.
export function isFullCycle(rt = runtime) {
    return !!(
        rt?.options?.force
        || rt?.options?.firstRun
        || rt?.catalog?.cacheInvalidated
    )
}

// ── operating-system and file-manager litter ────────────────────────────
//
// Exposing a source folder over a network filesystem (mikser-io-drive) or
// simply opening it in a file manager drops metadata files into it. Every one
// of them would otherwise become an entity, render a page, and appear in a
// catalog.
//
// The dot-prefixed ones were already handled by accident: globby defaults to
// `dot: false` and the watcher ignores /[\/\\]\./ — so .DS_Store and ._*
// never got through. The Windows ones are NOT dotfiles, and measurably did:
// Thumbs.db and desktop.ini were both scanned AND watched. That asymmetry is
// the reason this list is explicit rather than a rule about leading dots.
//
// Deliberately conservative: OS and file-manager artifacts only. No *.tmp,
// no *.bak, no editor backups — anything a person might plausibly have meant
// to write stays out, because a filter that silently drops content is worse
// than the litter it prevents.
const JUNK_NAMES = new Set([
    '.DS_Store',                            // macOS Finder, every folder it opens
    '.localized',                           // macOS localised folder marker
    '.VolumeIcon.icns',
    '.com.apple.timemachine.donotpresent',
    'Icon\r',                               // macOS custom folder icon (trailing CR)
    'Thumbs.db',                            // Windows Explorer thumbnail cache
    'ehthumbs.db',
    'ehthumbs_vista.db',
    'desktop.ini',                          // Windows folder customisation
])

const JUNK_DIRS = new Set([
    '.Spotlight-V100', '.Trashes', '.fseventsd', '.TemporaryItems',
    '.DocumentRevisions-V100', '.AppleDouble', '.AppleDB', '.AppleDesktop',
    '$RECYCLE.BIN', 'System Volume Information',
])

const JUNK_PATTERNS = [
    /^\._/,              // macOS AppleDouble resource fork
    /^~\$/,              // Microsoft Office lock/owner file (~$report.docx)
    /^\.~lock\..*#$/,    // LibreOffice lock file
]

// Is this path OS/file-manager litter? Matches on the basename, and on any
// directory segment for the folder-shaped ones — litter inside .Trashes is
// still litter whatever it is called.
export function isJunkPath(filePath) {
    if (typeof filePath !== 'string' || !filePath) return false
    const segments = filePath.split(/[/\\]/)
    const name = segments[segments.length - 1]
    if (!name) return false
    if (JUNK_NAMES.has(name)) return true
    if (JUNK_PATTERNS.some(re => re.test(name))) return true
    return segments.slice(0, -1).some(segment => JUNK_DIRS.has(segment))
}

// The same list as globby ignore patterns, for the scan side.
export const JUNK_IGNORE = [
    ...[...JUNK_NAMES].map(name => `**/${name}`),
    ...[...JUNK_DIRS].map(dir => `**/${dir}/**`),
    '**/._*',
    '**/~$*',
    '**/.~lock.*#',
]

// Plugins contribute their own artifacts.
//
// The built-in list is OS and file-manager litter, and it stays that way —
// the engine has no business knowing what a particular library's sidecar file
// is called. What it can provide is the mechanism: a plugin that writes
// metadata next to content says so, and both the scan and the watcher honour
// it. (mikser-io-drive registers `*.nephelemeta` for exactly this reason:
// the collection-level file is dot-prefixed and was already invisible, while
// the per-file one — `page.md.nephelemeta` — is not, and was measurably
// becoming an entity.)
const registered = { ignore: [], match: [] }

export function registerJunk({ ignore = [], match } = {}) {
    registered.ignore.push(...(Array.isArray(ignore) ? ignore : [ignore]))
    for (const m of (Array.isArray(match) ? match : match ? [match] : [])) {
        if (m instanceof RegExp) registered.match.push((name) => m.test(name))
        else if (typeof m === 'function') registered.match.push(m)
        else throw new Error('registerJunk: `match` must be a RegExp or a function')
    }
}

// `junk: false` in config turns the filter off entirely; an array replaces
// the built-in list. Plugin registrations survive an array override — an
// operator narrowing the OS list did not ask to start importing a library's
// sidecar files.
export function junkIgnore() {
    const configured = runtime.config?.junk
    if (configured === false) return []
    if (Array.isArray(configured)) return [...configured, ...registered.ignore]
    return [...JUNK_IGNORE, ...registered.ignore]
}

export function junkFilter() {
    const configured = runtime.config?.junk
    if (configured === false) return () => false
    if (!registered.match.length) return isJunkPath
    return (filePath) => {
        if (isJunkPath(filePath)) return true
        if (typeof filePath !== 'string') return false
        const name = filePath.split(/[/\\]/).pop()
        return registered.match.some(test => test(name))
    }
}

// Does a value fall under a resources library?
//
// The library key is a REGULAR EXPRESSION source — `resources()` derives it
// with escapeStringRegexp(url), and you only escape a string you are about to
// compile. It has two consumers: the plugin's discovery walk, which decides
// what to download, and the `resource` render helper, which builds the url.
// They read the same string with two different matchers — discovery used a
// GLOB, which demands a full match, so a key derived from `url` (a bare prefix
// with no trailing wildcard) matched nothing. Nothing was ever downloaded for
// a url-declared library, while the helper happily built links to the files
// that were not fetched. Green build, missing images.
//
// One function, so the two cannot drift again.
const libraryPatterns = new Map()
export function matchesLibrary(value, pattern) {
    if (typeof value !== 'string' || !pattern) return false
    if (!libraryPatterns.has(pattern)) {
        let re
        try { re = new RegExp(pattern) }
        // A hand-written `match` that is not valid regex would otherwise throw
        // mid-walk and take the build down.
        catch { re = { test: () => false } }
        libraryPatterns.set(pattern, re)
    }
    return libraryPatterns.get(pattern).test(value)
}
