import { readFileSync } from 'node:fs'
import path from 'node:path'
import { globbySync } from 'globby'
import picomatch from 'picomatch'

// Filesystem helpers a template can call, and the dependency each one creates.
//
// A template that reads a file depends on that file. Until these recorded it,
// the render's refClosure named none of what it read, so editing the file
// rebuilt nothing and the output went quietly stale — the same hole lookupHref
// had before it started recording, and the same failure: a green build and a
// site that is wrong.
//
// So every read records an edge by default. The asymmetry decides it: not
// recording fails silently and is found weeks later by a person; over-recording
// costs one rebuild nobody notices. Pass `{ track: false }` for a read that
// genuinely is not a dependency.
//
// WHAT is recorded differs per helper, and the difference matters:
//
//   readFile / jsonFile record the resolved PATH. One file, one edge.
//
//   glob records the PATTERN, not the paths it matched. Recording the matches
//   would rebuild when a matched file changes but NOT when a new file appears,
//   and appearing is half of what a glob is for. A pattern-derived edge covers
//   both, because it is re-evaluated against whatever exists at the time.
//
// Both are `query` edges on `uri`, which is an indexed column — the same
// mechanism a sidecar's findEntities() already uses, rather than a second one.

// Relative to the WORKING FOLDER, not to wherever the process happens to have
// been started. `readFile('styles/base.css')` used to resolve against cwd,
// which quietly worked in development and broke under any launcher that starts
// mikser elsewhere.
//
// The working folder comes from the `options` the engine hands every render
// plugin. Not from `runtime.options` — the `runtime` a render sees is a small
// projection built per render, and it has no options on it.
function resolvePath(workingFolder, file) {
    const name = file?.name ?? file
    if (typeof name !== 'string' || !name.length) return null
    if (path.isAbsolute(name)) return name
    return path.join(workingFolder ?? '.', name)
}

// The entity id a path would have, or null if it could not have one.
//
// Keyed on `id`, NOT on `uri`. It is tempting to match the filesystem path
// against `uri` and it is wrong: `uri` means the source file for a document or
// a layout, but for a `files` entity it is where the file was DEPLOYED to —
// under the output folder. An edge on uri therefore matches nothing for
// exactly the case these helpers are most used for, reading parts out of
// `files/`. Ids are source-relative everywhere, so they are the one key that
// answers the same question for every collection.
function entityIdFor(workingFolder, resolved) {
    if (!workingFolder || !resolved) return null
    const rel = path.relative(workingFolder, resolved)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
    return '/' + rel.split(path.sep).join('/')
}

// Whether an entity could exist for this path at all.
//
// mikser can only invalidate on entities: a file under no source folder is not
// watched, has no entity, and no edge can bring it back. That limit is fine —
// what is not fine is it being invisible, because "tracked it" and "there was
// nothing to track" read identically from a template. Said once per path.
const warnedOutside = new Set()
function warnIfUntrackable(options, resolved, logger) {
    // Every folder whose files become entities, as recorded by useSource when
    // it registered them — NOT a list written here.
    //
    // The first version of this hardcoded five content folders, and a project
    // registering its own collections through sources() has more than five. On
    // one real site that meant 63 warnings per build, one for every stylesheet and
    // script, all of them tracked correctly and every one of them saying the
    // opposite. Which is worse than not warning: 63 spurious lines a build
    // teaches you to filter the channel, and the filtered-out line is the real
    // one.
    const folders = Object.values(options?.sourceFolders ?? {})
    // Nothing registered yet means nothing can be concluded. Silence is the
    // only honest answer — the previous shape guessed instead.
    if (!folders.length) return
    if (folders.some(folder => !path.relative(folder, resolved).startsWith('..'))) return
    if (warnedOutside.has(resolved)) return
    warnedOutside.add(resolved)
    logger?.warn?.({ code: 'untracked-file-read' },
        'A template read %s, which is outside every folder mikser takes entities from — so it has no entity, '
        + 'nothing watches it, and changing it will NOT rebuild the pages that read it. Register the folder '
        + 'with sources() if that matters, or pass { track: false } to say the staleness is intended.', resolved)
}

export function load({ runtime, options, track, logger }) {
    const workingFolder = options?.workingFolder
    const record = (resolved, opts) => {
        if (opts?.track === false || !resolved) return
        warnIfUntrackable(options, resolved, logger)
        const id = entityIdFor(workingFolder, resolved)
        if (id) track?.query?.({ id })
    }

    runtime.readFile = (file, opts) => {
        const resolved = resolvePath(workingFolder, file)
        record(resolved, opts)
        return readFileSync(resolved, { encoding: 'utf8' })
    }
    runtime.jsonFile = (file, opts) => {
        const resolved = resolvePath(workingFolder, file)
        record(resolved, opts)
        return JSON.parse(readFileSync(resolved, { encoding: 'utf8' }))
    }

    // `globby.sync` does not exist — the export is `globbySync`, so every call
    // here threw TypeError. Loudly, at least, which is why nobody had stale
    // output from it: the helper simply never worked.
    runtime.glob = (pattern, opts = {}) => {
        const patterns = (Array.isArray(pattern) ? pattern : [pattern]).filter(Boolean)
        const base = opts.cwd ?? workingFolder ?? '.'
        const resolved = patterns.map(p => (path.isAbsolute(p) ? p : path.join(base, p)))

        if (opts.track !== false && track?.query) {
            for (const p of resolved) {
                // The PATTERN as a regex over entity ids, so a file that did
                // not exist when this render ran still matches once it appears
                // — which recording the matched paths could never do.
                const idPattern = entityIdFor(workingFolder, p)
                if (!idPattern) continue
                try {
                    track.query({ id: { $regex: picomatch.makeRe(idPattern).source } })
                } catch { /* an unparseable pattern records nothing; the glob still runs */ }
            }
        }
        return globbySync(resolved, { ...opts, cwd: undefined })
    }

    // Stringify an arbitrary value as a JSON literal. Use with the
    // triple-stash form ({{{json …}}}) when embedding inside a
    // <script> block or HTML attribute — Handlebars's HTML-escape
    // would otherwise turn quotes into &quot; and break the literal.
    //
    //   <script>const id = {{{json document.id}}};</script>
    //
    // No SafeString wrap on purpose — that would silently make
    // double-stash also output raw, which is the foot-gun when the
    // template author thought they were getting escaping.
    runtime.json = (value) => JSON.stringify(value)

    // Build an array from positional args. Lets a template construct
    // an empty array ({{array}}) or a literal list ({{array 1 2 3}})
    // without a custom helper. Handy as the fallback value in
    // expressions like (default document.meta.tags (array)).
    //
    // Handlebars passes a trailing `options` object to every helper
    // call; we strip it so the array doesn't end up with a stray
    // hash/data/fn object as its last element.
    runtime.array = (...args) => {
        if (args.length && typeof args[args.length - 1] === 'object'
            && args[args.length - 1] !== null
            && 'hash' in args[args.length - 1]) {
            args = args.slice(0, -1)
        }
        return args
    }
}

export function fileHelpers(options = {}) {
    return { name: options.name ?? 'file', options, load }
}
