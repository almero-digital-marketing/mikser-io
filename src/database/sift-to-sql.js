// Translate a sift filter object to an SQL WHERE clause for the
// `mikser_entities` table. Pushes down what we can; the caller falls
// back to JS-side filtering (or full sift evaluation) for what we
// can't.
//
// Returned shape:
//   {
//     sql:        'WHERE ...' or '' (caller-prefixed; falls through
//                 with no clauses)
//     params:     positional bind values to pass to stmt.all(...)
//     jsFilter:   sift filter for un-pushed clauses, or null when
//                 everything pushed down
//     scanAll:    true when we couldn't push ANY clause and need to
//                 materialize the whole table (only happens for
//                 top-level operators we don't translate at all)
//   }
//
// Engine-default indexed dimensions match the migration plan:
//   id (PK), collection, type, format, name, meta.href, meta.layout,
//   meta.lang, time, uri.
//
// Sift filter dotted-path keys ('meta.href') map to underscore
// columns ('meta_href') via INDEXED_COLUMNS. Anything outside this
// mapping is not indexed and falls back to JS.

// Map sift field names → mikser_entities column names.
export const INDEXED_COLUMNS = {
    id:            'id',
    collection:    'collection',
    type:          'type',
    format:        'format',
    name:          'name',
    'meta.href':   'meta_href',
    'meta.url':    'meta_url',
    'meta.layout': 'meta_layout',
    'meta.lang':   'meta_lang',
    'meta.cache':  'meta_cache',
    time:          'time',
    uri:           'uri',
}

// Operators we can translate inline. Anything else (and any value
// shape we don't recognize) falls to JS.
const TRANSLATABLE_OPS = new Set([
    '$eq', '$ne', '$in', '$nin',
    '$lt', '$lte', '$gt', '$gte',
    '$exists', '$regex',
])

// The column `mikser_entities` is keyed on. The table is WITHOUT ROWID, which
// is what makes a range over this column free where a range over any other
// indexed column is not.
const PRIMARY_KEY_COLUMN = 'id'

// Characters that end a literal run: each starts a construct that is not one
// required character of text.
const REGEX_METACHARACTERS = new Set(
    ['.', '(', ')', '[', ']', '{', '}', '|', '$', '^', '*', '+', '?'])

// The literal text every match of `pattern` has to begin with, or '' when it
// pins none down. Only a `^`-anchored pattern has one.
//
// Reading stops at the first construct that is not a single required
// character, and a character carrying a quantifier that may skip or repeat it
// is dropped rather than trusted: `^ab*` requires only `a`. `+` keeps its
// character — it is required at least once — but ends the prefix, because
// nothing after a repeat sits at a fixed offset.
function literalPrefix(pattern) {
    if (!pattern.startsWith('^')) return ''
    let prefix = ''
    let index = 1
    while (index < pattern.length) {
        let character = String.fromCodePoint(pattern.codePointAt(index))
        let width = character.length
        if (character === '\\') {
            const escaped = pattern.codePointAt(index + 1)
            if (escaped === undefined) break
            character = String.fromCodePoint(escaped)
            // \d, \w, \b, \uXXXX and friends stand for something other than
            // themselves. Only escaped punctuation is a literal character.
            if (/[A-Za-z0-9]/.test(character)) break
            width = 1 + character.length
        } else if (REGEX_METACHARACTERS.has(character)) {
            break
        }
        const next = pattern[index + width]
        if (next === '*' || next === '?' || next === '{') break
        prefix += character
        if (next === '+') break
        index += width
    }
    return prefix
}

// The exclusive upper bound of the range holding every string that starts with
// `prefix`: the prefix with its last code point stepped by one. Null when
// there is no next code point to step to, which leaves the pattern unbounded
// rather than wrongly bounded.
function upperBound(prefix) {
    const characters = Array.from(prefix)
    const last = characters.pop()
    const next = last.codePointAt(0) + 1
    if (next > 0x10ffff || (next >= 0xd800 && next <= 0xdfff)) return null
    return characters.join('') + String.fromCodePoint(next)
}

function sqlForOp(column, op, value) {
    switch (op) {
        case '$eq':
            // NULL-safe equality. `column = NULL` is NULL in SQL, never
            // true, so this pushed down as a clause that matched NOTHING —
            // while sift reads `{field: null}` as "null or absent" and
            // matches both. The filter was translatable, so there was no
            // jsFilter left behind to correct it: the query simply returned
            // no rows. `$ne` has been null-safe since it was written; this
            // is the same care on the other side of it.
            //
            // An absent key and an explicit null are the same NULL in an
            // indexed column, so IS NULL is exactly sift's answer here.
            return value === null
                ? { sql: `${column} IS NULL`, params: [] }
                : { sql: `${column} = ?`,  params: [value] }
        case '$ne':  // NULL-safe inequality — IS NOT for null, != otherwise
            return value === null
                ? { sql: `${column} IS NOT NULL`, params: [] }
                : { sql: `(${column} IS NULL OR ${column} != ?)`, params: [value] }
        case '$lt':  return { sql: `${column} < ?`,  params: [value] }
        case '$lte': return { sql: `${column} <= ?`, params: [value] }
        case '$gt':  return { sql: `${column} > ?`,  params: [value] }
        case '$gte': return { sql: `${column} >= ?`, params: [value] }
        case '$in':  {
            if (!Array.isArray(value) || value.length === 0) {
                return { sql: '0', params: [] }   // never matches
            }
            const placeholders = value.map(() => '?').join(', ')
            return { sql: `${column} IN (${placeholders})`, params: value }
        }
        case '$nin': {
            if (!Array.isArray(value) || value.length === 0) {
                return { sql: '1', params: [] }   // always matches
            }
            const placeholders = value.map(() => '?').join(', ')
            // NULL is not equal to anything, INCLUDING any list value;
            // SQL `NOT IN` returns NULL when the column is NULL, which
            // is filtered out by WHERE. Add the NULL clause so the
            // semantic matches sift ($nin treats null as "not in").
            return {
                sql: `(${column} IS NULL OR ${column} NOT IN (${placeholders}))`,
                params: value,
            }
        }
        case '$exists':
            return value
                ? { sql: `${column} IS NOT NULL`, params: [] }
                : { sql: `${column} IS NULL`,     params: [] }
        case '$regex': {
            // Driver registers a REGEXP user function at open() —
            // see catalog.js. The function is null-safe and returns
            // 0 for null columns (matches sift semantics).
            //
            // Flags do not survive the trip: the user function compiles the
            // SOURCE, with none. A flagged pattern therefore stays in JS,
            // where sift applies it as written — pushed down, `/Foo/i`
            // quietly became `/Foo/` and the same filter answered differently
            // depending on whether the field happened to be indexed.
            if (value instanceof RegExp && value.flags) return null
            const pattern = value instanceof RegExp ? value.source : value
            if (typeof pattern !== 'string') return null

            // A user function is opaque to the query planner, so `col REGEXP ?`
            // alone is a full table scan — and inside an OR it is worse than
            // that: one unindexable branch disqualifies SQLite's multi-index
            // OR for every branch, so the three indexed equality terms of a
            // refFilter were scanned for too. Resolving one ref read all 11k
            // rows of a real catalog.
            //
            // An anchored pattern usually pins down the literal text a match
            // must start with, which on the PRIMARY KEY is a range the planner
            // can seek. The REGEXP term stays as the arbiter — the range only
            // skips rows it would have rejected anyway — so this narrows what
            // is scanned without moving the decision into SQL.
            //
            // Only on the primary key. `mikser_entities` is WITHOUT ROWID, so
            // a range on `id` is a subrange of the very btree a scan walks and
            // cannot cost more than the scan: measured over a 49MB catalog, a
            // loose prefix broke even and a tight one went 7ms → 0.05ms. Every
            // other indexed column is a SECONDARY index, where the same range
            // buys an index walk plus a primary-key lookup per surviving row —
            // 5x SLOWER than simply scanning (5.2ms → 26.9ms), because a
            // WITHOUT ROWID index entry carries the whole key and the regex
            // still runs on every candidate either way. Narrowing the
            // candidate set is the only thing that pays here, and off the
            // primary key a prefix does not narrow it enough to cover the
            // seeks.
            const prefix = column === PRIMARY_KEY_COLUMN ? literalPrefix(pattern) : ''
            const upper = prefix && upperBound(prefix)
            if (!upper) return { sql: `${column} REGEXP ?`, params: [pattern] }
            return {
                sql: `(${column} >= ? AND ${column} < ? AND ${column} REGEXP ?)`,
                params: [prefix, upper, pattern],
            }
        }
        default:
            throw new Error(`Unhandled op ${op} (should be filtered before sqlForOp)`)
    }
}

// Translate one field clause. `value` is the sift value for the
// field — either a primitive (equality) or an operator object
// (`{$lt: ..., $gte: ...}`).
//
// Returns { pushed: { sql, params } } when we can push it down,
// or { pushed: null, fallback: { field, value } } when we can't.
function translateField(field, value, indexed) {
    if (!indexed.has(field)) return { pushed: null, fallback: { field, value } }
    const column = INDEXED_COLUMNS[field]

    // Primitive value → equality.
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { pushed: sqlForOp(column, '$eq', value) }
    }

    // Operator object — every key should be a translatable op.
    const opEntries = Object.entries(value)
    if (opEntries.length === 0) return { pushed: { sql: '1', params: [] } }

    const parts = []
    const allParams = []
    for (const [op, v] of opEntries) {
        if (!TRANSLATABLE_OPS.has(op)) {
            // Mixed translatable / non-translatable on the same field —
            // give up on the whole field and let JS handle it.
            return { pushed: null, fallback: { field, value } }
        }
        const translated = sqlForOp(column, op, v)
        // The op is translatable in general but this value is not — a regex
        // carrying flags. Same answer as an untranslatable op: hand the whole
        // field to sift.
        if (!translated) return { pushed: null, fallback: { field, value } }
        parts.push(translated.sql)
        allParams.push(...translated.params)
    }
    return { pushed: { sql: parts.join(' AND '), params: allParams } }
}

// $or and $and recursively translate sub-clauses.
//
// The two differ in what an unpushable branch costs, and it is the whole of
// why they are not one path. An $or is true of a row when SOME branch is, so
// a branch SQL cannot evaluate makes the disjunction unanswerable: dropping
// it excludes rows that branch alone would have matched. An $and is true only
// when EVERY branch is, so any subset of the branches selects a SUPERSET of
// the answer — the rest is left to the residual matcher, which is what
// findEntities already runs over the rows SQL returns.
//
// Punting the whole conjunction is not a slower correct answer, it is a full
// scan and a JSON.parse per row. On gpoint's catalog — 11,174 entities, 31 of
// them with an href — an endpoint scope of `meta.href` ANDed with a caller's
// filter on the unindexed `meta.route` pushed NOTHING: every request read and
// parsed all 11,174 rows to return one, around three thousand times an hour,
// and the event loop stopped getting a turn. Pushing the half that indexes
// turns the same query into a seek over 31.
function translateLogical(op, clauses, indexed) {
    if (!Array.isArray(clauses) || clauses.length === 0) {
        return { pushed: null, fallback: { field: op, value: clauses } }
    }
    const parts = []
    const allParams = []
    const residual = []
    for (const sub of clauses) {
        const translated = translate(sub, indexed)
        if (op === '$or' && (translated.scanAll || translated.jsFilter)) {
            return { pushed: null, fallback: { field: op, value: clauses } }
        }
        if (translated.sql) {
            parts.push(`(${translated.sql.replace(/^WHERE /, '')})`)
            allParams.push(...translated.params)
        }
        // What SQL could not express stays for sift. `scanAll` with no
        // jsFilter is a clause that is not an object at all — a function
        // predicate — so the clause itself is what sift has to see.
        if (translated.jsFilter) residual.push(translated.jsFilter)
        else if (translated.scanAll) residual.push(sub)
    }
    if (!parts.length) {
        return { pushed: null, fallback: { field: op, value: clauses } }
    }
    const glue = op === '$or' ? ' OR ' : ' AND '
    return { pushed: { sql: parts.join(glue), params: allParams }, residual }
}

// Top-level translator. `filter` is a sift query object. Returns the
// structured result described at the top of the file.
export function translate(filter, indexed = new Set(Object.keys(INDEXED_COLUMNS))) {
    if (filter == null) {
        return { sql: '', params: [], jsFilter: null, scanAll: false }
    }
    if (typeof filter !== 'object' || Array.isArray(filter)) {
        return { sql: '', params: [], jsFilter: null, scanAll: true }
    }

    const sqlParts = []
    const params = []
    const jsClauses = {}   // un-pushed clauses to recombine for sift

    for (const [field, value] of Object.entries(filter)) {
        if (field === '$or' || field === '$and') {
            const t = translateLogical(field, value, indexed)
            if (t.pushed) {
                sqlParts.push(`(${t.pushed.sql})`)
                params.push(...t.pushed.params)
                // A partially pushed $and leaves branches for sift. They are
                // conjunctive wherever they came from, so they recombine
                // under $and whatever the operator above them was.
                if (t.residual?.length) {
                    jsClauses.$and = [...(jsClauses.$and ?? []), ...t.residual]
                }
            } else {
                jsClauses[field] = t.fallback.value
            }
            continue
        }
        const t = translateField(field, value, indexed)
        if (t.pushed) {
            sqlParts.push(t.pushed.sql)
            params.push(...t.pushed.params)
        } else {
            jsClauses[field] = value
        }
    }

    const sql = sqlParts.length ? `WHERE ${sqlParts.join(' AND ')}` : ''
    const jsFilter = Object.keys(jsClauses).length ? jsClauses : null
    return {
        sql,
        params,
        jsFilter,
        scanAll: sqlParts.length === 0 && jsFilter !== null,
    }
}
