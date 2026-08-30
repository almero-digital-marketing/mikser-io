// Which writes belong together, and who asked for them.
//
// The engine deliberately does not care who wrote a file — files are the
// source of truth and a write is a write. That holds right up until something
// wants to UNDO one request without touching everything else that happened
// around it, and then "a write is a write" is exactly the wrong resolution:
// an agent's three edits and a document created through the API in the same
// second are indistinguishable, so removing one removes the other.
//
// A change set is the missing grain. The caller names it, the writes
// accumulate under it, and a consumer — mikser-io-git today — can commit
// exactly those paths and later remove exactly that contribution.
//
// Deliberately NOT a transaction. Nothing is held back, nothing rolls back on
// failure, and a half-finished set is a real set containing what actually
// landed. It is a label on work that already happened, which is what makes it
// safe to add to a write path that must never block on it.
//
// Unclaimed writes stay unclaimed. A consumer is expected to handle them —
// they still happened, and losing them would be worse than not being able to
// attribute them.

import path from 'node:path'
import runtime from './runtime.js'

function store() {
    runtime.changeSets ??= new Map()
    return runtime.changeSets
}

// Repo-relative, POSIX-separated: these end up in a git pathspec, and a
// consumer should not have to redo that conversion or guess the root.
function relativeToWorkingFolder(uri) {
    const root = runtime.options?.workingFolder
    if (!root || !uri) return null
    const rel = path.relative(root, uri)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
    return rel.split(path.sep).join('/')
}

// Attach one write to a change set.
//
// `summary` is the caller's own description of what it is doing, kept because
// nothing downstream will ever know it as well — a reader choosing what to
// undo needs "changed the hero text on the devices page", not a file count.
// First one wins: later writes in the same set are the same request.
export function recordChangeSetWrite({ changeSet, summary, principal, uri, operation = 'write', undoOf } = {}) {
    if (!changeSet || !uri) return null
    const rel = relativeToWorkingFolder(uri)
    // Outside the working folder there is nothing a repo-scoped consumer can
    // do with the path, and silently keeping an absolute one would produce a
    // pathspec that matches nothing.
    if (!rel) return null

    const sets = store()
    let set = sets.get(changeSet)
    if (!set) {
        set = {
            id: changeSet,
            summary: summary ?? null,
            principal: principal ?? null,
            // Set when this change set exists to take another one back, so
            // the undo is itself an ordinary, undoable change rather than a
            // special history-rewriting operation.
            undoOf: undoOf ?? null,
            startedAt: Date.now(),
            paths: new Map(),
        }
        sets.set(changeSet, set)
    }
    if (!set.summary && summary) set.summary = summary
    if (!set.principal && principal) set.principal = principal
    if (!set.undoOf && undoOf) set.undoOf = undoOf
    set.paths.set(rel, operation)
    return set.id
}

// Every set with writes not yet consumed, oldest first — the order a consumer
// should commit them in, so history reads the way the work happened.
export function pendingChangeSets() {
    return [...store().values()]
        .filter(set => set.paths.size)
        .sort((a, b) => a.startedAt - b.startedAt)
        .map(set => ({
            id: set.id,
            summary: set.summary,
            principal: set.principal,
            undoOf: set.undoOf,
            startedAt: set.startedAt,
            paths: [...set.paths.keys()],
            deletions: [...set.paths.entries()].filter(([, op]) => op === 'delete').map(([p]) => p),
        }))
}

// Drop sets a consumer has dealt with.
//
// Called after the paths are committed, not after they are written: a crash in
// between loses the attribution but not the work, which then reaches the
// consumer as an unclaimed write. That is the right way round — attribution is
// a convenience, the bytes are not.
export function clearChangeSets(ids = []) {
    const sets = store()
    for (const id of ids) sets.delete(id)
}

export function forgetAllChangeSets() {
    store().clear()
}
