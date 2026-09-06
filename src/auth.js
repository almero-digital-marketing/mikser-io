import crypto from 'node:crypto'
import { isLoopback } from './utils/index.js'
import { currentPrincipal } from './principal.js'
import runtime from './runtime.js'

// Authentication seam (ADR-0012).
//
// The engine says HOW a credential is proven. Plugins say WHAT they gate.
// Nothing here knows about users, sessions, roles, or OAuth — a verifier
// that does is an external package (mikser-io-auth), plugged in at the
// same seam a bare token string plugs into.
//
// A verifier is a provider-agnostic descriptor:
//
//   {
//     name,                        // for logs: 'bearer', 'oauth', …
//     async verify(req),           // → null (no credential presented)
//                                  //   false (presented, rejected)
//                                  //   { subject, capabilities?, scope? }
//     challenge?(req, res),        // set WWW-Authenticate before a 401
//     authorizationServers?, resource?, scopesSupported?,   // RFC 9728
//   }
//
// A principal carries three things, and the engine understands only two:
//
//   subject       who this is — a string, for logs and audit
//   capabilities  which verbs they hold, or null for "not verb-scoped"
//   scope         which ROWS they may see — an OPAQUE value the engine
//                 never inspects. The plugin that issued the credential's
//                 surface is the only thing that knows what it means (for
//                 api/vector/data it's a sift filter ANDed with the
//                 endpoint's own `query`). Keeping it opaque here is what
//                 stops the engine from growing an opinion about content.
//
// `verify()` is the primitive; requireAuth() is the Express convenience
// built on it. Both are exported because a surface whose denials aren't
// HTTP-shaped (MCP answers in JSON-RPC) needs the primitive directly.

// The static long-lived token verifier — mikser's default and, for a build
// tool driven by config files, usually the only one anybody needs.
export function bearer({ token, name = 'bearer', subject = 'token', capabilities = null, scope = null } = {}) {
    if (!token) throw new Error('bearer({ token }) requires a token')
    const expected = Buffer.from(`Bearer ${token}`, 'utf8')

    return {
        name,
        capabilitiesDeclared: capabilities,
        async verify(req) {
            const header = req.headers?.authorization ?? req.get?.('authorization')
            if (!header) return null
            const presented = Buffer.from(header, 'utf8')
            // timingSafeEqual throws on a length mismatch, so the length
            // check has to come first — it leaks length, which a Bearer
            // header already does structurally.
            const ok = presented.length === expected.length &&
                       crypto.timingSafeEqual(presented, expected)
            return ok ? { subject, capabilities, scope } : false
        },
        challenge(req, res) {
            res.set('WWW-Authenticate', 'Bearer')
        },
    }
}

// Normalize whatever a plugin's `auth:` option holds into a verifier, or
// null for "nothing configured". Accepts:
//
//   undefined / null       → null
//   'sekrit'               → bearer({ token })
//   { token: 'sekrit' }    → bearer({ token })      (the ep.token shape)
//   { verify: async fn }   → used as-is (mikser-io-auth, custom verifiers)
//   async (req) => {…}     → wrapped as a bare verify function
//
// Returning null rather than throwing is deliberate: "no auth configured"
// is a legitimate, common state for a build tool running on localhost.
// What it MEANS is the caller's decision — see requireAuth's allowRemote.
export function resolveAuth(config) {
    if (!config) return null
    // An array is "any of these credentials will do" — several machine
    // tokens, or machine tokens alongside a human's OAuth token. See anyOf().
    if (Array.isArray(config)) {
        const verifiers = config.map(resolveAuth).filter(Boolean)
        if (!verifiers.length) return null
        return verifiers.length === 1 ? verifiers[0] : anyOf(...verifiers)
    }
    if (typeof config === 'string') return bearer({ token: config })
    // An object carrying verify() wins BEFORE the bare-function branch: a
    // verifier may itself be a callable (mikser-io-auth's auth() is both the
    // plugin and the verifier), and treating that as a raw verify function
    // would call the plugin with a request.
    if (typeof config.verify === 'function') return config
    if (typeof config === 'function') return { name: 'custom', verify: config }
    if (config.token) return bearer({ token: config.token })
    return null
}

// How exposed is a surface? The vocabulary registerRoute() already uses.
// Computed here so a facade's view of exposure stops being a per-plugin
// promise (three plugins, three hand-rolled copies — see ADR-0012).
export function reachabilityOf({ auth, token, allowRemote } = {}) {
    if (auth || token) return 'token'
    return allowRemote ? 'public' : 'loopback'
}

// The uniform rule, in one place.
//
//   verifier configured:
//     credential valid              → allow, from anywhere
//     credential presented, invalid → 401
//     credential absent             → 401 (loopback does NOT bypass a
//                                     configured verifier — same posture
//                                     as WhiteBox), unless trustLoopback
//   no verifier:
//     loopback, or allowRemote      → allow
//     otherwise                     → 403
//
// A verifier may refine the "presented, invalid" case through an optional
// `rejectionFor(req)` returning `{ status, code, description }` — see the
// call site. It can only narrow a denial that already happened; there is no
// return value from it that turns a rejection into an acceptance.
//
// `trustLoopback: true` restores the older mikser behaviour where a
// token-gated endpoint stayed open to localhost. It exists so the api and
// mcp plugins can keep their documented semantics for a plain `token:`
// while a real verifier gets the stricter default.
export async function authorize(req, verifier, { allowRemote = false, trustLoopback = false } = {}) {
    const local = isLoopback(req.ip)

    if (verifier) {
        const result = await verifier.verify(req)
        if (result) return { ok: true, principal: result }
        if (result === false) {
            // A rejected credential is not one thing. An EXPIRED token means
            // "exchange your refresh token and retry" — a client does that
            // silently. A token whose subject lacks the capability means
            // "refreshing will not help", and a client that refreshes on it
            // loops. Told apart only by the verifier, which is the only thing
            // that looked at the credential, so it gets to refine the answer.
            //
            // Absent (every verifier before this existed), the answer is
            // today's: 401 invalid_token, which is right for the common case
            // and is what a client needs in order to refresh at all.
            // Named fields rather than a spread: a refinement must not be
            // able to reach `ok` or `principal`, and listing what may cross
            // is how that stays true when someone adds a field later.
            // `scope` is load-bearing on an insufficient_scope challenge —
            // RFC 6750 §3.1 puts the capability the caller lacks in it, and
            // without it the client is told it is unauthorized but not for
            // what.
            const { status, code, description, scope } = verifier.rejectionFor?.(req) ?? {}
            return {
                ok: false,
                status: status ?? 401,
                reason: 'invalid',
                code: code ?? 'invalid_token',
                description,
                scope,
                error: description ?? 'Invalid credential',
            }
        }
        // Nothing presented. No `code`: RFC 6750 §3.1 says a challenge to a
        // request that carried no credential omits `error` entirely, and the
        // omission is the signal — it is how a client tells "you have never
        // authenticated here" from "the token you hold went stale".
        if (trustLoopback && local) return { ok: true, principal: { subject: 'loopback' } }
        return { ok: false, status: 401, reason: 'missing',
                 error: 'Authentication required' }
    }

    if (allowRemote || local) return { ok: true, principal: { subject: 'anonymous' } }
    return {
        ok: false, status: 403, reason: 'reachability',
        error: 'Endpoint accepts loopback connections only — configure a token or set allowRemote: true to enable remote access',
    }
}

// Express flavour of the same rule.
export function requireAuth(verifier, options = {}) {
    return async (req, res, next) => {
        let outcome
        try {
            outcome = await authorize(req, verifier, options)
        } catch (err) {
            options.logger?.error?.('auth: verifier threw — %s', err.message)
            return res.status(500).json({ error: 'Authentication failed' })
        }
        if (outcome.ok) {
            req.principal = outcome.principal
            return next()
        }
        // 403 carries a challenge too: RFC 6750 §3.1 puts insufficient_scope
        // there, and a client that only reads the header on a 401 is exactly
        // the client that cannot tell the two apart.
        if (outcome.status === 401 || outcome.status === 403) {
            verifier?.challenge?.(req, res, outcome)
        }
        res.status(outcome.status).json({ error: outcome.error })
    }
}

// Accept ANY of several credentials on one surface.
//
// This is the shape a real deployment reaches for almost immediately: a
// handful of long-lived machine tokens (one per caller, so a leaked token
// scopes the blast radius) plus a human's OAuth token on the same routes.
// It lives here rather than in userland because the last project that
// hand-rolled it shipped a silent auth BYPASS — a composed verifier that
// the resolver didn't recognise degraded to a pass-through `next()` and
// merely warned. The failure mode of getting this wrong is not "denied",
// it is "wide open", so it belongs in one tested place.
//
// The three-valued merge is the whole subtlety:
//
//   any verifier accepts        → accept (first wins)
//   all say "nothing presented" → null   (loopback policy may still apply)
//   any says "presented, bad"   → false  (NEVER falls back to loopback —
//                                  a caller who presented a credential has
//                                  identified itself and must be judged)
export function anyOf(...verifiers) {
    const list = verifiers.filter(Boolean)
    if (!list.length) return null
    if (list.length === 1) return list[0]

    // Preserve discovery metadata so an MCP client can still find the
    // authorization server through the composite. First verifier that
    // advertises one wins; a static token has nothing to advertise.
    const discovering = list.find(v => v.authorizationServers?.length)

    return {
        name: `anyOf(${list.map(v => v.name ?? '?').join(',')})`,
        authorizationServers: discovering?.authorizationServers,
        resource:             discovering?.resource,
        scopesSupported:      [...new Set(list.flatMap(v => v.scopesSupported ?? []))],

        async verify(req) {
            let rejected = false
            for (const verifier of list) {
                const result = await verifier.verify(req)
                if (result) return result
                if (result === false) rejected = true
            }
            return rejected ? false : null
        },

        // Whichever member actually judged the credential gets to say why it
        // failed. Without forwarding this, composing a static token with an
        // OAuth verifier silently downgrades every expiry to a bare 401 and
        // the refresh signal is lost precisely on the surfaces that have one.
        rejectionFor(req) {
            for (const verifier of list) {
                const refined = verifier.rejectionFor?.(req)
                if (refined) return refined
            }
            return undefined
        },

        // Challenge with the verifier that can actually be satisfied
        // interactively — pointing a browser at "Bearer" when the real
        // option is OAuth discovery helps nobody.
        challenge(req, res, outcome) {
            const chooser = discovering ?? list.find(v => v.challenge)
            chooser?.challenge?.(req, res, outcome)
        },
    }
}

// Does this principal hold a capability?
//
// `capabilities: null` means "this credential is not capability-scoped" —
// a bare static token with nothing declared, which is every endpoint that
// worked before ADR-0012. Such a credential passes any capability check,
// because the endpoint's own `operations` list is what bounds it. A
// credential that DOES declare capabilities is bound by them as well, so
// a request's reach is the INTERSECTION of the endpoint's ceiling and the
// principal's grant — never the union.
// `*` is a real wildcard, and this is the ONLY place that decides so.
//
// It was already being written in grants — a role configured `['*']` meaning
// "everything" — and matched nothing, because this was an exact `includes`.
// The result was the worst available shape: a role whose own summary said it
// had everything, whose reach printed as empty, which could use api and mcp
// (those declare no capability, so the check above passes) and could not open
// the drive (which declares one). Everything about it looked deliberate.
//
// Enforced through this function everywhere rather than `.includes` at each
// gate: drive checked twice and the auth verifier once, all bypassing this,
// so a wildcard added here alone would have worked on two surfaces out of
// four — the same partial answer, one layer down.
export const CAPABILITY_WILDCARD = '*'

// Writing to a collection is scoped to that collection.
//
//   write:<collection>     may change what is in it
//
// One name, asked by every write surface, so `write:documents` means the same
// thing whether the write arrives over MCP, over the api, or from a plugin.
// Reads are not scoped here: the api bounds them with `api:list` and the drive
// with `drive:<endpoint>`, and inventing a third read rule would give three
// answers to one question.
export const writeCapabilityFor = (collection) => `write:${collection}`

// Off until an operator turns it on, and turned on by granting.
//
// Enforcing immediately would refuse every write on every deployment that
// exists, since nobody holds a capability that did not exist until now. So
// the rule is the one the rest of this file already uses for principals,
// applied to the catalogue: a site that declares no `write:` capability is
// not using collection scoping, and its writes are bounded by whatever
// bounded them before. The first `write:` grant turns it on for EVERY
// collection at once — which is surprising exactly once, and is the only
// reading that does not leave a half-enforced site.
function collectionScopingConfigured(catalogue) {
    return Object.values(catalogue ?? {}).flat()
        .some(capability => String(capability).startsWith('write:'))
}

// The capability missing to write to this collection, or null when the write
// may proceed. `catalogue` says whether the site uses collection scoping at
// all; `principal` defaults to whoever the surface established.
export function missingCollectionWrite(collection, {
    principal = currentPrincipal(),
    catalogue = runtime.options?.roles?.catalogue,
} = {}) {
    if (!collection) return null
    if (!collectionScopingConfigured(catalogue)) return null
    return missingCapability(principal, writeCapabilityFor(collection))
}

// Which of these capabilities the principal does NOT hold — the first one, or
// null when it holds them all.
//
// The plural is the point. Almost every gate in the tree needs a SET, not one:
// writing to a drive endpoint needs `drive:<name>` to reach it and
// `drive:<name>:write` to change it, and "may ALSO write" means the base is a
// prerequisite rather than an alternative. Each surface worked that out for
// itself and they disagreed — the WebDAV mount required both, the tool over
// the same endpoint required only the second, so one grant was refused a PUT
// and allowed the identical write through the other door.
//
// Returning the MISSING capability rather than a boolean is what lets a
// refusal name the one that is actually absent, which is the difference
// between "you lack drive:documents" and "you lack drive:documents:write" when
// the operator granted exactly one of them.
export function missingCapability(principal, capabilities = []) {
    for (const capability of [].concat(capabilities)) {
        if (!hasCapability(principal, capability)) return capability
    }
    return null
}

export function hasCapability(principal, capability) {
    if (!capability) return true
    const caps = principal?.capabilities
    if (caps == null) return true
    return caps.includes(capability) || caps.includes(CAPABILITY_WILDCARD)
}
