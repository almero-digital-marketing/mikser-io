// Which sources are behind a rendered output — the reverse of a snapshot.

import runtime from '../runtime.js'
import { findEntities } from '../catalog.js'

export async function sourcesBehind(snapshot) {
    const sources = new Map()
    const add = (id, via) => {
        if (!id) return
        if (!sources.has(id)) sources.set(id, { id, via: [] })
        if (!sources.get(id).via.includes(via)) sources.get(id).via.push(via)
    }
    if (!snapshot) return []
    add(snapshot.id, 'renders to this destination')
    for (const entry of snapshot.refClosure ?? []) {
        if (entry.kind === 'query') {
            // A null filter is the sentinel for a predicate that could not be
            // serialized. It names no members, so there is nothing to resolve
            // — and claiming the whole catalog fed this render would be worse
            // than saying nothing.
            if (!entry.filter) continue
            const label = `query ${JSON.stringify(entry.filter)}`
            try {
                for (const member of await findEntities(entry.filter)) add(member.id, label)
            } catch { /* a recorded filter that no longer parses tells us nothing */ }
            continue
        }
        for (const id of entry.targetIds ?? (entry.targetId ? [entry.targetId] : [])) {
            add(id, entry.kind)
        }
        // An edge that resolved to nothing still names what it asked for — a
        // forward reference to a page that does not exist yet is a real answer
        // to "what feeds this", and dropping it hides the reason a link breaks.
        if (!entry.targetId && !entry.targetIds?.length && entry.target) {
            add(entry.target, `${entry.kind} (unresolved)`)
        }
    }
    return [...sources.values()]
}

// Everything that fed a DESTINATION, across every entity claiming it.
//
// The shape a caller actually wants: they have a built file, not a snapshot.
// More than one claimant means a collision, and the union is reported rather
// than one arbitrary winner — see collisions().
export async function sourcesOf(destination) {
    const snapshots = runtime.manifest?.snapshotsAt?.(destination) ?? []
    const merged = new Map()
    for (const snapshot of snapshots) {
        for (const source of await sourcesBehind(snapshot)) {
            const existing = merged.get(source.id)
            if (!existing) { merged.set(source.id, { ...source, via: [...source.via] }); continue }
            for (const via of source.via) if (!existing.via.includes(via)) existing.via.push(via)
        }
    }
    return [...merged.values()]
}
