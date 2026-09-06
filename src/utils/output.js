import fm from 'front-matter'
import path from 'path'
import runtime from '../runtime.js'
import yaml from 'yaml'
import { lstat, mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises'

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
// How a source file carries its meta, and how to put it back.
//
// Front matter is one answer, not the answer. A `.yml` or `.json` entity IS
// its meta — there is no body — and treating every file as front-matter did
// not merely format it oddly, it destroyed it: with no `---` to find, the
// whole document was taken as the BODY and the patch written above it as
// fresh front matter. A one-key rename turned a price list into a two-key
// document with the real one quoted underneath as inert text, and nothing
// threw. refs.rename reaches this for every referring entity, which is the
// largest fan-out any single request has.
//
// Registered and dispatched the way provenance registers its readers: last
// registered is checked first, and the catch-all goes in first so it is
// consulted last. A format plugin adds its own without touching this file.
//
//   test(entity, raw)      does this handler own this source?
//   write({ raw, patch })  the complete new file contents
//
// `patch` rather than a merged meta, deliberately: a handler that can edit its
// source in place should be allowed to. The yaml one does, so comments and
// untouched values survive an edit that names one key.
const sourceFormats = []

export function registerSourceFormat(name, { test, write }) {
    if (!name || typeof test !== 'function' || typeof write !== 'function') {
        throw new Error('registerSourceFormat(name, { test, write }) requires all three')
    }
    sourceFormats.unshift({ name, test, write })
    return () => {
        const at = sourceFormats.findIndex(h => h.name === name)
        if (at >= 0) sourceFormats.splice(at, 1)
    }
}

export function sourceFormatFor(entity, raw = '') {
    for (const handler of sourceFormats) {
        try {
            if (handler.test(entity, raw)) return handler
        } catch { /* a handler that throws is a handler that declines */ }
    }
    return sourceFormats[sourceFormats.length - 1]
}

// The format an entity is in, by what the catalog recorded and, failing that,
// by its extension — a caller holding only a uri is one this must still answer
// for.
function formatOf(entity) {
    if (entity?.format) return String(entity.format).toLowerCase()
    return path.extname(entity?.uri ?? '').replace(/^\./, '').toLowerCase()
}

function applyPatch(target, patch) {
    const next = { ...target }
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete next[key]
        else next[key] = value
    }
    return next
}

// A text document with a `---` block, or one that should grow one. Registered
// first, so it is checked last: this is the catch-all.
registerSourceFormat('front-matter', {
    test: () => true,
    write({ raw, patch }) {
        const parsed = fm.test(raw) ? fm(raw) : null
        const body = parsed ? (parsed.body ?? '') : raw
        const meta = applyPatch(parsed?.attributes ?? {}, patch)
        // No meta left — write just the body, rather than a `---`/`---` shell
        // that some tooling reads as broken front matter.
        if (Object.keys(meta).length === 0) return body
        return `---\n${yaml.stringify(meta)}---\n${body}`
    },
})

// A YAML document is meta all the way down.
//
// Patched through the document AST rather than re-serialized, so comments and
// every value the patch does not name survive. Not byte-perfect: the emitter
// re-flows block scalars to its own width, so hand-wrapped prose moves. That
// is a formatting change, where re-serializing would have been a content one.
registerSourceFormat('yaml', {
    // On the format alone. `fm.test` is not a safe second opinion here: a
    // multi-document YAML file has a `---` between its documents and reads as
    // front matter to it, so consulting it sent exactly the files with the
    // most to lose down the wrong path.
    test: (entity) => ['yml', 'yaml'].includes(formatOf(entity)),
    write({ raw, patch }) {
        // Every document, not the first. parseDocument on a multi-document
        // source returns one carrying errors, and stringifying it throws —
        // loud, but it refuses a file it could have patched. The meta belongs
        // to the first document; the rest are copied through untouched.
        const documents = raw.trim() ? yaml.parseAllDocuments(raw) : [yaml.parseDocument('')]
        const target = documents[0]
        for (const [key, value] of Object.entries(patch)) {
            if (value === null) target.deleteIn([key])
            else target.setIn([key], value)
        }
        return documents.map(document => document.toString()).join('')
    },
})

// JSON has no comments to keep and no body to preserve, so this is a plain
// round-trip — but the indent is read off the file rather than imposed, so a
// one-key patch does not reformat every line of a 4-space document.
registerSourceFormat('json', {
    test: (entity) => formatOf(entity) === 'json',
    write({ raw, patch }) {
        const current = raw.trim() ? JSON.parse(raw) : {}
        const indent = raw.match(/^[ \t]+/m)?.[0] ?? '  '
        return JSON.stringify(applyPatch(current, patch), null, indent) + '\n'
    },
})

export async function writeEntity(entity, patch = {}) {
    if (!entity?.uri) {
        throw new Error('writeEntity: entity.uri is required')
    }

    let raw = ''
    try {
        raw = await readFile(entity.uri, 'utf8')
    } catch (err) {
        if (err.code !== 'ENOENT') throw err
        // Fresh file — the handler starts from empty source.
    }
    const newContent = sourceFormatFor(entity, raw).write({ raw, patch, entity })
    await mkdir(path.dirname(entity.uri), { recursive: true })
    await writeFile(entity.uri, newContent, 'utf8')
    // The other file-writing primitive. A rename cascade rewrites every
    // referring file through here, which is the largest fan-out any single
    // request has and therefore the one most worth being able to take back.
    runtime.recordChangeSetWrite?.({ uri: entity.uri })

    return entity.uri
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

// Which declared site root a path belongs to.
//
// A build can emit one subtree per language and deploy each as its own domain
// root, which puts the site root at out/<lang>/ rather than at out/. Nothing
// can derive that — it is a fact about where the bytes get deployed, not about
// the bytes — so it is declared as `siteRoots` and the default is the output
// root itself. Accepts a path with or without a leading slash, because an
// entity destination has one and an output-relative file path does not.
export function siteRootFor(file, roots = []) {
    const relative = String(file ?? '').replace(/^\/+/, '')
    let best = ''
    for (const root of roots) {
        if (!root) continue
        if (relative.startsWith(`${root}/`) && root.length > best.length) best = root
    }
    return best
}

// A page-relative url from one output destination to another, addressed within
// the site the page belongs to.
//
// Both are output-root absolute (`/bg/aparati/index.html`, `/derived/x.webp`),
// which is the only shape the engine has. With one site per build that is also
// the deployed root and this is a plain path.relative. With several, it is not:
// out/bg IS the domain root, so a url computed against out/ carries one extra
// `..` for the language segment. The browser floors that rather than failing,
// which is why it worked and why nothing said so.
//
// Three cases, and the middle one is the reason this is not a one-liner:
//
//   target outside every root   a shared asset. It has to be reachable from
//                               inside this page's site, so it is addressed
//                               there — this is the case that was wrong.
//   target in the same root     already correct; a plain relative path.
//   target in a DIFFERENT root  a cross-site link. On a per-domain deploy the
//                               other site is another origin and no relative
//                               path reaches it. Left as it was, so the
//                               reference check reports it broken instead of
//                               this silently inventing a path that is not.
export function siteRelativeUrl(pageDestination, target, siteRoots = []) {
    const from = path.dirname(pageDestination || '/')
    const pageRoot = siteRootFor(pageDestination, siteRoots)
    if (!pageRoot) return path.relative(from, target)
    if (siteRootFor(target, siteRoots)) return path.relative(from, target)
    return path.relative(from, path.join('/', pageRoot, target))
}
