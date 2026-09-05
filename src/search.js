// Find a string across the catalog and the built output.
//
// `queryEntities` sifts META. This answers the other question — "where does
// this text appear?" — over structured values, source files and built output,
// which is what locating a phone number in a document body or a class name in
// the shipped CSS requires.
//
// Three scopes, answering three different questions, none implying another:
//
//   meta     — structured values, walked as dotted paths. No file I/O.
//   content  — the SOURCE files. What an editor is going to change.
//   output   — the BUILT files. The blast radius: a string can be in the
//              output because a layout writes it, with no source entity
//              containing it anywhere.
//
// UNSCOPED BY DEFAULT, and that is a security property, not a detail. A bare
// call reads every entity and every source file — drafts, unpublished
// documents, layouts, sidecar JavaScript. The `api` plugin's public endpoints
// narrow `list` through the endpoint's own sift scope; nothing narrows this.
// So anything that puts search behind a request MUST pass that same scope as
// `filter`, or a public endpoint that lists only published documents will
// happily search the unpublished ones. There is deliberately no `search`
// operation in the api plugin, and no route here.
//
// The primitives are exported alongside `searchEntities` so a caller building
// a different question out of the same parts does not reimplement counting,
// snippets or line numbers to do it.

import path from 'node:path'
import { readdir, readFile } from 'node:fs/promises'

import runtime from './runtime.js'
import { findEntities } from './catalog.js'
import { readEntityContent, looksTextual } from './utils/index.js'

// How much of an output file to read before deciding it is text. Same rule
// the source read uses, so the two scopes cannot disagree about a file that
// appears in both.
const SNIFF_BYTES = 8 * 1024

// Every leaf value under meta as [dottedPath, value], arrays included.
// The same shape refs_inbound reports, so a hit here and a referrer there
// name the same field.
export function* flattenMeta(node, prefix = '') {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) yield* flattenMeta(node[i], `${prefix}[${i}]`)
        return
    }
    if (typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
            yield* flattenMeta(value, prefix ? `${prefix}.${key}` : key)
        }
        return
    }
    yield [prefix, node]
}

// How many times the needle appears. A count, not a boolean, because "this
// class is on nine pages" and "this class is on nine pages and seven times on
// one of them" are different facts, and the second one names the component.
export function countMatches(text, query, regex, ignoreCase) {
    if (regex) {
        const re = new RegExp(query, ignoreCase ? 'gi' : 'g')
        let n = 0
        // Guard the zero-width case: /a*/g on a non-matching position returns
        // an empty match forever and never advances.
        for (let m = re.exec(text); m; m = re.exec(text)) {
            n++
            if (m.index === re.lastIndex) re.lastIndex++
        }
        return n
    }
    const haystack = ignoreCase ? text.toLowerCase() : text
    const needle = ignoreCase ? query.toLowerCase() : query
    if (!needle) return 0
    let n = 0
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n++
    return n
}

// Offset of the first match, or -1. The one place the regex/substring
// difference is resolved, so the line number and the snippet cannot end up
// pointing at different matches.
function firstMatchAt(text, query, regex, ignoreCase) {
    if (regex) {
        const m = new RegExp(query, ignoreCase ? 'i' : '').exec(text)
        return m ? m.index : -1
    }
    const haystack = ignoreCase ? text.toLowerCase() : text
    return haystack.indexOf(ignoreCase ? query.toLowerCase() : query)
}

// 1-based line of the first match, so a hit is somewhere to go rather than
// something to grep for again.
export function lineOfFirstMatch(text, query, regex, ignoreCase) {
    const at = firstMatchAt(text, query, regex, ignoreCase)
    if (at < 0) return null
    let line = 1
    for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) line++
    return line
}

// Enough text around the match to recognise it without returning the file.
export function snippetAround(text, query, regex, ignoreCase) {
    const at = firstMatchAt(text, query, regex, ignoreCase)
    if (at < 0) return text.slice(0, 120)
    const start = Math.max(0, at - 60)
    const end = Math.min(text.length, at + query.length + 60)
    return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '')
}

// Every occurrence of a needle in a text, with the one signal that separates
// "this file DECLARES it" from "this file uses it" without knowing the
// language: a declaration begins its line in nearly every text format, while a
// use sits mid-line.
//
// The LINE is returned rather than a computed verdict about it. A caller can
// tell a declaration from something that merely starts with the same token by
// reading it, which needs no grammar here at all — and where the heuristic is
// wrong, the evidence for that is right there in the result.
export function findOccurrences(text, needle, { limit = 200 } = {}) {
    const sites = []
    if (!needle || typeof text !== 'string') return sites
    let line = 1
    let lineStart = 0
    let scanned = 0
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
        while (scanned < at) {
            if (text.charCodeAt(scanned) === 10) { line++; lineStart = scanned + 1 }
            scanned++
        }
        const lineEnd = text.indexOf('\n', at)
        sites.push({
            line,
            col: at - lineStart,
            leading: text.slice(lineStart, at).trim() === '',
            text: text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim().slice(0, 160),
        })
        if (sites.length >= limit) break
    }
    return sites
}

// Every file under a folder, depth-first. A generator so a search that hits
// its limit stops walking rather than materializing the tree.
export async function* walkFiles(folder) {
    let entries
    try {
        entries = await readdir(folder, { withFileTypes: true })
    } catch {
        return
    }
    for (const entry of entries) {
        const full = path.join(folder, entry.name)
        if (entry.isDirectory()) yield* walkFiles(full)
        else if (entry.isFile()) yield full
    }
}

// Read a built file as text, or null when it is not text.
//
// Decided by the bytes, so a `.webmanifest`, a `.map` or whatever a renderer
// plugin emits is searchable without first being added to a list of known
// extensions — and a font still comes back null rather than as convincing
// garbage.
async function readOutputText(file) {
    let buf
    try {
        buf = await readFile(file)
    } catch {
        return null
    }
    if (!looksTextual(buf.subarray(0, Math.min(buf.length, SNIFF_BYTES)))) return null
    return buf.toString('utf8')
}

// Build the test used for meta values and for a whole-file contains check.
// Throws on an invalid regex so the caller can report it as bad input rather
// than as an empty result.
function buildMatcher(query, regex, ignoreCase) {
    if (regex) {
        const re = new RegExp(query, ignoreCase ? 'i' : '')
        return { test: (value) => re.test(String(value)) }
    }
    const needle = ignoreCase ? query.toLowerCase() : query
    return {
        test: (value) => (ignoreCase ? String(value).toLowerCase() : String(value)).includes(needle),
    }
}

// Find `query` across the catalog and, when asked, the built output.
//
// Returns { query, scopes, count, truncated, searched, hits }. Each hit
// carries where it was found and enough to go there:
//
//   meta     { id, collection, path, where, field, snippet }
//   content  { id, collection, path, where, field: null, occurrences, line, snippet }
//   output   { destination, where, occurrences, snippet }
//
// `truncated` says the limit stopped the walk, which is the difference
// between "these are the hits" and "these are the first N" — a distinction a
// caller acting on a blast radius cannot afford to guess at.
export async function searchEntities({
    query,
    collection,
    filter,
    in: where,
    regex = false,
    ignoreCase = false,
    limit = 50,
} = {}) {
    if (!query) throw new Error('searchEntities: query is required')
    const scopes = where?.length ? where : ['meta', 'content']
    const matcher = buildMatcher(query, regex, ignoreCase)

    const hits = []
    let truncated = false

    // The output scope walks the deployed folder rather than the catalog, so
    // it runs on its own. Counting is the point here rather than first-match:
    // seven occurrences on one page and one on nine others is the shape of a
    // shared component, and a list of nine equal-looking filenames hides it.
    if (scopes.includes('output')) {
        const outputFolder = runtime.options?.outputFolder
        if (!outputFolder) throw new Error('No output folder configured, so there is no built output to search.')
        for await (const file of walkFiles(outputFolder)) {
            if (hits.length >= limit) { truncated = true; break }
            const text = await readOutputText(file)
            if (text === null) continue
            const occurrences = countMatches(text, query, regex, ignoreCase)
            if (!occurrences) continue
            hits.push({
                destination: '/' + path.relative(outputFolder, file).split(path.sep).join('/'),
                where: 'output',
                occurrences,
                snippet: snippetAround(text, query, regex, ignoreCase),
            })
        }
        hits.sort((a, b) => b.occurrences - a.occurrences || a.destination.localeCompare(b.destination))
    }

    // `filter` is how a caller narrows what may be searched at all. It merges
    // with `collection` and pushes into the catalog query, so a scoped caller
    // never materializes a row it is not allowed to see rather than filtering
    // one out after reading it off disk.
    const searchesCatalog = scopes.some(scope => scope !== 'output')
    const catalogQuery = { ...(filter ?? {}), ...(collection ? { collection } : {}) }
    const entities = searchesCatalog
        ? await findEntities(Object.keys(catalogQuery).length ? catalogQuery : undefined)
        : []

    for (const entity of entities) {
        if (hits.length >= limit) { truncated = true; break }
        if (scopes.includes('meta') && entity.meta) {
            for (const [field, value] of flattenMeta(entity.meta)) {
                if (!matcher.test(value)) continue
                hits.push({
                    id: entity.id, collection: entity.collection ?? null, path: entity.uri ?? null,
                    where: 'meta', field, snippet: snippetAround(String(value), query, regex, ignoreCase),
                })
                break
            }
        }
        if (hits.length >= limit) { truncated = true; break }
        if (scopes.includes('content')) {
            // readEntityContent owns the text/binary decision and makes it by
            // reading the bytes, so a .njk or .toml is searched like anything
            // else. Deciding it a second time here on an extension would make
            // a skipped format indistinguishable from a real absence.
            const { content } = await readEntityContent(entity)
            if (typeof content !== 'string' || !matcher.test(content)) continue
            hits.push({
                id: entity.id, collection: entity.collection ?? null, path: entity.uri ?? null,
                where: 'content', field: null,
                occurrences: countMatches(content, query, regex, ignoreCase),
                line: lineOfFirstMatch(content, query, regex, ignoreCase),
                snippet: snippetAround(content, query, regex, ignoreCase),
            })
        }
    }

    return { query, scopes, count: hits.length, truncated, searched: entities.length, hits }
}
