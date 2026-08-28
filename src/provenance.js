// Where a value was WRITTEN — source file, field path, line and column.
//
// The question this answers is "which file, and where in it, produced this
// string in the output?" Until now that was inferred after the fact by
// scanning the source files a render consumed and calling a hit a definition
// when the next structural character was `{`. It works and it is honest about
// being a heuristic, but the engine is guessing at something it knew for
// certain while it was parsing.
//
// An earlier generation of this engine (mikser 4.x/5.x, `plugins/guide.js`)
// solved it properly and format-agnostically: replace a value with a uuid
// token, re-parse the file through the format's OWN parser, find where the
// token landed in the parsed object, then locate the token's row and column in
// the raw text. One implementation covered yml, toml, cson, archieml and front
// matter with no per-format code. It did not survive, and the reason is in its
// own source — it re-parsed the document once PER FIELD, farmed the work to
// worker processes, cached per-document JSON on disk, and still had to catch
// and swallow "RegExp too big" when a value was large enough to blow up the
// wrapping regex.
//
// The trick is not needed for the formats this engine actually reads. `yaml`
// exposes ranges on every node of a parsed document, and YAML is a superset of
// JSON, so ONE parse of the raw text yields the position of every leaf in yml,
// yaml, json and front matter alike — exactly, not by matching text back. That
// is one parse per document instead of one per field, and no regex over the
// value at all.
//
// The uuid substitution remains the right answer for a format whose parser
// gives no ranges. Nothing here needs it today; if a `toml` or `cson` plugin
// lands, that is the shape to reach for rather than hand-rolling positions.
//
// Cost, which is what killed the predecessor:
//
//   - Field PATHS need no parse at all — they come from walking `entity.meta`,
//     which is already in memory. That half is always available.
//   - Line and column need the one parse, and it happens ON DEMAND rather than
//     during the build, cached in `mikser_provenance` and keyed by the
//     entity's checksum. A build pays nothing. The first question about an
//     entity pays one parse. Every later question pays nothing until the file
//     changes.
//
// The table is a derived cache — ADR-0002, the files are the source of truth —
// so it is NOT registered durable and a wipe correctly drops it.

import YAML from 'yaml'
import fm from 'front-matter'
import { randomUUID } from 'node:crypto'
import runtime from './runtime.js'
import { readEntityContent, isTextEntity } from './utils.js'
import { useDatabase, registerSchema } from './database/index.js'

export const PROVENANCE_SCHEMA = `
    CREATE TABLE IF NOT EXISTS mikser_provenance (
        id       TEXT PRIMARY KEY,
        checksum TEXT,
        fields   TEXT
    );
`

registerSchema('mikser_provenance', PROVENANCE_SCHEMA)

// `items[2].label`, matching the path shape flattenMeta and refs_inbound
// already report. Three spellings of the same location would be three
// spellings a caller has to reconcile.
function joinPath(prefix, key, isIndex) {
    if (isIndex) return `${prefix}[${key}]`
    return prefix ? `${prefix}.${key}` : String(key)
}

// Offset → 1-based line, 0-based column. Both are what an editor shows.
function lineColOf(text, offset) {
    let line = 1
    let lineStart = 0
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1 }
    }
    return { line, col: offset - lineStart }
}

// Walk a parsed YAML document, emitting a position for every scalar leaf.
//
// `range[0]` is where the VALUE starts, which is the position worth reporting:
// a caller looking at `label: Козметика` wants the column of the text, not of
// the key.
function walkNode(node, prefix, out, text, baseOffset) {
    if (!node) return
    // YAMLMap
    if (Array.isArray(node.items) && node.items.length && node.items[0]?.key !== undefined) {
        for (const pair of node.items) {
            const key = pair.key?.value ?? pair.key
            if (key === undefined || key === null) continue
            walkNode(pair.value, joinPath(prefix, key, false), out, text, baseOffset)
        }
        return
    }
    // YAMLSeq
    if (Array.isArray(node.items)) {
        node.items.forEach((item, index) => {
            walkNode(item, joinPath(prefix, index, true), out, text, baseOffset)
        })
        return
    }
    // Scalar
    if (node.range && prefix) {
        const { line, col } = lineColOf(text, node.range[0])
        out[prefix] = { line: line + baseOffset, col }
    }
}

// Every leaf position in a YAML or JSON document.
//
// `lineOffset` shifts the result for a block that does not start at line 1 —
// front matter, which begins after the opening delimiter.
export function fieldPositions(text, { lineOffset = 0 } = {}) {
    const out = {}
    if (typeof text !== 'string' || !text.trim()) return out
    try {
        const doc = YAML.parseDocument(text)
        // `parseDocument` RECOVERS from a malformed document rather than
        // throwing — it collects errors and returns its best guess. `YAML.parse`,
        // which is what actually produced `entity.meta`, throws instead. So a
        // document with errors here is one whose positions describe a structure
        // the engine never loaded, and reporting them would point a caller at
        // confidently wrong lines. No positions is the honest answer.
        if (doc.errors?.length) return {}
        walkNode(doc.contents, '', out, text, lineOffset)
    } catch {
        // A file the engine already parsed successfully can still fail here if
        // the plugin that read it was more permissive. No positions is a
        // correct answer; a thrown error from a diagnostic is not.
        return {}
    }
    return out
}

// Locate every leaf of an already-parsed object in the raw text, using only
// the format's OWN parse function.
//
// This is mikser 4.x's `plugins/guide.js` trick, and it is the only thing that
// works for a format whose parser reports no ranges — archieml, toml, cson,
// anything a plugin brings later. Substitute a unique token for a value,
// re-parse, and see where the token lands in the parsed object; the token's
// offset in the text is then the value's position.
//
// Two things are different here, and they are the difference between a
// mechanism that survives and one that does not:
//
//   - ONE parse for the whole document, not one per field. The predecessor
//     re-parsed per leaf, which is why it needed worker processes and a disk
//     cache and still hurt. Every value is tokenized in a single pass first.
//   - Positions are read from where the tokens ACTUALLY landed, not from
//     assuming the substitution matched the field we intended. A value that
//     occurs several times, or that also appears as a key, therefore cannot
//     produce a confidently wrong answer — it either lands somewhere and is
//     believed, or it does not and is omitted.
//
// The predecessor also built a regex per value and had to swallow "RegExp too
// big" when one was large. There is no regex here; substitution is indexOf and
// slice, so a value's size is irrelevant.
export function positionsByProbe(raw, parse, meta) {
    if (typeof raw !== 'string' || typeof parse !== 'function' || !meta) return {}

    // Longest first: replacing a short value could otherwise consume text that
    // belongs to a longer one containing it.
    const leaves = [...flattenLeaves(meta)]
        .filter(([, value]) => typeof value === 'string' && value.length > 0)
        .sort((a, b) => String(b[1]).length - String(a[1]).length)
    if (!leaves.length) return {}

    // Sites are chosen against the ORIGINAL text and the replacement is applied
    // in one pass from the end. Substituting progressively would shift every
    // later offset by the difference between a token's length and the value's,
    // so the recorded position would drift further from the truth with each
    // field — silently, and only for the fields after the first.
    const sites = []
    const taken = []
    for (const [, value] of leaves) {
        const at = findUnconsumed(raw, String(value), taken)
        if (at < 0) continue
        const token = `mkp${randomUUID().replace(/-/g, '')}`
        sites.push({ at, length: String(value).length, token })
        taken.push([at, at + String(value).length])
    }
    if (!sites.length) return {}

    const tokenOffset = new Map(sites.map(site => [site.token, site.at]))
    let text = raw
    for (const site of [...sites].sort((a, b) => b.at - a.at)) {
        text = text.slice(0, site.at) + site.token + text.slice(site.at + site.length)
    }

    let probed
    try {
        probed = parse(text)
    } catch {
        // The substitution produced something the format rejects. No positions
        // is the honest answer — the field paths still stand.
        return {}
    }

    const out = {}
    for (const [path, value] of flattenLeaves(probed)) {
        if (typeof value !== 'string') continue
        const offset = tokenOffset.get(value)
        if (offset === undefined) continue
        const { line, col } = lineColOf(raw, offset)
        out[path] = { line, col }
    }
    return out
}

// First occurrence of `value` that does not overlap an already-substituted
// range, so two identical values get two different tokens.
function findUnconsumed(text, value, consumed) {
    let at = text.indexOf(value)
    while (at >= 0) {
        const end = at + value.length
        if (!consumed.some(([from, to]) => at < to && end > from)) return at
        at = text.indexOf(value, at + 1)
    }
    return -1
}

// Leaves of a plain object/array as [dottedPath, value], sharing joinPath so
// probe results and YAML results spell a location the same way.
export function* flattenLeaves(node, prefix = '') {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) yield* flattenLeaves(node[i], joinPath(prefix, i, true))
        return
    }
    if (typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
            yield* flattenLeaves(value, joinPath(prefix, key, false))
        }
        return
    }
    if (prefix) yield [prefix, node]
}

// How a format turns raw text into positions.
//
// Core registers the three it parses itself. A plugin that brings its own
// format registers here rather than being special-cased in this file — the
// engine has no business knowing archieml exists, and a format that ships in
// its own package should ship its provenance with it.
//
// `test(entity, raw)` picks the handler; `positions(raw, entity)` returns
// `{ path: {line, col} }`. Later registrations win, so a plugin can override
// a built-in for its own extension.
const handlers = []

export function registerProvenanceFormat(name, { test, positions }) {
    if (!name || typeof test !== 'function' || typeof positions !== 'function') {
        throw new Error('registerProvenanceFormat(name, { test, positions }) requires all three')
    }
    handlers.unshift({ name, test, positions })
    return () => {
        const at = handlers.findIndex(h => h.name === name)
        if (at >= 0) handlers.splice(at, 1)
    }
}

// A ready-made registration for any format whose parser gives no ranges.
// Wraps positionsByProbe so a plugin supplies only its own `parse`.
export function probeFormat(name, { test, parse }) {
    return registerProvenanceFormat(name, {
        test,
        positions: (raw, entity) => positionsByProbe(raw, parse, entity?.meta),
    })
}

registerProvenanceFormat('yaml', {
    // Anything the YAML parser handles, which includes JSON. Last resort, so
    // it is registered first and therefore checked last.
    test: () => true,
    positions: (raw) => fieldPositions(raw),
})

registerProvenanceFormat('front-matter', {
    test: (entity, raw) => fm.test(raw),
    positions: (raw) => {
        const info = fm(raw)
        const block = info.frontmatter ?? ''
        // The delimiter line is not part of the block, so every position
        // inside it is shifted by however many lines precede it.
        const at = raw.indexOf(block)
        const lineOffset = at < 0 ? 1 : raw.slice(0, at).split('\n').length - 1
        return fieldPositions(block, { lineOffset })
    },
})

// Positions for one entity's raw source, dispatching on how the file carries
// its meta rather than on its extension.
export function positionsForSource(raw, entity) {
    if (typeof raw !== 'string') return {}
    for (const handler of handlers) {
        try {
            if (handler.test(entity, raw)) return handler.positions(raw, entity) ?? {}
        } catch { /* a handler that throws is a handler that declines */ }
    }
    return {}
}

// The entity's source text, through the provider dispatch rather than
// fs.readFile — a gdrive:// or github:// entity has no local path, and reading
// one as a filename silently yields no provenance for every remote source.
//
// A SYNTHETIC entity — no uri of its own — falls back to its parent's text. A
// csv row is the case that exists today: it has no file, but it was written on
// one line of the file its parent points at, and that line is a real place a
// person can go and edit. The generic rule is worth more than the csv-shaped
// one, so it lives here and the csv plugin only has to say how to read a row
// out of the text.
export async function rawSourceOf(entity) {
    if (!entity) return null
    if (entity.uri) {
        if (!isTextEntity(entity)) return null
        try {
            const { content } = await readEntityContent({ ...entity, content: undefined })
            return typeof content === 'string' ? content : null
        } catch {
            return null
        }
    }
    if (!entity.parent) return null
    const parent = runtime.catalog?.byId?.get?.(entity.parent)
        ?? (typeof runtime.catalog?.findById === 'function' ? runtime.catalog.findById(entity.parent) : null)
    if (!parent || parent.id === entity.id) return null
    return rawSourceOf(parent)
}

export function createProvenance(db) {
    if (!db) throw new Error('createProvenance: db is required')

    const stmtGet = db.prepare('SELECT checksum, fields FROM mikser_provenance WHERE id = ?')
    const stmtPut = db.prepare(`
        INSERT INTO mikser_provenance (id, checksum, fields) VALUES (@id, @checksum, @fields)
        ON CONFLICT(id) DO UPDATE SET checksum = @checksum, fields = @fields
    `)
    const stmtDelete = db.prepare('DELETE FROM mikser_provenance WHERE id = ?')
    const stmtCount = db.prepare('SELECT count(*) AS n FROM mikser_provenance')

    return {
        // Field path → { line, col } for an entity, computed on first ask and
        // cached until its checksum moves.
        //
        // Returns `{}` rather than throwing for anything it cannot place: a
        // synthetic entity with no file, a format whose parser gives no
        // ranges, an unreadable path. The caller still has the field path,
        // which is the half that matters most.
        async positionsFor(entity) {
            // A synthetic entity has no uri but may still be locatable through
            // its parent, so `uri` is not the gate — having somewhere to read
            // from is, and rawSourceOf decides that.
            if (!entity?.id) return {}
            const row = stmtGet.get(entity.id)
            if (row && row.checksum === (entity.checksum ?? null)) {
                try { return JSON.parse(row.fields) } catch { /* rewrite below */ }
            }
            const raw = await rawSourceOf(entity)
            if (raw == null) return {}
            const fields = positionsForSource(raw, entity)
            stmtPut.run({
                id: entity.id,
                checksum: entity.checksum ?? null,
                fields: JSON.stringify(fields),
            })
            return fields
        },

        async locate(entity, fieldPath) {
            if (!fieldPath) return null
            const fields = await this.positionsFor(entity)
            return fields[fieldPath] ?? null
        },

        forget(id) {
            if (id) stmtDelete.run(id)
        },

        size() {
            return stmtCount.get()?.n ?? 0
        },
    }
}

export function useProvenance() {
    if (!runtime.provenance) {
        runtime.provenance = createProvenance(useDatabase().handle)
    }
    return runtime.provenance
}

// A debug view for a browser: the recorded provenance of a rendered page, as
// an HTML comment appended to it.
//
// The predecessor injected markers like this into every annotated element, and
// that is precisely why it was only ever safe as a dev feature — it changed the
// bytes that ship. So this is off unless asked for, and it refuses to run in
// production rather than trusting an operator to remember. The comment is
// APPENDED once, never interleaved, so it cannot alter how the document
// renders.
//
// It is a convenience, not the interface. `mikser_which` answers the same
// question against the same records without touching the output at all, and
// that is the one to reach for.
export function provenanceCommentsEnabled() {
    if (!runtime.options?.provenanceComments) return false
    // Two independent signals, either of which vetoes. An operator who set the
    // flag in a shared config and then deployed should not discover it in the
    // shipped HTML.
    if (runtime.options.mode === 'production') return false
    if (process.env.NODE_ENV === 'production') return false
    return true
}

// The comment for one rendered entity, or null when disabled or when there is
// nothing recorded. `sources` is the render's recorded closure, as
// manifest.snapshotsAt would report it.
export function provenanceComment(sources) {
    if (!provenanceCommentsEnabled()) return null
    if (!sources?.length) return null
    const lines = sources.map(source => {
        const via = Array.isArray(source.via) ? source.via.join(', ') : source.via
        return `  ${source.id}${via ? `  <- ${via}` : ''}`
    })
    // `--` cannot appear inside an HTML comment, and a source id or a recorded
    // query filter can easily contain one.
    const body = lines.join('\n').replace(/--/g, '\u2013\u2013')
    return `\n<!-- mikser:provenance\n${body}\n-->\n`
}
