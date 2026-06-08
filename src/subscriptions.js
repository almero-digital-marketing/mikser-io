// General-purpose change subscription primitive. A subscriber registers
// `{ filter, scope, expand, onChange }`; the dispatcher fires `onChange`
// once per matching journal entry per cycle.
//
// Lives in core (not in the api plugin) because subscription is
// transport-agnostic. The api plugin bridges to SSE; the mikser-io-mcp
// plugin could bridge to postMessage / MCP-UI notifications; a debugger
// plugin could bridge to a log tail. All consumers compose against the
// same primitive.
//
// Two delivery modes:
//
//   - Without `expand`: journal-walk dispatch. onChange fires once per
//     matching (CREATE/UPDATE/DELETE) entry with `{ operation, entity }`.
//     `operation` is the lowercase string ('create' / 'update' / 'delete').
//
//   - With `expand`: graph dispatch via runtime.refs.subscribeGraph.
//     onChange fires when any entity inside the expansion graph mutates,
//     with `{ operation: 'update', entity: expandedRoot, causedBy:
//     mutatedId | null }`. The expand subscription path is skipped from
//     the journal-walk dispatcher to avoid double-emission.
//
// `scope` and `filter` are both predicate functions; applied in that
// order. Conventionally `scope` is a static pre-filter (an api endpoint's
// allowedEntities, a tenant boundary) and `filter` is a per-subscription
// matcher (the subscriber's own narrowing). Either can be omitted.
//
// Returns `{ dispose }`. Pass `signal` (an AbortSignal) to auto-dispose
// when aborted — useful for plugins that already have a per-request
// signal in scope.

import runtime from './runtime.js'
import { useLogger } from './engine.js'
import { onFinalize } from './lifecycle.js'
import { useJournal } from './journal.js'
import { OPERATION } from './constants.js'
import { assertExpand, queryEntities } from './catalog.js'

// Per-module subscription registry. The dispatcher walks this Set
// every onFinalize. A Set (not a Map) because subscriptions are keyed
// by reference equality — the subscribe() return handle's dispose()
// removes the exact object that was added.
const subscriptions = new Set()

// Translate the OPERATION enum (constants.js) into the lowercase
// strings consumers receive. Done once, not per-dispatch.
const opNames = {
    [OPERATION.CREATE]: 'create',
    [OPERATION.UPDATE]: 'update',
    [OPERATION.DELETE]: 'delete',
}

export function subscribe({ filter, scope, expand, onChange, signal } = {}) {
    if (typeof onChange !== 'function') {
        throw new Error('subscribe: onChange must be a function')
    }

    // Reject bad expand at registration. A misconfigured subscriber
    // can otherwise open a session that's expensive to re-dispatch on
    // every cycle. assertExpand throws synchronously; callers (api's
    // HTTP handler, etc.) catch and return a 400-equivalent before any
    // transport headers go out.
    assertExpand(expand)

    const sub = { filter, scope, expand, onChange }
    subscriptions.add(sub)

    // Bridge to runtime.refs.subscribeGraph for expand subscriptions.
    // Fires whenever any entity inside the expand graph mutates — at
    // any depth — and the callback receives the re-expanded root.
    // Skipped silently if runtime.refs hasn't initialised (library-mode
    // contexts without the refs index).
    let graphSub = null
    if (expand && runtime.refs?.subscribeGraph) {
        graphSub = runtime.refs.subscribeGraph({
            filter: (entity) => {
                if (scope && !scope(entity)) return false
                if (filter && !filter(entity)) return false
                return true
            },
            expand,
            onAffected: async ({ root, mutated }) => {
                try {
                    // Re-fetch the root through the public catalog API
                    // so the expanded shape goes through the same
                    // sift + expand + project pipeline as one-shot
                    // reads. items[0] is the freshly-expanded root.
                    const { items } = await queryEntities({
                        filter: { id: root.id },
                        expand,
                        limit: 1,
                    })
                    const expanded = items[0]
                    if (!expanded) return
                    await onChange({
                        operation: 'update',
                        entity: expanded,
                        causedBy: mutated?.id ?? null,
                    })
                } catch (err) {
                    useLogger().warn(
                        'subscription graph dispatch failed: %s',
                        err.message,
                    )
                }
            },
        })
    }

    const dispose = () => {
        subscriptions.delete(sub)
        graphSub?.dispose()
    }

    if (signal) {
        if (signal.aborted) dispose()
        else signal.addEventListener('abort', dispose, { once: true })
    }

    return { dispose }
}

// Per-cycle dispatcher. Walks the journal once, fans matching entries
// out to every registered (non-expand) subscription. Empty Set → no
// journal walk, ~zero cost.
//
// Hook onFinalize, NOT onFinalized — journal.js's clearJournal callback
// runs on onFinalized and drains the entries before plugin-onFinalized
// hooks fire. By Finalize the journal still holds this cycle's writes.
onFinalize(async (signal) => {
    if (subscriptions.size === 0) return
    const logger = useLogger()

    for await (const { operation, entity } of useJournal(
        'Subscriptions',
        [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE],
        signal,
    )) {
        for (const sub of subscriptions) {
            // expand-mode subscriptions get their events from the refs
            // graph dispatch (registered in subscribe()). Emitting here
            // too would double-fire on a root mutation that also matches
            // the filter.
            if (sub.expand) continue
            if (sub.scope && !sub.scope(entity)) continue
            if (sub.filter && !sub.filter(entity)) continue
            try {
                await sub.onChange({
                    operation: opNames[operation],
                    entity,
                })
            } catch (err) {
                logger.warn('subscription dispatch failed: %s', err.message)
            }
        }
    }
})
