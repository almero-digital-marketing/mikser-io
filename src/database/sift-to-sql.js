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
    'meta.layout': 'meta_layout',
    'meta.lang':   'meta_lang',
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

function sqlForOp(column, op, value) {
    switch (op) {
        case '$eq':  return { sql: `${column} = ?`,  params: [value] }
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
            const pattern = value instanceof RegExp ? value.source : value
            return { sql: `${column} REGEXP ?`, params: [pattern] }
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
        const { sql, params } = sqlForOp(column, op, v)
        parts.push(sql)
        allParams.push(...params)
    }
    return { pushed: { sql: parts.join(' AND '), params: allParams } }
}

// $or and $and recursively translate sub-clauses.
function translateLogical(op, clauses, indexed) {
    if (!Array.isArray(clauses) || clauses.length === 0) {
        return { pushed: null, fallback: { field: op, value: clauses } }
    }
    const parts = []
    const allParams = []
    const jsFallbacks = []
    for (const sub of clauses) {
        const sub_t = translate(sub, indexed)
        if (sub_t.scanAll) {
            // A sub-clause can't push at all → whole $or/$and can't
            // be split safely. Punt.
            return { pushed: null, fallback: { field: op, value: clauses } }
        }
        if (sub_t.jsFilter) {
            // Partial pushdown in a sub-clause — within $or, we can't
            // safely split (need ALL of the predicate on each branch).
            return { pushed: null, fallback: { field: op, value: clauses } }
        }
        parts.push(`(${sub_t.sql.replace(/^WHERE /, '')})`)
        allParams.push(...sub_t.params)
        jsFallbacks.push(...(sub_t.jsFallbacks ?? []))
    }
    const glue = op === '$or' ? ' OR ' : ' AND '
    return { pushed: { sql: parts.join(glue), params: allParams } }
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
