import crypto from 'node:crypto'
import { hashFile, hash } from 'hasha'
import { stat, readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import TruncateStream from 'truncate-stream'
import { createReadStream } from 'node:fs'
import _ from 'lodash'
import { minimatch } from 'minimatch'
import path from 'path'
import fm from 'front-matter'
import yaml from 'yaml'
import runtime from './runtime.js'

// Stable content fingerprint for entities — used by manifest snapshots,
// engine mutation tracking, and the layouts dispatcher's hash-aware
// seeding. Excludes volatile fields like stamp/time/uri so re-discovery
// on startup doesn't produce a different hash for an unchanged file.
// Pure: synchronous, no I/O, no engine state.
export function inputHashOf(entity) {
    if (!entity) return ''
    // For file-only entities (no meta/content surface) the upstream
    // file-content checksum from `checksum()` above is the authoritative
    // fingerprint and is already computed.
    if (entity.checksum && entity.meta == null && entity.content == null) {
        return crypto.createHash('sha1').update(String(entity.checksum)).digest('hex')
    }
    return crypto.createHash('sha1').update(JSON.stringify({
        meta: entity.meta ?? null,
        content: entity.content ?? null,
    })).digest('hex')
}

// Canonical lookup variants for an entity — the same three forms the
// schemas plugin, refs subscribers, and the catalog's findRef all use
// to resolve `$author: '/authors/jane'` against an entity at
// `/documents/authors/jane.yml` with `meta.href: '/authors/jane'`.
// Pure: synchronous, no I/O.
export function lookupKeys(entity) {
    const id = entity?.id
    if (!id) return []
    const keys = [id]
    if (entity.meta?.href) keys.push(entity.meta.href)
    if (typeof id === 'string') {
        const stripped = id.replace(/\.[^./]+$/, '')
        if (stripped !== id) keys.push(stripped)
    }
    return keys
}

// Predicate inverse of `lookupKeys`: does `entity` answer to `refValue`
// via any of the three canonical forms? Used by anywhere a per-entity
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
const MIME_BY_EXT = {
    pdf:   'application/pdf',
    html:  'text/html; charset=utf-8',
    xml:   'application/xml; charset=utf-8',
    xhtml: 'application/xhtml+xml; charset=utf-8',
    rss:   'application/rss+xml; charset=utf-8',
    atom:  'application/atom+xml; charset=utf-8',
    json:  'application/json; charset=utf-8',
    css:   'text/css; charset=utf-8',
    js:    'application/javascript; charset=utf-8',
    svg:   'image/svg+xml',
    png:   'image/png',
    jpg:   'image/jpeg',
    jpeg:  'image/jpeg',
    webp:  'image/webp',
    gif:   'image/gif',
    mp4:   'video/mp4',
    webm:  'video/webm',
    txt:   'text/plain; charset=utf-8',
    md:    'text/markdown; charset=utf-8',
}

export function mimeForEntity(entity) {
    if (!entity?.destination) return null
    const ext = path.extname(entity.destination).toLowerCase().replace(/^\./, '')
    return MIME_BY_EXT[ext] ?? null
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
export function isTextEntity(entity) {
    if (!entity?.uri) return false
    const ext = path.extname(entity.uri).slice(1).toLowerCase()
    return TEXT_EXTENSIONS.has(ext)
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
export async function readEntityContent(entity) {
    if (!entity) return {}
    if (typeof entity.content === 'string') return { content: entity.content }
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
        if (!isTextEntity(entity)) {
            const ext = path.extname(entity.uri).slice(1).toLowerCase()
            return {
                contentSkipped: `Non-text format (.${ext}). Read the file directly at entity.uri, or use a render API to materialize output.`,
            }
        }
        try {
            const target = scheme === 'file' ? entity.uri.replace(/^file:\/\//i, '') : entity.uri
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

export async function checksum(uri) {
    const maxBytes = 300 * 1024
    const { size } = await stat(uri)
    if (size < maxBytes) {
        return await hashFile(uri, { algorithm: 'md5' })
    } else {
        const truncate = new TruncateStream({ maxBytes })
        const fileStream = createReadStream(uri)
        fileStream.pipe(truncate)
        const checksum = size.toString() + ':' + await hash(truncate, { algorithm: 'md5' })
        return checksum
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
    const result = structuredClone(entity)
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
    const resolvedCopy = structuredClone(resolved)
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
        const resolvedCopy = structuredClone(resolved)
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

    return {
        name,
        get folder() { return resolveFolder() },

        async write(relativePath, content = '') {
            const uri = path.join(resolveFolder(), relativePath)
            await mkdir(path.dirname(uri), { recursive: true })
            await writeFile(uri, content, 'utf8')
            return uri
        },

        async remove(relativePath) {
            const uri = path.join(resolveFolder(), relativePath)
            await unlink(uri)
        },
    }
}