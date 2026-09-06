// Who is acting, for the length of one request.
//
// A leaf, and an AsyncLocalStorage for the same reason changeSetContext is
// one: the surfaces that KNOW the caller (an HTTP route, an MCP session) are
// nowhere near the primitives that need to ask about them, and threading a
// principal through every intervening call is how one of them comes to be
// missed.
//
// This exists because the thing already flowing to the write primitives was
// not an identity. `writeEntitySource` takes a `principal`, and what MCP puts
// there is a display string — "dk@almero.bg (admins)" — built for the
// change-set log. Asked `hasCapability(thatString, 'write:documents')` it
// reads `undefined.capabilities`, takes the "not capability-scoped" branch,
// and returns TRUE. An authorization check against it would not merely fail
// to protect anything; it would look like protection while allowing
// everything.
//
// `null` when nothing established a context, and that means UNKNOWN rather
// than "nobody". Callers decide what unknown implies — the write gate treats
// it the way it treats a credential that carries no capabilities, which is
// how every static token and library caller already behaves.
import { AsyncLocalStorage } from 'node:async_hooks'

const principalContext = new AsyncLocalStorage()

export function withPrincipal(principal, fn) {
    if (!principal || typeof principal !== 'object') return fn()
    return principalContext.run({ principal }, fn)
}

export function currentPrincipal() {
    return principalContext.getStore()?.principal ?? null
}
