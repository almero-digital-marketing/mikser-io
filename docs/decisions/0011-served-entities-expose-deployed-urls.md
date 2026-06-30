# ADR-0011 — File and resource entities expose deployed URLs

**Status:** Accepted — implemented (`meta.url` resolution + `meta.url` / `meta.presets` stamps + `lookupUrl` render helper) and proven end-to-end against the first consumer (gpoint)
**Date:** 2026
**Supersedes:** —
**Superseded by:** —
**Builds on:** ADR-0007 (`$`-references + `expand`), ADR-0006 (five-test)

## Context

Mikser content carries two kinds of references. ADR-0007 covered the first:
references to other **documents** — an article's author, a section's related posts
— declared with `$`, resolved by `expand`, indexed by `runtime.refs`.

The second kind points at **served files** — an image, a video and its transcoded
derivatives, a PDF. These targets aren't documents you read; they're binaries you
link to. Today they're plain strings, and the consumer turns each into a URL by
*knowing* which of two rules applies:

```yaml
image:  /img/products/X.jpg     # a files/resources path → baseUrl + path
video:  /media/bg/products/X.mp4 # a transcoded source → reconstruct
poster: /img/products/X.jpg      #   baseUrl + /assets/<preset>/<source>, client-side
```

Nothing in the data says which field is which. A developer learns it; an AI agent
guesses; both get it wrong. The gpoint migration hit this repeatedly — a content
image bound without the base prefix silently resolves to the SPA's HTML fallback,
and a derivative reconstructed with the wrong rule renders blank. Worse, the
reconstruct-client-side rule **only works for a consumer that has the logic**. An
email render, an SSG's raw output, an RSS reader, a foreign app reading the catalog
JSON, an LLM ingesting content — none can run `assetUrl()`. They need the URL in
the document.

Encoding the reference *kind* in a scheme (`mikser://file/…`) fails the same
consumers: a scheme needs a resolver, and the point is that some consumers don't
have one. Mikser already answered this for routes — `meta.href` (logical) +
`meta.route` (deployed), **both** in the document — and references to served files
are the same shape: resolution belongs upstream, and the deployed form rides along.

**A note on naming.** "Asset reference" is already taken — the `assets` plugin
handles *"asset references and copy"* and `resources` handles *"resource
references."* This ADR is broader than the `assets` plugin: the deployed URL of a
served file is its served path (from `files`/`resources`) **plus**, *if* the
`assets` plugin matched it, its preset derivatives. To avoid the collision, this ADR
uses **served entity** for the umbrella — a file, resource, or asset-plugin
derivative that resolves to a served URL, as opposed to a document you read — and
scopes the `assets` plugin to the `presets` portion only.

## Decision

### A — References to served entities are `$`-keyed served paths (= the entity's `meta.url`)

A reference to a served file is a reference whose target is a `files`/`resources`
entity. It declares with `$`, so ADR-0007 A1 and A3–A6 apply unchanged —
detectable without schemas, indexed by `runtime.refs`, rename-cascaded, normalized
(`$` stripped from the key) at the render/SDK boundary, deferred warning-only
validation.

The value is the **served path** — the URL the content author actually writes — and
it equals the target entity's `meta.url`. It resolves through a new `refFilter`
clause `{ 'meta.url': refValue }` (added to the existing `$or` in utils.js), backed
by an indexed `meta_url` column on `mikser_entities` (catalog.js + the
`INDEXED_COLUMNS` map in sift-to-sql.js; schema bumped 9.0.1 → 9.0.2 so existing dbs
auto-rebuild).

```yaml
$image:  /img/products/X.jpg
$video:  /media/bg/products/X.mp4
$poster: /img/products/X.jpg
```

The extension stays in the value because, unlike a document ref (`$author:
/authors/dick`, dropped because the `.md` renders to `.html`), a file doesn't change
extension — `X.jpg` *is* the file, and the extension disambiguates `X.jpg` from
`X.png`. The reference is the path content authors write, and the same path ships in
the deployed markup; no collection-prefixed entity ids (`/files/img/…`,
`/storage/media/…`) leak into content. That path also lives on the resolved entity as
`meta.url` (Part B), so the ref and the deployed path are one value, not a transform
the consumer derives.

### B — A served entity carries its deployed URL(s) in meta; `expand` surfaces them

The difference from a document ref is only what the resolved target *carries*. The
`files`/`resources` plugins own the path they serve and stamp it as `meta.url` — the
served location, the same path content references (a `files` entity's id minus its
collection prefix; a `resources` entity's served location from its library). This is
also the value the `meta.url` `refFilter` clause matches on (Part A), so a ref and
its target meet at one path. The `assets` plugin owns the preset outputs and stamps
them as `meta.presets`. Both at `onProcessed`, where the paths are known:

```yaml
# files entity, id /files/img/products/X.jpg
url: /img/products/X.jpg                 # served path — what content references

# media entity (resources library matching /media/**), served path + assets presets
url: /media/bg/products/X.mp4
presets:
  product: /assets/product/media/bg/products/X.mp4
  poster:  /assets/poster/media/bg/products/X.jpg   # ext swapped per preset `format`
  small:   /assets/small/media/bg/products/X.mp4
```

`expand` resolves the served-path ref to the served entity via the `meta.url` clause
(ADR-0007 B3, no special case), so the referencing entity reads:

```js
meta.image.meta.url             // /img/products/X.jpg
meta.video.meta.presets.poster  // /assets/poster/media/bg/products/X.jpg
```

Resolution collapses to **one rule** — `base + path`. Preset *selection*, the part
that needed knowledge, is now field access; nothing reconstructs a path. The source
file's extension is stable (`.mp4`); a preset's output may differ (`.jpg` poster),
but that derivative extension is the `assets` plugin's computed output (the preset
module's `format` export), enumerated in `presets`, not something a consumer
derives.

### C — base-relative in the catalog, absolute in static renders

The deployed path is **base-relative in the live catalog**, **absolute in static
renders** — one resolver, two serializations:

- The api/catalog projection emits base-relative paths (`/assets/poster/…`). They
  are host-agnostic, so the catalog survives dev/prod/CDN swaps; the live consumer
  (an SPA) holds the single config value `base` and concatenates. A variable, not a
  logic layer.
- Render outputs (email via `post-mjml`/`post-email`, SSG HTML, PDF) bake
  **absolute** URLs from `runtime.options.url` at render time. A logic-less consumer
  of a rendered output needs nothing — the URL is already whole.

Exactly how `meta.route` is relative in the catalog but an absolute-URL sitemap
render emits the full origin.

### D — The SDK collapses to a single `url(ref)` join

`assetUrl(source, preset, { ext })` — client-side URL construction encoding the
preset/ext rules — is removed. `useAsset()` becomes a `base + path` join, identical
to the content-file join, so `MIKSER_URL + path` and `assetUrl(...)` converge:

```js
const { url } = useMikser()
url(product.image.meta.url)             // base + /img/products/X.jpg
url(product.video.meta.presets.poster)  // base + /assets/poster/…X.jpg
```

This is not a helper that hides the origin — the field literally shows
`/assets/poster/…`. The value declares where it comes from; there is nothing to
hide. (Contrast the rejected `cmsImage()`, whose problem was concealment.)

### E — Dev-mode safety net: detect the SPA-fallback signature

Every failure in this class has one signature: an `<img>`/`<video poster>` whose
response is `text/html` (the SPA's index.html fallback) or whose `naturalWidth` is
0. A dev-mode guard in the framework SDKs catches it at first paint and names the
likely cause ("`/img/products/X.jpg` resolved to the SPA fallback — missing base
prefix, or an unexpanded reference?"). It is the backstop for the one residual
mistake — forgetting the base, or leaving a ref unexpanded — and would have caught
both the content-file sweep and the poster bug from the gpoint migration on first
render.

## Five-test (ADR-0006)

1. **Substrate** — yes. Resolution rides ADR-0007's `expand` path and
   `runtime.refs`; the deployed-URL projection is the same shape as `meta.route`.
   Infrastructure every consumer queries against.
2. **Strengthens strategy** — yes. "Content usable by outputs that have no logic
   layer" is the files-as-source-of-truth + renderer-agnostic-mixer value prop — the
   served-file analogue of why routes carry both forms.
3. **God-plugin check** — passes *because the engine stays thin*. The
   `files`/`resources` plugins stamp `meta.url`; the `assets` plugin stamps
   `meta.presets`. Each owns the paths it already produces. The engine only projects
   and serializes per target. If the engine starts owning preset policy, the test
   has flipped.
4. **Composability** — yes. Transcode/preset plugins still produce derivatives; they
   additionally record the URL. `expand` and `runtime.refs` are untouched. A new
   served-file producer (a `renderBlender` emitting a `.glb` + thumbnails)
   participates by stamping the same `url`/`presets` meta.
5. **Release cadence** — the weak one, stated honestly. This is a data-shape change:
   consumers read expanded `meta.X.meta.url` instead of constructing. Pre-v10
   freedom (no users, no back-compat — CLAUDE.md) covers the coordinated change;
   post-v10 this would need a deprecation window.

Conjunctive result: passes, with #5 as the watch point.

## Implementation sketch

The pieces already exist; this wires them.

- **Declaration** — `extractRefs(meta)` (utils.js) already finds every `$`-ref and
  feeds `runtime.refs`. `$`-keying a served-file field (value = served path) makes
  its target show up in the inverse index with zero new code, so "this product
  references this video" is queryable and a re-transcode invalidates the product's
  cached expansion.
- **Resolution** — the `refFilter` `$or` (utils.js) gains a `{ 'meta.url': refValue }`
  clause so a served-path ref resolves to the entity that serves that path; its
  symmetry partner `matchesRef` covers the in-hand-entity test. Backed by an indexed
  `meta_url` column on `mikser_entities` (catalog.js `CREATE TABLE` + the
  `idx_mikser_entities_meta_url` partial index) and an `INDEXED_COLUMNS` entry
  (`'meta.url' → meta_url`, sift-to-sql.js) so the clause pushes down instead of
  scanning. Schema bumped 9.0.1 → 9.0.2 (the stamp tracks `package.json`), so the
  table auto-rebuilds on existing dbs.
- **Projection** — the `files` plugin stamps `meta.url = '/' + name` (served path) at
  all three emission sites (`onSync` create/update, `onImport` bulk). The `resources`
  plugin stamps the served location its library produces. The `assets` plugin stamps
  `meta.presets` in `onProcessed` where `getEntityPresets(entity)` knows the matched
  presets, via the pure `presetUrl(...)` helper that mirrors `renderPresets`'
  destination (`/<assetsFolder>/<preset>/<name>`, extension from the preset module's
  `format`). Base-relative; auto-persisted by `useJournal` (mutate-and-move-on).
- **Expansion** *(free)* — `expandEntity` / catalog.js `expandAndProject` · `findRef`
  resolve the served-path ref to the target entity via the `meta.url` clause; the
  carried `url`/`presets` meta rides along. No special-case — a served entity is just
  an entity whose meta holds deployed URLs.
- **Render helper** — `lookupUrl` (render.js) is a sync Handlebars helper resolving a
  served-path ref to its `meta.url`, or `lookupUrl ref 'poster'` to a named preset,
  against the worker's read-only sqlite handle — for render outputs that read the ref
  directly rather than an expanded field.
- **Serialization** — a thin step prefixes `runtime.options.url` for static-render
  targets (the render-context wrapper at `engine.js`, beside `projectMeta`), leaving
  base-relative for the api/catalog projection (`catalog.js`).
- **SDK** — `mikser-io-sdk-api` drops `assetUrl`'s preset/ext construction; `url(ref)`
  is `joinUrl(baseUrl, ref)`. The three framework SDKs re-expose it and add the
  dev-mode fallback detector. Land in parity; verify each.

## Examples

**Authoring (a product inside `/system/products`) — refs are served paths:**

```yaml
products:
  - sku: GP-LSC-SPF50-HSO
    $image:  /img/products/GP-LSC-SPF50-HSO.jpg
    $video:  /media/bg/products/GP-LSC-SPF50-HSO.mp4
    $poster: /img/products/GP-LSC-SPF50-HSO.jpg
```

**SPA (live catalog, holds `base`):**

```js
const { items } = await client.list({
    filter: { 'meta.href': '/system/products' },
    expand: ['products.*.image', 'products.*.video', 'products.*.poster'],
})
// template:
//   :src="url(product.image.meta.url)"
//   :poster="url(product.video.meta.presets.poster)"
```

**Email render (absolute, baked):** the template reads the same field; the render
context has already prefixed `runtime.options.url`, so the output ships
`https://cms.example.com/assets/poster/…X.jpg` — the mail client needs no resolver.

**Foreign consumer (RSS/LLM/raw):** reads the served entity's `url` from the
expanded catalog response. With `?expand=…` on the GET it gets the path; from a
rendered feed it gets the absolute URL. Never constructs anything.

## Watch for drift

- **"Call these asset references — it's shorter."** The `assets` plugin already owns
  that phrase, and this spans `files`/`resources` too. Use *served entity*; scope
  *asset* to the preset derivatives.
- **"The extension distinguishes a file ref from a doc ref, so we can skip `$` and
  sniff."** No. `$` is the marker — what makes the reference detectable, indexable,
  and invalidatable (ADR-0007). A document ref and a served-file ref are *both*
  `$`-keyed; the extension is intrinsic to the file, not a type signal to sniff.
- **"Reference files by their collection-prefixed id (`/files/img/…`,
  `/storage/media/…`) — it resolves through the existing id clause with no engine
  change."** Tried, rejected. The first consumer (gpoint) exposed two fatal problems.
  (1) Content references everything by served path (`/media/…`, `/img/…`); the id is
  an internal artifact the author never sees — a collection prefix, plus a
  `resources()` `storage` library that prepends `/storage`. Forcing content to carry
  the id leaks engine bookkeeping into authored markup. (2) gpoint's videos flow
  through a `resources()` library matching `/media/**`, so the entity *only exists*
  because content references `/media/…` — switch content to the `/storage/media/…` id
  and the entity stops being created; re-point the library to make the id match and
  the change cascades into different preset output paths that break the
  already-transcoded assets. The tell: the entity's `meta.url` *is* the content path,
  so resolving by `meta.url` lets content keep its natural authored form. The old
  objection to `meta.url` resolution (href-namespace pollution) never applied —
  `meta.url` is a separate field from `meta.href`; the only real cost was that it was
  unindexed, which the `meta_url` column + partial index now covers. Don't
  reintroduce id-refs, and don't drop the `meta_url` index — that's the line between
  an indexed pushdown and a full scan on the hot resolution path.
- **"Just bake absolute URLs everywhere, simplest for consumers."** Absolute in the
  live catalog hard-codes the host into content and breaks dev/prod/CDN portability.
  Base-relative in the catalog, absolute only in static renders. The host is one
  config value, not a content fact.
- **"Add a `mikser://file/…` scheme so the kind is self-describing."** A scheme needs
  a resolver; the consumers that motivated this ADR don't have one. Carry the
  deployed form, the way routes do.
- **"Let the engine own preset policy since it's projecting the URLs."** No — the
  `assets` plugin owns presets (ADR-0003, ADR-0006 #3). The engine projects and
  serializes; it does not decide what a preset is. That separation keeps five-test #3
  green.
- **"Reconstruct the preset URL client-side, it's just string concat."** That is the
  rule this ADR removes. It looks harmless and is exactly the knowledge a logic-less
  consumer lacks. Selection is a field read; construction stays server-side.
- **"Drop the base-relative form and the dev detector once it works."** The detector
  is cheap and catches the single highest-frequency mistake (forgotten base /
  unexpanded ref) at first paint. Keep it.

The principle: served files are references like any other; resolution belongs
upstream in mikser where the deploy context is known; the document carries the
deployed form so a consumer with no logic layer can still read it. Every guardrail
keeps the deployed-URL projection from drifting back into client-side
reconstruction.
