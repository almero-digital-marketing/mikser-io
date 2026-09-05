// Turning an entity and its dependencies into a snapshot row, and back.
// Pure apart from hashOutputFile, which reads the file it is asked about.

import crypto from 'node:crypto'
import path from 'node:path'
import runtime from '../runtime.js'
import { findById, findEntities } from '../catalog.js'
import { resolveOutputPath } from '../invalidation.js'
import { filterKey } from '../track.js'
import { diffInputParts, extractRefs, inputHashOf, inputPartsOf } from '../utils.js'
import { readFile } from 'fs/promises'

export function sha1(payload) {
    return crypto.createHash('sha1').update(String(payload)).digest('hex')
}

// refClosure builder — same logic as before, no DB involvement.
// Which input moved, as a flat list of part names ('content',
// 'meta.title', 'checksum', 'inputs.shared'). Empty when the snapshot
// predates part recording — the combined hash still says the entity
// changed, and saying nothing is better than guessing which part.
export function describeInputChange(entity, snapshot) {
    if (!snapshot?.inputParts) return []
    const { changed, added, removed } = diffInputParts(snapshot.inputParts, inputPartsOf(entity))
    return [
        ...changed,
        ...added.map(key => `${key} (added)`),
        ...removed.map(key => `${key} (removed)`),
    ]
}

export function buildRefClosure(entity, deps) {
    const closure = []
    const seen = new Set()
    // `targetId`/`targetIds` are the recorded BINDING — which entity the
    // ref resolved to — and they have to survive into the snapshot. A
    // projection that keeps only {kind, target, hash} leaves the binding
    // in mikser_refs and out of the snapshot, so skipDecision has nothing
    // but the name to compare: the scheduler finds the dependent and the
    // manifest then skips it.
    function pushTarget(kind, target, hash, targetId, targetIds) {
        if (!target) return
        const key = `${kind}:${target}`
        if (seen.has(key)) return
        seen.add(key)
        const entry = { kind, target }
        if (targetId) entry.targetId = targetId
        if (targetIds?.length) entry.targetIds = targetIds
        if (hash) entry.hash = hash
        closure.push(entry)
    }
    function pushQuery(filter) {
        const key = 'query:' + filterKey(filter)
        if (seen.has(key)) return
        seen.add(key)
        closure.push({ kind: 'query', filter })
    }
    if (entity.meta) {
        for (const { ref } of extractRefs(entity.meta)) {
            // Resolve through the refs index, which mirrors refFilter's
            // four forms. findById alone is an exact primary-key read, so
            // a $-ref written as a meta.href or a served meta.url path
            // (ADR-0011) resolves to nothing and the edge lands with no
            // hash and no binding — leaving the manifest unable to see
            // that the target changed.
            const ids = runtime.refs?.resolveRefIds?.(ref) ?? (findById(ref) ? [ref] : [])
            const bound = ids.length === 1 ? findById(ids[0]) : null
            pushTarget(
                'ref', ref,
                bound ? inputHashOf(bound) : undefined,
                ids.length === 1 ? ids[0] : undefined,
                ids.length > 1 ? ids : undefined,
            )
        }
    }
    if (Array.isArray(deps)) {
        for (const dep of deps) {
            if (dep.kind === 'query') pushQuery(dep.filter ?? null)
            else pushTarget(dep.kind, dep.target, dep.hash, dep.targetId, dep.targetIds)
        }
    }
    return closure
}

export function buildSnapshot(entity, deps, outputHash, metaReads, consumedReads) {
    const snapshot = {
        id: entity.id,
        destination: entity.destination,
        inputHash: inputHashOf(entity),
        // Per-component hashes of the same payload the combined hash covers,
        // so a later run can name WHICH input moved instead of only that one
        // did. Without it `inputs-changed` sends the reader to a database
        // query for something the tool already has in hand.
        inputParts: inputPartsOf(entity),
        refClosure: buildRefClosure(entity, deps),
        renderedAt: Date.now(),
    }
    // Sorted and deduped: this is a SET of paths, and a stable order keeps a
    // snapshot comparable between runs.
    if (metaReads?.length) snapshot.metaReads = [...new Set(metaReads)].sort()
    if (consumedReads?.length) snapshot.consumedReads = consumedReads
    if (entity.parent) snapshot.parent = entity.parent
    if (outputHash) snapshot.outputHash = outputHash
    return snapshot
}

// Map a sqlite row → snapshot object. `refClosure` is JSON-decoded
// here so callers don't have to think about the wire format.
export function rowToSnap(row) {
    if (!row) return null
    return {
        id:          row.id,
        destination: row.destination,
        inputHash:   row.inputHash ?? undefined,
        inputParts:  row.inputParts ? JSON.parse(row.inputParts) : undefined,
        outputHash:  row.outputHash ?? undefined,
        refClosure:  row.refClosure ? JSON.parse(row.refClosure) : undefined,
        metaReads:   row.metaReads  ? JSON.parse(row.metaReads)  : undefined,
        consumedReads: row.consumedReads ? JSON.parse(row.consumedReads) : undefined,
        renderedAt:  row.renderedAt ?? undefined,
        parent:      row.parent ?? undefined,
    }
}

export function snapToRow(snap) {
    return {
        id:          snap.id,
        destination: snap.destination,
        inputHash:   snap.inputHash   ?? null,
        inputParts:  snap.inputParts  ? JSON.stringify(snap.inputParts) : null,
        outputHash:  snap.outputHash  ?? null,
        refClosure:  snap.refClosure  ? JSON.stringify(snap.refClosure) : null,
        metaReads:   snap.metaReads   ? JSON.stringify(snap.metaReads)  : null,
        consumedReads: snap.consumedReads ? JSON.stringify(snap.consumedReads) : null,
        renderedAt:  snap.renderedAt  ?? null,
        parent:      snap.parent      ?? null,
    }
}

// Where a `destination` actually is on disk.
//
// Two shapes are in circulation and both are legitimate. A page's is
// output-relative with a leading slash (`/bg/index.html`); an asset's is a
// real filesystem path, because assets.js builds it from
// `runtime.options.assetsFolder`, which resolves inside the WORKING folder
// and can sit outside outputFolder entirely.
//
// `path.isAbsolute` cannot separate them — on POSIX `/bg/index.html` is
// absolute too — so resolve by EXISTENCE, output-relative first since that
// is the dominant shape. A page destination treated as a filesystem path
// would otherwise be looked for at the root of the disk.
//
// One definition for both callers. verify() and hashOutputFile ask the same
// question, and a private copy of the join in each is how one mistake
// becomes two symptoms — one loud (every asset reported missing, at its
// real and present path) and one silent (no outputHash recorded, leaving
// most snapshots presence-checked only).

export async function hashOutputFile(destination) {
    const filePath = resolveOutputPath(destination)
    if (!filePath) return undefined
    try {
        const buf = await readFile(filePath)
        return sha1(buf)
    } catch {
        return undefined
    }
}

// The source entities that fed a render, each with HOW it got there.
//
// The reverse of everything else here: snapshots answer "what did this entity
// produce", and this answers "what produced this". It belongs in the engine
// because the refClosure IS the engine's record of what a render consumed —
// which is what makes the answer authoritative rather than a guess. A bundle
// assembled from `findEntities({ collection: 'styles' })` records that query,
// and re-running it returns exactly the parts that went in.
//
// `via` is kept per source and accumulates, because one entity can reach a
// render by more than one route — a layout that is also a $-ref target, a
// document matched by two recorded queries — and collapsing that to the first
// route found would quietly answer a different question.
