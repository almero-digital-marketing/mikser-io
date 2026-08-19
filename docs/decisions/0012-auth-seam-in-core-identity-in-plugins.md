# 12. Authentication is an engine seam; identity providers are plugins

## Status

Accepted

## Context

Mikser already authenticates requests. It does so in at least three places, by copy-paste, and the copies have drifted.

The rule every copy claims to implement — call it the *uniform rule* — is:

- token presented and valid → allow from anywhere
- token presented and invalid → reject
- token absent → require loopback, unless `allowRemote`

`src/plugins/api.js` and `mikser-io-mcp` implement that. `mikser-io-forms` does not, despite a comment saying it does:

| | token set, none presented | loopback denial | wrong token |
| --- | --- | --- | --- |
| `api.js` | falls back to loopback | `403` | `401` |
| `mikser-io-mcp` | falls back to loopback | `403` (JSON-RPC `-32001`) | `401` |
| `mikser-io-forms` | **rejects — no fallback** | **`401`** | `401` |

Neither behaviour is obviously wrong. Forms is arguably the safer reading. The problem is that nobody chose: three authors wrote the same paragraph of comments and three different policies, and no test can catch it because there is nothing shared to test.

The engine already exports the *primitive* (`isLoopback`) but not the *policy*. `src/utils.js` says so out loud: "For more nuanced policies (token gate + loopback fallback), plugins usually inline the check using `isLoopback()` directly." That was an accurate description of the status quo and is now the thing to fix.

Three further consequences follow from having no seam:

- **Token comparison is `presented !== expectedAuth`** — a plain string compare, not constant-time. Correct in every copy, and correct nowhere in particular.
- **There is no way to add a second credential type.** Supporting OAuth for remote MCP (the MCP spec's `WWW-Authenticate` + RFC 9728 challenge, which nothing in the tree implements today) currently means editing every plugin that mounts a route.
- **`registerRoute({ reachability })` already carries the vocabulary** — `'loopback' | 'token' | 'public'` — but each plugin recomputes it from its own config by hand, so the facade's view of exposure is only as accurate as the least careful copy.

Separately, and deliberately kept separate: outbound credentials (`GOOGLE_APPLICATION_CREDENTIALS`, `GH_TOKEN`, `DIRECTUS_TOKEN`) are each read ad hoc by their provider. That is a different problem with a different answer — see *Decision*, point 5.

## Decision

**1. The engine gains an authentication seam. It gains no identity model.**

A *verifier* is a provider-agnostic descriptor:

```js
{
    name: 'bearer',
    async verify(req) {},         // → null (no credential) | false (bad) | { subject, capabilities }
    challenge? (res) {},          // optional: emit WWW-Authenticate for this scheme
    authorizationServers?: [],    // optional: OAuth discovery metadata
    resource?, scopesSupported?,  // consumed by mikser-io-mcp for RFC 9728
}
```

Core ships exactly one verifier — `bearer({ token })`, constant-time via `crypto.timingSafeEqual` — plus:

```js
resolveAuth(config)                   // string | fn | verifier | { token } | [ … ] → verifier | null
anyOf(...verifiers)                   // accept ANY of several credentials
authorize(req, verifier, opts)        // the uniform rule, transport-agnostic
requireAuth(verifier, opts)           // express middleware over authorize()
reachabilityOf({ auth, token, allowRemote })         // → 'loopback' | 'token' | 'public'
hasCapability(principal, capability)  // endpoint ceiling ∩ principal grant
```

**Several credentials on one surface.** A deployment reaches for this almost
immediately: a handful of long-lived machine tokens (one per caller, so a leak
scopes its own blast radius) alongside a human's OAuth token on the same routes.
`anyOf` lives in the engine rather than in userland because the last project that
hand-rolled it shipped a silent auth *bypass* — a composed verifier the resolver
didn't recognise degraded to a pass-through `next()` and merely warned. The
failure mode of getting this wrong is not "denied", it is "wide open".

The three-valued merge is the whole subtlety: any verifier accepting wins; all
reporting "nothing presented" yields `null` so loopback policy may still apply;
**any** reporting "presented and wrong" yields `false`, which never falls back to
loopback. A caller who presented a credential has identified itself and must be
judged on it.

`verify()` returning a principal is the primitive; `requireAuth()` is the Express convenience built on it. Both are exported, because MCP must render its denial as a JSON-RPC error body rather than an HTTP JSON body and therefore cannot use a generic middleware.

Core takes no position on who a subject is, where it came from, or how it was proven. It knows only: a credential was presented or it wasn't, it verified or it didn't, and what capabilities it carries.

**2. The uniform rule becomes one implementation.**

The three copies are replaced by `requireAuth()`. `api.js`'s semantics win — loopback fallback, `403` for reachability denial, `401` for a bad credential — because two of three already implement it and because `403` is the honest code when the caller's *origin* is the problem rather than their credential. Forms changes behaviour; that is a deliberate, documented break, not an accident.

**3. Identity providers are plugins, on the same contract.**

An OAuth verifier — and, if wanted, a self-hosted authorization server — ships as `mikser-io-auth`, exporting a verifier that `resolveAuth()` accepts wherever a token string is accepted today:

```js
api({ endpoints: { admin: { auth: oauth({ issuer, audience }) } } })
```

This mirrors what WhiteBox already proved out: a seam in `server/src/auth.js`, a first-party authorization server in `server-plugin-oauth`, and an external provider in `whitebox-pro-auth-auth0` — all three interchangeable at the same seam. The one place mikser deliberately diverges is the user store: WhiteBox keeps users in Postgres because WhiteBox is a running product with members; mikser keeps them in files because mikser is a build tool with operators (see point 4).

**4. Capabilities ride the credential, not a user.**

`operations: ['list', 'update', 'delete', 'render']` is already a capability set; today it is bound to an *endpoint*. It becomes the verifier's output instead, so a static token is simply an identity whose capability set is fixed by config, and an OAuth token is one whose capability set is minted at login. Route gating (`allow(op)`) is unchanged and stays where it is.

**Where identity is stored: Apache-format files in the working folder.**

Mikser does not grow a user table. Users and groups live as `htpasswd` and `htgroup` files alongside the content they govern:

```
<workingFolder>/
    users.htpasswd     alice:$2y$10$…            (bcrypt, apr1, or sha1)
    groups.htgroup     editors: alice bob
```

This is ADR-0002 applied to identity rather than content, and it buys the same things files buy everywhere else in mikser: reviewable in a pull request, diffable, deployable by copying a directory, editable with `htpasswd(1)` — a tool that predates every framework this project will outlive. It also means the *format* is not ours to design, version, or migrate.

Groups map to capabilities in config, so the files stay pure identity and the product decides what a group can do:

```js
auth({ groups: { editors: ['api:update', 'mcp:use'], viewers: ['api:list'] } })
```

The obvious objection is that a file cannot be written safely by a running server under concurrent requests. That is a real constraint and it is also the point: this is a store you *provision*, not one the product mutates at runtime. Self-service signup, password reset, and invite flows are explicitly not in scope — a build tool has operators, not members.

**Row scope rides the credential too, opaquely.**

Capabilities are verbs (`api:delete`); they cannot express *which rows exist for
you*. A principal may therefore carry a `scope` — a value the **engine never
inspects**. Only the plugin whose surface issued the credential knows what it
means; for `api`/`vector`/`data` it is a sift filter, `$and`-ed with the
endpoint's own `query`. Keeping it opaque is what stops the engine from growing
an opinion about content.

Always `$and`, never `$or`: a credential may narrow what an endpoint exposes,
never widen it. Groups map to scopes the same way they map to capabilities, and
membership in several groups unions with `$or` — more groups must mean more
reach, or adding one would make a user less able.

Two consequences fell out of this and are load-bearing:

- **A principal-scoped response is never written to the query cache.** The cache
  mirrors the request URL into the output folder, where nginx `try_files` serves
  it without reaching the process. One caller's scoped rows would be handed to
  every later caller of the same URL, unauthenticated. The key is
  endpoint+querystring by design (it must match what nginx sees) so it cannot be
  salted with the principal — the only safe answer is not to write.
- **A principal scope must be a sift object, never a function.** An object is
  pushed into the WHERE clause; a function is applied post-fetch, the form that
  pinned a production box at 111% CPU on 1,367 entities. A function is refused
  rather than silently accepted.

The aggregated cross-plugin permission *catalog* WhiteBox uses stays **out of scope**. If it lands, it must be assembled during engine infrastructure setup, before any plugin hook runs (ADR-0005), or plugin load order becomes observable.

**5. Outbound credentials stay a convention, not core.**

A provider reading `process.env.GH_TOKEN` creates no god-plugin and forces no coordination — by the ADR-0006 bar it does not earn engine code. What it needs is a documented convention (`MIKSER_<PLUGIN>_<NAME>`, config-over-env precedence, redaction in logs), which is a docs change and a lint, not a subsystem.

## Why this clears ADR-0006

1. **Substrate, not domain.** The engine says *how* a credential is proven; plugins say *what* they gate. Core never learns what a route does.
2. **Strengthens ADR-0004.** Today's "shared" policy is shared by duplication — the exact failure that ADR is written against. This is a consolidation of a concern mikser already has, not a new one it is claiming.
3. **The plugin alternative is a god-plugin.** An auth plugin would have to know every other plugin's routes to gate them — the "express plugin" failure mode by name.
4. **Plugins compose independently.** A plugin calls `resolveAuth(options.auth)` and mounts the result. No ordering, no coordination, no collision. This is the test the *catalog* fails, which is why the catalog is deferred.
5. **Cadence.** The seam is ~80 lines whose shape has been stable in WhiteBox across its lifetime. OAuth is not stable — the MCP auth spec, RFC 9728 adoption, and the DCR debate all move monthly. Test 5 is what forces the split: **seam in core, OAuth in a plugin.**

## Consequences

**Easier.** One auth policy, one place, one test suite. Adding OAuth becomes a plugin nobody else has to know about. `reachability` is computed by the engine, so the facade's exposure map stops being a per-plugin promise. Constant-time comparison happens once, correctly.

**Harder.** Every route-mounting plugin gets a coordinated release: core first, then a mechanical edit in `api`, `mcp`, `forms`, `decap`, `vector`. Forms changes behaviour for anyone who configured a token *and* relied on loopback bypassing it. The engine takes on a security-sensitive surface, where being wrong is worse than being absent — which is the argument for keeping it at 80 lines that do one thing.

**Staging.** Core seam ships first and is purely additive; the existing inline checks keep working untouched. Plugins migrate one at a time. `mikser-io-auth` is independent of both and needed only when a remote MCP endpoint has to satisfy a spec-compliant client.

## Examples

- `src/auth.js` — the seam. `src/plugins/api.js` — the reference caller: auth, the
  operation ceiling intersected with the principal's grant, and the per-request
  scope combination. Note that every route lists `auth` **before** `allow(op)`;
  the old order ran the capability check against an undefined principal, which
  passes every check — a silent bypass, not a failure.
- `mikser-io-mcp/index.js` `mountEndpoint()` — why `authorize()` exists separately
  from `requireAuth()`: MCP answers in JSON-RPC, so it shapes its own denials.
- `mikser-io-forms/index.js` — the drift that motivated this, now migrated. Its
  behaviour changed: a token-gated form endpoint accepts loopback without the
  token, and reachability denial answers 403 rather than 401, matching the others.
- `mikser-io-auth` — identity: htpasswd/htgroup, bcrypt, an ES256 key file, and
  the Basic and JWT verifiers.
- `src/utils.js` `isLoopback` / `loopbackOnly` — the primitive that was already shared, and the comment that documented the missing half.
- WhiteBox `server/src/auth.js` + `server-plugin-oauth` + `whitebox-pro-auth-auth0` — the same split, already load-bearing in production.

## Watch for drift

The failure mode is the engine growing an opinion about *identity*. Drift looks like: a users table; a `role` field; a login route in core; a permission catalog added "while we're here"; the seam accepting a provider-specific option so one integration is easier.

For the identity files specifically, drift looks like the product writing to them — a signup route, a password-reset endpoint, a "create user" tool. The moment mikser writes an htpasswd file at runtime it has a concurrency problem, a locking problem, and a database it refuses to admit it has.

The counter-question is always the same: could `mikser-io-auth` be uninstalled, leaving a working token-and-loopback engine behind? If not, the concern crossed the seam.

The second, quieter drift is a plugin inlining its own check again because the seam didn't quite fit. That's a signal the seam is wrong, not a licence — the fix is to change `requireAuth()`, not to route around it.
