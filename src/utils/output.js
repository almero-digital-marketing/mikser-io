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
