import _ from 'lodash'
import path from 'path'
import runtime from '../runtime.js'
import yaml from 'yaml'

import { isRefKey } from './refs.js'
import { contentType } from 'mime-types'
import { minimatch } from 'minimatch'
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { missingCollectionWrite } from '../auth.js'

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

// The scheme a uri names, lowercased, or null when it names none.
//
// `null` and `file` both mean the local filesystem — that is the split
// readEntityContent below dispatches on, and anything else asking "is there a
// file here to read" has to make the same distinction. Exported so it is made
// once: mikser_explain used to run a filesystem checksum over `https://...`,
// get ENOENT, and report "source file is gone — a build would DELETE this
// entity", about a healthy entity a provider had fetched.
export function uriScheme(uri) {
    if (typeof uri !== 'string') return null
    return URI_SCHEME_RE.exec(uri)?.[1]?.toLowerCase() ?? null
}

// Does this uri point at something on the local filesystem?
export function isLocalUri(uri) {
    const scheme = uriScheme(uri)
    return scheme === null || scheme === 'file'
}

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
        const { readHttpEntity } = await import('../plugins/providers/http.js')
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
// Refuse a write the acting principal may not make.
//
// Here rather than at each caller, and for the reason the change-set hook one
// line below is here: this is the lowest write primitive, so a plugin that
// has never heard of capabilities is still bounded by them. The alternative
// is every writer remembering, and the one that forgets is the one that
// leaks.
//
// Throws rather than returning a refusal because `write` has no refusal
// channel — it returns a uri — and a caller that ignores a falsy return would
// report success for a write that never happened.
function refuseUnlessMayWrite(collection) {
    const missing = missingCollectionWrite(collection)
    if (!missing) return
    throw new Error(`Refused: writing to ${collection} needs ${missing}, `
        + 'which this credential does not carry.')
}

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
            refuseUnlessMayWrite(name)
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
            refuseUnlessMayWrite(name)
            const uri = resolveWithin(relativePath)
            await unlink(uri)
            runtime.recordChangeSetWrite?.({ uri, operation: 'delete' })
        },
    }
}
