# ADR-0007 — Entity references: `$`-prefixed declaration and `expand` resolution

**Status:** Accepted
**Date:** 2026
**Supersedes:** —
**Superseded by:** —

## Context

Mikser entities reference each other constantly — articles point to authors, landing pages compose section blocks pointing to images, products link to related products. Today these refs live as plain strings:

```yaml
hero: /images/launch-hero
author: /authors/dick
```

Portable, `sed`-replaceable, no graph-backend coupling (ADRs 0002, 0004). But the lack of any marker distinguishing a reference string from a non-reference string forces capability the project will increasingly need:

- The schemas plugin can't validate references without per-schema opt-in via a helper. Projects without schemas get nothing.
- A reverse-reference index (the basis for "where is this used?", cache invalidation, and rename cascade) has to read every schema first.
- The api plugin can't expose graph-shaped queries or inline relationship resolution without schema introspection per call.
- AI agents reading raw entities can't tell which string fields are references from the data alone.
- Generated TypeScript types are stringly-typed; every consumption site must remember `useHref()` and the expected target type.

A second cost shows up at read time: even with references known, each hop is its own round-trip. Fetching an article with its author and the author's organization is three sequential requests. For AI agents (each hop = MCP tool call), SSG builds (N hops per page across thousands of entities), and CDN caching (atomized requests don't compose), this compounds fast.

Alternatives considered for declaration:
- **Helper-based schema annotation** (`entityRef('author')` decorator) — gates on schemas, requires introspection, projects without schemas get nothing.
- **Reference-typed values** (`{ $ref: '...' }` shape) — breaks `sed`-replace, adds no editor value.
- **Nested namespace** (`meta.refs.author`) — forks the meta surface and reintroduces the schema-gated problem.

Alternatives considered for resolution:
- JSON:API `include`, OData `$expand`, Stripe `expand`, Mongoose `populate`, GraphQL — all variations on "name the relationships you want, get them inline." A cleaner version is possible because the convention already tells the api what's a reference.

The combined design: a **key-prefix convention** for declaration (`$`) and an **`expand` parameter** for resolution. They depend on each other — the convention makes resolution knowable without schemas; resolution makes the convention pay off in fewer round-trips. They are not separable decisions in practice, which is why they live in one ADR.

## Decision

### Part A — References are declared by `$`-prefixed keys

**A1. Any meta key starting with `$` is a reference.**

```yaml
---
layout: article
title: Launch
$author:  /authors/dick           # single ref
$hero:    /images/launch-hero
$related:                         # array of refs
  - /blog/old-post-1
  - /blog/old-post-2
seo:
  $ogImage: /images/og-launch     # nested refs are walked recursively
---
```

Values under `$`-keys MUST be a string (single ref) or an array of strings (multi-ref). Other shapes are surfaced as a warning by the schemas plugin — see "Deferred validation" below.

**A2. Reference values are hrefs.**

Leading slash, no extension, no protocol/host. Reuses mikser's existing addressing primitive (`useHref`, the api filter, frontend routing, the URL bar). Renames are owned by `runtime.refs.rename({from, to})` in the engine, which rewrites affected `$`-keys through the same `useCollection.write` path all other updates use.

**A3. Disk is canonical; render input is normalized.**

| Layer | Shape |
|---|---|
| Source files | canonical — `$author: ...` |
| In-memory catalog | canonical — `$` preserved |
| Render context (templates) | normalized — `$` stripped |
| SDK `list` / `read_entity` output | normalized |
| SDK / API filter and `expand` input | accepts both; normalized internally |
| `update_entity` body content | canonical |
| Schemas plugin validation | canonical |
| Refs plugin reverse index | canonical |

Normalization is one ~10-line helper applied at consumer boundaries; render plugins never see `$`-keys. The catalog stays canonical because the marker is what makes refs detectable, indexable, and queryable.

**A4. On collision (`author:` AND `$author:` both declared), the `$`-version wins deterministically in the projected meta.**

Render context, SDK output, and any consumer reading normalized meta sees the `$`-keyed value at the normalized key (`meta.author`). The plain `author:` value is dropped from the projection but remains visible in the source file and in the canonical catalog row. The schemas plugin (if loaded) surfaces the collision as a warning naming the entity — this is *not* a hard error because mid-edit states (a rename in progress, a refactor mid-flight) routinely produce transient collisions, and an erroring engine fights you instead of helping. The deterministic `$`-wins rule means render output is predictable even when validation hasn't caught up yet.

**A5. Backward compatibility is the default state.**

Projects with no `$`-keys keep working unchanged. Templates that read `meta.author` continue to read `meta.author` whether the source says `author:` or `$author:` — the normalization step makes them indistinguishable to render code. Opt-in is per-field per-file:

```bash
find content/blog -name '*.md' -exec sed -i 's/^author:/$author:/' {} +
```

A migration codemod ships alongside `runtime.refs.rename` for bulk href shape changes.

**A6. Validation is deferred, warning-only, and re-evaluated each cycle.**

File-based content editing is multi-step: an article can be saved before its author file exists, an entity can be renamed leaving N referencing entities temporarily broken, a batch import can land in any order. Any model that errors on broken-ref state at parse time fights normal editing workflows instead of supporting them.

The engine does *no* validation. It only does structural plumbing: detect `$`-keys (via the helpers), project canonical → normalized for renders and SDK output, and on collision pick the `$`-version. Parse-time errors are reserved for unrecoverable conditions (malformed YAML, unreadable file) — never for ref-related state.

The schemas plugin owns all reference validation and emits *warnings* for every failure mode:

- **Shape** — value under a `$`-key isn't a string or string array
- **Collision** — both `author:` and `$author:` declared in the same entity
- **Existence** — `$author: /authors/dick` and no entity resolves at that href
- **Target type** — when `entityRef('author')` is used, the target's layout doesn't match `author`

The schemas plugin maintains a pending-validation map keyed by entity id. On each journal cycle that touched entities, the plugin re-evaluates pending entries — entries that newly resolve (because the missing target finally appeared) clear themselves; entries that newly break (because a target was deleted or renamed) get added. The `mikser://schemas/pending` resource exposes the current list so MCP clients and dashboards can surface "what's currently broken" without scraping logs.

`onError: 'fail'` in the schemas plugin config applies to schema-shape mismatches (the field doesn't match the Zod schema at all), not to ref-existence or ref-shape failures. The latter are always warnings, because they are always recoverable through subsequent edits.

### Part B — References are resolved inline via `expand`

**B1. The api accepts an `expand` parameter on `list` and `read_entity`.**

```js
list({ filter: {...}, expand: ['author', 'sections.*.image'] })
read_entity({ id: '/blog/launch', expand: ['author.organization'] })
```

Symmetric semantics: each path walks meta, resolves `$`-keyed values, replaces the ref string with the resolved entity.

**B2. Paths use dot-notation; `*` denotes array iteration.**

```
expand: [
    'author',                    // depth 1 — $author becomes its entity
    'author.organization',       // depth 2 — chain through expanded refs
    'sections.*.image',          // walk array elements
    'sections.*.cta.target',     // mix arrays and nested objects
]
```

`*` is explicit. No implicit array traversal — one rule applied uniformly.

**B3. Resolved values replace the ref string inline.**

```js
// Without expand
{ meta: { author: '/authors/dick' } }

// With expand: ['author']
{ meta: { author: { id: '/authors/dick', meta: { name: 'Dick', bio: '...' } } } }
```

No sidecar namespace. Type generation narrows `meta.author` from `EntityRef<AuthorMeta>` to `AuthorEntity` when `expand: ['author']` is in scope.

**B4. `expand` on non-`$` fields is a hard error.**

```
expand: ['title']
→ 422 "Field `title` is not a `$`-keyed reference on collection 'documents'"
```

Silent skipping would hide typos.

**B5. Cycles and missing targets are silently broken.**

If a path can't resolve at depth N — cycle closes, target missing — the value at depth N stays the ref string. No `_truncated` / `_cycle` / `_expanded` markers on the response. Same observable behavior for both causes. The shape stays "entity-or-string at every expanded position." Consumers that need the distinction can re-fetch.

**B6. Expansion is bounded by configurable limits.**

```js
// mikser.config.js
catalog: {
    expand: {
        maxDepth:    5,      // hard cap on path length
        maxPaths:    20,     // entries in `expand`
        maxResolved: 100,    // unique entity lookups per request
    },
}
```

Exceeding any cap → 422 with the cap and the triggering path named.

**B7. GET stays the default transport.**

Expansion encodes into the URL: `?expand=author,sections.*.image,author.organization`. The api plugin's per-query disk cache and any upstream CDN keep working — the cache key includes the `expand` parameter. POST fallback applies only when the URL exceeds the size cap, same as the SDK's GET-first strategy.

**B8. Write APIs reject expanded shapes.**

Write bodies expect canonical source-file content with refs as strings. An expanded shape in a write body → 422. There is no deep-write — to update the author's bio, update the author entity (per ADR-0002). This protects the file-as-source-of-truth invariant from drift through expansion.

**B9. The engine's `runtime.refs` reverse index drives cache invalidation and live-expand subscriptions.**

When entity X is mutated, the api walks the inverse index (via `runtime.refs.inboundFor` for direct hops or `runtime.refs.subscribeGraph` for live-expand SSE subscriptions) to find cached queries and live consumers that expanded X, then evicts/emits accordingly. The index earns its keep three times — graph queries, cache invalidation, live-expand dispatch — from the same data structure. It lives in the engine (not a plugin) per ADR-0006's five-test analysis: same shape as the catalog (derived projection of files, infrastructure other plugins query against). Always available; no soft-dependency degradation needed in any consumer.

## Consequences

**Easier:**

- Reference validation requires zero schema configuration — installing the schemas plugin auto-detects `$`-keys and verifies each value resolves.
- The reverse-reference index (`runtime.refs`, engine-level) builds from a raw catalog walk; no schema introspection.
- AI agents express multi-hop queries declaratively: `expand: ['author.organization']` replaces three sequential tool calls.
- SSG and per-page render workflows materialize related data in one trip.
- Type-safe deep access: the generated `.d.ts` brands `$`-keyed fields as `EntityRef`, optionally narrowed to a target meta type; `expand` in scope narrows further to the resolved entity.
- "Where is this used?" and "What breaks if I delete this?" become first-class engine capabilities, queryable via MCP tools.
- Cache locality improves — one entry per page-shaped query beats N atomic entries that invalidate independently.

**Harder:**

- The canonical/normalized boundary has to land in the right places. A new render plugin that bypasses the engine-provided context wrapper would expose `$`-keys to templates. Mitigation: the engine is the only producer of render contexts.
- The api implementation grows a recursion phase for expansion. Cycle detection, depth tracking, and limit enforcement need test coverage.
- Consumers must handle "ref at deepest path still a string" as a valid outcome. The shape is consistent — entity-or-string at every expanded position — but branch handling sits with the caller.
- Cache invalidation depends on `runtime.refs`, which is engine-level and always available — no plugin coordination needed.
- Plugins that round-trip entity meta need a `runtime.writeEntity` helper (or re-add `$` themselves when writing). Helper ships with the convention.
- Generated TS types gain a generic parameter for requested expand paths. More complex types, type-safe consumption.
- One more rule for new authors and AI agents — though the rule is "if it's a reference, put `$` on the key."

## Examples

**Article schema, two adoption levels:**

```js
// Minimal — existence validated, EntityRef branding in .d.ts
import { z } from 'zod'
export default z.object({
    layout:  z.literal('article'),
    title:   z.string(),
    $author: z.string(),
    $hero:   z.string().optional(),
})

// Typed — existence + target-type validated, EntityRef<T> branding
import { z } from 'zod'
import { entityRef } from 'mikser-io-schemas'
export default z.object({
    layout:  z.literal('article'),
    title:   z.string(),
    $author: entityRef('author'),
    $hero:   entityRef('image').optional(),
})
```

**Templates — unchanged across the migration:**

```handlebars
<article>
  <h1>{{ meta.title }}</h1>
  <p>By {{ meta.author }}</p>     {{!-- $author on disk; normalized here --}}
  <img src="{{ meta.hero }}">      {{!-- $hero on disk; normalized here --}}
</article>
```

With `expand: ['author']` in the SDK call, `{{ meta.author.meta.name }}` works against the same template input.

**Generated types:**

```ts
export type ArticleMeta = {
    layout: 'article'
    title:  string
    author: EntityRef<AuthorMeta>     // branded from $author
    hero?:  EntityRef<ImageMeta>      // branded from $hero
}
```

`EntityRef<T>` is a branded `string`; runtime stays a string, the type system carries target info.

**One-trip multi-hop via MCP** (tool provided by the [`mikser-io-mcp`](https://github.com/almero-digital-marketing/mikser-io-mcp) plugin):

```
mikser_read_entity({
    id: '/blog/launch',
    expand: ['author.organization', 'hero'],
})
```

Returns the article with hydrated author, author's organization, and hero image. Two follow-up tool calls saved.

**Mixed nesting and iteration:**

```js
const landing = await client.entities('public').read_entity({
    id: '/',
    expand: ['sections.*.image', 'sections.*.cta.target'],
})

landing.meta.sections[0].image       // image entity
landing.meta.sections[0].cta.target  // target entity, if cta is present
```

**Refs plugin lookups:**

```
mikser_refs_inbound({ ref: '/authors/dick' })
→ [{ id: '/blog/launch', field: 'author' },
   { id: '/blog/follow-up', field: 'author' }]

mikser_refs_outbound({ id: '/blog/launch' })
→ { author: '/authors/dick', hero: '/images/launch-hero' }
```

**Validation outcomes (Phase 1):**

```yaml
# All of these are warnings from the schemas plugin, not parse errors.
# The engine continues; the entity stays in the catalog; renders complete.

$author: 42                       → WARN  shape: value must be string or string array
$author: /authors/never-existed   → WARN  existence: target does not resolve
author: X
$author: Y                        → WARN  collision: both forms declared; $author wins in projection
$author: /authors/dick            → (typed: entityRef('author'))
   where /authors/dick is layout=image → WARN  target-type: expected layout 'author', found 'image'
```

Each warning lives in the pending map until the next cycle re-evaluates it. Surface via logs, `mikser://schemas/pending`, and (Phase 2) via an MCP tool.

**Hard failure modes (Phase 2 — expand):**

```js
expand: ['title']           → 422 (not a $-field)
expand: ['a.b.c.d.e.f']     → 422 (exceeds maxDepth)
```

Expand-time errors are different from ref-validation: a malformed `expand` parameter is a programming error in the calling code, not a content-edit state. Those fail hard.

## Watch for drift

The convention and the expansion are protected by the same disciplines. Drift modes to recognise:

- **"Let's normalize in the catalog so plugins don't have to think about it."** The catalog stays canonical because the schemas plugin, `runtime.refs`, and the api filter dispatch all need the marker. The render context wrapper is the right place for normalization.
- **"Let's allow `expand: ['*']` to expand everything implicitly."** Implicit unbounded expansion silently makes every GET walk the catalog. Callers should name what they want; the cost should be visible at the call site.
- **"Let's add `_originalRef` to expanded objects."** Skip until somebody needs it. The expanded entity carries `id`, which IS the original ref by A2's href convention.
- **"Let's support selection sets per-expand."** That's GraphQL. The existing `fields` parameter handles projection across expanded paths; richer DSL is a separate concern. `expand` is not the surface for it.
- **"Let's allow deep PUT — sending a nested object updates referenced entities too."** Hard no. Writes go to one entity at a time, with refs as strings. ADR-0002.
- **"The cycle break is silent; let's mark it."** Decision is clean response shape. New feature flag if a class of consumer genuinely needs to distinguish.
- **"A consumer reads `entity.meta` directly from the catalog and silently misses the `$author:` value."** Mitigation: consumers go through the engine's surfaces (render context, SDK, api), which normalize. Direct catalog access in third-party plugins should be documented as receiving canonical meta.
- **"Let's accept `$author: { name: 'Dick', href: '/authors/dick' }`."** No. Value is always string or string array. Mixing data into a `$`-key breaks the reverse index and the AI-readability story.
- **"Let's make ref-validation errors fail the build."** The whole A6 model exists because that's wrong. Broken refs are routine mid-edit state — error-on-broken-ref fights the file-based editing model. Keep them as warnings, re-evaluated per cycle. If a CI step needs "no broken refs allowed," it queries `mikser://schemas/pending` after a clean build and exits non-zero on non-empty.
- **"Let's validate at parse-time so we catch it earlier."** Parse-time validation can't tell "broken because target doesn't exist YET" from "broken because target will never exist." The schemas plugin's deferred + retried model handles both gracefully; parse-time validation only handles the second case and breaks the first. Don't reintroduce.
- **"Refs by id would be nice."** A different addressing scheme is a new ADR. Don't smuggle ids in via the `$` convention.
- **"Should refs go back to being a plugin?"** It started life as one (Phase 2 of ADR-0007). It moved to the engine after the third consumer turned up: api expand, schemas re-validation, and live-expand SSE all needed the same inverse-graph lookup, each carrying a soft-dependency check. ADR-0006's five-test cleared it as substrate. The catalog comparison is the test — both are derived projections of files, both are infrastructure other plugins query against. If the analysis ever flips, this is where it would be re-litigated.
- **"Implicit array traversal in expand would be less noisy than `*`."** Would also be ambiguous when a field is sometimes object and sometimes array. Explicit `*` costs one character; saves the ambiguity.

The principle: canonical lives on disk and in the catalog; normalized is presented to render engines and the SDK; expansion is opt-in per call, bounded, read-only. Every guardrail removes a way the feature could erode the file-based ethos.
