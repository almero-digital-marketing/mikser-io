import _ from 'lodash'
import crypto from 'node:crypto'
import path from 'path'
import { hashFile } from 'hasha'
import { createHash } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'

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

const CHECKSUM_MAX_BYTES = 300 * 1024

// Checksum from bytes the CALLER ALREADY HAS — no I/O, and therefore no
// second read to disagree with the first.
//
// The hazard this exists to remove: a plugin that stores content does
//
//     meta: { body: await readFile(source, 'utf8') },

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
