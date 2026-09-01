# CLAUDE.md — mikser-io

Read this before proposing changes. Posture, architectural conventions,
and the landmarks that survive across sessions.

## Posture

**Until v10, mikser has no users.** No back-compat. No deprecation
paths. No migration markdown. No `task: pool` legacy aliasing for
`task: inline`. Update READMEs and ADRs in place as source-of-truth
changes; rewrite, don't supersede. The freedom is the point.

**v9 shipped. The gate now is daily-use payoff, not completion.**
The engine, every sibling plugin, the agency template — all live.
The next step isn't "finish v9," it's **use v9 in real daily work
until the workflow earns the v10 layer**. The v10 architecture
(party-mikser-io) is more fun to design than v9 dogfooding is to
sustain — the gate exists because that asymmetry kills projects.
Concrete pass/fail signals in `10.0-PLAN.md` under "The gate." If
a session brings up v10 design work, check the gate first; if v9
isn't paying out yet, the question to answer is "what about v9
isn't working in daily use?" — not "what should v10 look like?"

**mikser is a mixer.** The name is the architecture. It combines
inputs (entities — from files, forms, queries, anywhere) through
configurable rendering pipelines (renderer plugins + task-production
policies) into outputs of any kind. Static-site generation is the
canonical recipe — what mikser ships with and what most projects
use today — but it's a recipe, not the definition. The same
substrate runs:

- HTML SSG via `layouts` + `renderHbs` (the recipe everything else
  is currently shaped around)
- PDFs via `renderHbs` + `post-pdf` (puppeteer-driven)
- Emails via `renderHbs` → `post-mjml` → `post-email` (chain)
- 3D renders by composing a hypothetical `renderBlender` against
  `.blend` entities — same engine, different renderer + recipe
- Video / audio / archives / data-export — same shape

The engine has no opinion on what a renderer produces. `render.js`
and `postprocess.js` are abstract worker entries; `manifest.js`
tracks snapshots of *any* output; refs invalidation re-runs
*any* render task. SSG is the dominant case in v9 because it's
where the dogfooding lives, not because the architecture only
fits there. When proposing changes, hold the broader view: a
change that helps SSG but blocks the Blender/video/audio/archive
cases is constraining the engine's actual reach.

**Position mikser by what it is, not by speed.** Hugo wins the
speed race for SSG specifically; mikser doesn't compete there
(and "fastest mixer" isn't a useful claim because the bottleneck
is the renderer, not the engine). Secondary attributes that
follow from the mixer framing: AI-native, lifecycle-observable,
files-as-source-of-truth, full-cycle introspection. Speed claim
cap: "fast enough that watch-mode rebuilds feel instant." Honest
range: 200–800 docs/sec on the SSG-flavor pipeline depending on
corpus size (see `test/perf/`).

**Direct critique preferred.** Skip "great question," skip "solid but,"
skip softening. When something didn't pay off, say so. Match user
brevity.

## Module map (`src/`)

- `runtime.js` — singleton, holds engine state (`runtime.catalog`,
  `runtime.refs`) and `runtime.options`. Lifecycle hook arrays live
  here.
- `lifecycle.js` — hook registration: `onLoad`/`onLoaded`/`onProcess`/
  `onProcessed`/`onPersist`/`onBeforeRender`/`onRender`/`onAfterRender`/
  `onBeforePostprocess`/`onPostprocess`/`onComplete`/`onFinalize`/
  `onFinalized`/`onCancel`/`onCancelled`. Plus `runtime.create`/
  `.update`/`.delete` (journal helpers).
- `journal.js` — per-cycle queue, persisted to `mikser_journal` rows in
  `runtime/mikser.sqlite`. Drained at onFinalized; survives crashes so
  `--resume` (`-R`) can pick up unfinalized entries on the next start.
  Same public surface: `addEntry`/`addEntries`/`updateEntry`/
  `useJournal`/`clearJournal`. Inserts `JSON.stringify` the row body for
  snapshot isolation (replaces the prior `structuredClone`). Walks are
  chunked (`CHUNK_SIZE=500`) so peak journal memory stays bounded
  regardless of corpus.
  **Auto-persist:** `useJournal` diffs the yielded entity after each
  iteration and UPDATEs the row if it changed. Plugin authors mutate
  the yielded entity and move on — no explicit `updateEntry({id,entity})`
  required. `updateEntry` is still exported for engine-internal writes
  (output, deps) and as a no-op safety valve for plugins that prefer to
  call it; if the entity hasn't drifted, the auto-persist skips.
- `catalog.js` — entity persistence in the `mikser_entities` table of
  `runtime/mikser.sqlite`. Indexed columns: id (PK), collection,
  type, format, name, meta_href, meta_layout, meta_lang, meta_cache,
  time, uri. Full entity body in `data` (JSON TEXT). 10k-entry LRU
  cache in front of `findById`. Public ops: `findEntity`,
  `findEntities`, `iterateEntities` (streaming async generator over the
  same query shape, seek-paginated — use it when results may be
  corpus-scale and the caller doesn't need an array), `queryEntities`,
  `readEntity`, `subscribe`, `assertExpand`. Expand internals
  (`expandLimits`, `expandAndProject`, `findRef`) are PRIVATE.
  All three readers accept either a sift object or a **function**
  predicate; a function cannot be pushed into SQL, so it forces a full
  scan and a JSON.parse per row — prefer an object, and `refFilter(ref)`
  for the "resolve a ref string" case. `refFilter` / `matchesRef` /
  `lookupKeys` are one relation in three directions (query, predicate,
  reverse) and must be changed together: `meta.url` once lived in only
  the first, which made every `$`-ref to a served path silently
  non-invalidating. `test/unit/utils.test.js` property-tests the
  symmetry.
- `subscriptions.js` — `subscribe()` primitive. Two modes: journal-
  walk dispatch (default) and graph dispatch via
  `runtime.refs.subscribeGraph` (when `expand` is set).
- `refs.js` — inverse-reference graph (`$`-keyed refs per ADR-0007).
  Persisted as `mikser_refs` rows with FK on `source_id` to
  `mikser_entities` (`ON DELETE CASCADE`); indexed on `target_ref`
  and `target_id`. Each row carries BOTH the string asked for
  (`target_ref` — an id, `meta.href`, `meta.url`, or id-minus-
  extension) and the entity it resolved to (`target_id`, `''` when
  nothing did). Both are load-bearing: a name alone cannot survive the
  target renaming itself, and an id alone cannot express a forward or
  dangling reference. `inverseClosureOf` takes the union of a name
  query and an identity query, so it is a superset of name-only
  matching. Kinds: `ref` (static `$`-ref, owned by `indexEntity`),
  and `layout` / `partial` / `query` / `lookup` (render-time, owned by
  `replaceDynamic`) — the clears divide on `kind = 'ref'` vs
  `kind != 'ref'`, so a render-time edge must never use `ref`.
  Exposed at `runtime.refs.*`: `inboundFor`, `outboundFor`,
  `dynamicInboundFor`, `dynamicOutboundFor`, `allRefs`, `size`,
  `rename`, `inverseClosureOf`, `resolveRefIds`, `replaceDynamic`,
  `clearDynamic`, `subscribeGraph`, `subscribeQuery`. Plus `refExists`
  module-level. `REFS_SCHEMA` is exported so tests build against the
  real schema instead of a copy. Prepared statements through the
  shared sqlite handle.
- `engine.js` — `setup()`, lifecycle wiring, render + postprocess
  dispatchers, manifest tracking. Owns the Piscina worker pools
  (`renderWorkers`, `postprocessWorkers`); both are lazy
  (`minThreads: 0` + `idleTimeout: 30_000`) so INLINE-only workloads
  pay no worker overhead. `workerSafeOptions(runtime.options)`
  strips plugin-surface functions before TASKS.WORKER dispatch so
  Piscina's structured clone doesn't choke. Renderer / postprocessor
  descriptors in `runtime.options.plugins` are projected to their
  `render-${name}` / `post-${name}` identifier so workers can
  resolve them via dynamic import.
- `database/index.js` — the CACHE only. `createSqliteDatabase()`,
  `registerSchema()`, `useDatabase()` (the `mikser_meta` table stamps
  schema_version). Nothing durable lives here any more.
- `database/durable.js` — the durable store. `registerMigrations()`,
  `useDurableDatabase()` (a knex instance), `runMigrations()`,
  `closeDurableDatabase()`. `ensureIgnored` adds the file to `.gitignore`
  (it holds credentials and the working folder is usually a repo).
  **No upgrade path from the pre-split layout** — per the posture above,
  a working folder from before 9.56 loses its grants and change-set log
  to the ordinary cache wipe, and everyone signs in again once.
  `sift-to-sql.js` translates sift filters to SQL WHERE clauses
  against `INDEXED_COLUMNS`; un-pushed clauses fall through to
  JS-side sift. `query-context.js` is the AsyncLocalStorage that
  lets catalog queries auto-report into the render-time `track`.
- `manifest.js` — render snapshots in `mikser_snapshots` table
  (PK `(id, destination)`, `refClosure` as JSON, partial index on
  `parent`). `recordedHashes` aggregates dep hashes via
  `json_each` in C rather than parsing every row in JS.
- `server.js` — Express bring-up: CLI flags (`--server`, `--cors`,
  `--no-cors`), trust-proxy, CORS (with extensible header arrays for
  plugins to push onto), late-binding static mount + listen.
- `report.js` — the `--json` build report. `invalidated` says WHY the
  build did work (`nothing` / `sources` / `config` / `version` / `clear`),
  recorded where each is decided — `reportWipe` in database/index.js,
  `reportChanged` in source.js as the complement of `reportGated`.
  `evaluated` is what a subsystem looked at vs what exists
  (`reportEvaluated`), generalised from assets' matchTally. `warnings` is a VIEW of
  `logger.warn`; `faults` is a view of `logger.error` **carrying a
  `code`** — a subsystem declaring it cannot work, deduped by that code,
  never cleared per cycle, and surfaced in `mikser_ping`. The log call is
  the only registration for either; there is no `reportWarning()` or
  `registerFault()` and there must not be.
- `logger.js` — pino + pino-pretty (inline) + gauge progress + custom
  Writable for progress coordination + `pino.multistream` for
  third-party shipping. Two registration surfaces for transports:
  - `runtime.config.logging.transports` — declarative; user config.
  - `addLogTransport({ target, options?, level? })` — public export;
    plugins call this from their factory (queues until logger build)
    or any later hook (live-rebuilds the multistream + swaps
    `runtime.engine.logger`). `useLogger()` reads the swap-target
    fresh on each call so new transports start receiving records
    immediately. Both surfaces compose; same `{level, target, options}`
    shape. Enables Better Stack / Datadog / Loki / Axiom / Sentry as
    standard sibling plugins without engine changes per vendor.
- `utils.js` — shared pure helpers: `mimeForEntity`, `isLoopback`,
  `expandEntity`, `projectMeta`, `useCollection`, `useRenderer` (via
  render.js), `isTextEntity`, `readEntityContent`, `extractRefs`,
  `isRefKey`, `writeEntity`, `matchEntity`, `getFormatInfo`,
  `changeExtension`, `checksum`, `normalize`, `formatErrorContext`,
  `formatLogArgs`, `ExpandError`, `AbortError`.
- `src/plugins/render/file.js` — the template filesystem helpers
  (`readFile`, `jsonFile`, `glob`). Every read RECORDS a query edge by
  default; `{ track: false }` opts out. Keyed on **`id`, never `uri`** —
  for a `files` entity `uri` is the DEPLOYED path, so a uri edge matches
  nothing for the commonest case. `glob` records the PATTERN as a regex
  over ids, not the matched paths, so a file appearing later still
  invalidates. Paths resolve against `options.workingFolder` — the
  render-time `runtime` is a per-render projection with no options on it.
  The "this file has no entity" warning reads `options.sourceFolders` —
  the set useSource records as it registers each collection — NOT a list
  of folder names written in the plugin. A hardcoded list misses every
  collection a project registers through `sources()`, which produced 63
  false warnings per build on a real site.
- `src/plugins/render/asset.js` / `resource.js` — URL helpers that BUILD
  a path from a naming convention instead of looking an entity up, so
  they cannot fail: a preset that never ran yields a well-formed link to
  nothing on a green build. Each records its destination via
  `track.asset()`; `engine.js` checks the collected set against
  `outputFolder` in `onFinalized` (`reportAssetUse` / `assetUse` in
  report.js, `reportMissingAssets` in engine.js), warning under
  `asset-missing` / `asset-missing-summary`. `existsSync` FOLLOWS
  symlinks, which is required — the assets folder is deployed into the
  output as a symlink. Handlebars appends an options object to every
  helper call, so a trailing optional arg (`format`) must be discarded
  when it looks like one (`'hash' in format`); without that, `asset 'web'
  '/x.jpg'` built `/assets/web/x.[object Object]` — the bug the finalize
  check found on its first run, present since the helper took a format.
- `matchesLibrary` (utils.js) — a resources library key is a REGEX source
  (`escapeStringRegexp(url)`), and it has two consumers: the plugin's
  discovery walk, which decides what to DOWNLOAD, and the `resource` render
  helper, which builds the url. They read the same string with two matchers
  — discovery used `matchEntity`, a GLOB demanding a full match, so a key
  derived from `url` (a bare prefix, no trailing wildcard) matched nothing
  and NO url-declared library was ever fetched, while the helper kept
  building links to the missing files. Green build, missing images; found
  when the reference check read the output back. Both now call one function
  so they cannot drift.
- `references.js` — the OTHER half of the broken-link answer: reads the
  EMITTED output (html + css) and resolves every `src` / `href` / `poster`
  / `srcset` / `url()` the way a browser does. Complements
  `reportMissingAssets`, which reads the render track — that one sees urls
  that never reach an html file (a feed, a sitemap) and knows the entity;
  this one sees paths written by hand and can tell BROKEN (resolves to no
  file) from OVER-DEEP (resolves only because a `..` run was floored at the
  site root — loads today, breaks one nesting level deeper). Where both can
  see a file the scan wins and the track check is skipped, so one problem
  is one warning. Codes: `reference-broken` / `reference-over-deep` plus
  summaries. `runtime.config.siteRoots` declares which subtrees deploy as
  their own domain root; it CANNOT be derived — it is a fact about
  deployment, not about the bytes — and resolving a per-language build
  against the output root reports every working url as broken. Skips other
  origins, `data:`, fragments, percent-encoded externals
  (`https%3A%2F%2F...` in a query param) and unrendered template syntax.
  Decodes `&quot;` first: a CSS custom property in an inline style is
  `url(&quot;../x.svg&quot;)`, and left encoded the entity text becomes the
  path. 434 references over a real site in ~20ms.
- Postprocess failures are RENDER ERRORS. The dispatcher's catch used to
  log one uncoded `Postprocess error:` line and stop there — exit code 0,
  nothing in `--json` `errors`, `🟢 Mikser completed`. A build missing
  every PDF it was asked for reported success. It now calls `reportError`
  with the failing `postprocessor`, so a stage that wrote no file counts
  the same as a render that threw. `entity.origin` is deliberately NOT
  unlinked on failure (it is on success): a retry needs it as input, and
  for a converter it is real content.
- `render.js` / `postprocess.js` — Piscina worker entry points AND the
  default-export functions the INLINE/SERIAL dispatcher calls directly.
  Each receives entity + options + config + state; the WORKER path also
  receives a MessageChannel `port` that forwards pino records back to
  the engine's logger. Each worker opens its own read-only sqlite
  handle on first task (`ensureWorkerDb` in render.js) so template
  helpers like `runtime.lookupHref` stay sync. Never touch the journal
  directly. Plugin loading: main-thread INLINE dispatch reads
  `runtime.renderers` / `runtime.postprocessors` first (populated by
  plugins.js from descriptor returns); workers see empty registries
  in their separate-process runtime and fall through to dynamic-import
  by `mikser-io-${name}` package name. Per-plugin options flow through
  `descriptor.options` and arrive as the `config` arg to
  `load`/`render`/`setup`/`postprocess`/`teardown`.
- `config.js` — loads `mikser.config.js` at `onLoad` into
  `runtime.config`. The cache-invalidating stamp covers the config's whole
  local module graph, captured via `module.registerHooks` during the import
  (Node 22.15+; older runtimes fall back to the entry file and warn). Scoped
  to the config's own directory — `node_modules` alone is not enough of a
  filter, because a workspace symlinks its siblings outside it. Coverage is
  published at `runtime.options.configCoverage` and in the build report. v9 holds only engine-level keys (`server`,
  `logging`, `catalog` if tuned) plus the `plugins` array — all
  plugin options moved to the factory call site (ADR-0010).
- `plugins.js` — dispatches v9 plugin entries at `onLoad`. Each
  entry in `plugins: []` is a factory call return; the dispatcher
  duck-types on shape:
  - function → lifecycle plugin; called with `core` so it can
    register hooks.
  - `{ name, options, load?, render? }` → renderer descriptor;
    stored in `runtime.renderers`.
  - `{ name, options, postprocess, output?, setup?, teardown? }` →
    postprocessor descriptor; stored in `runtime.postprocessors`.
  Strings produce a v9 migration error pointing at the new shape.
- `instance.js` — one engine per working folder. A second `mikser` in a
  folder a watcher holds FORWARDS its build over a unix socket and wears
  the instance's log output and exit code; `--no-attach` opts out and
  warns. Socket lives in `os.tmpdir()` keyed by a hash of the resolved
  working folder — NOT under `runtime/`, because sun_path caps a socket
  path at ~107 bytes and a nested working folder fails as `listen
  EINVAL`. chmod 0600, so the filesystem permission is the access
  decision. A forwarded build RESCANS (`runtime.rebuild()`), never
  drains: a client can beat the inotify event for the file it just
  wrote. Report-only commands (`--tool`, `--tools`, `--verify`,
  `--explain`) forward too — they read, so a local run damaged nothing,
  but a catalogue another process is mid-write in is not one anyone can
  answer from. `runReportOnly()` in engine.js is the one implementation
  both paths call. `--server` / `--watch` are NOT forwardable — they ask
  to BECOME the instance, and a running engine cannot open a port on
  someone's behalf — so they exit 1 with a message when one is already
  there. Exit code comes from `renderErrorCount()`, not
  `process.exitCode` — the engine suppresses that in watch mode by
  design. Config mismatch is refused by resolved PATH; config drift
  under a running instance is detected by stat over `configCoverage`.
- `manager.js` — file watching (chokidar) and cron scheduling. `watch()`
  turns file events into SYNC events — it is how a source folder becomes
  entities, so pointing it at the output folder feeds output back in as
  input. `watchFolder(folder, handler, options)` is the primitive without
  that meaning, for a plugin that only needs to know bytes changed; it
  carries the shared junk filter and `followSymlinks: true`, which is
  load-bearing because the files plugin serves by symlinking into the
  output folder.
- `source.js` — `useSource` codifies the folder-of-files pattern.
- `tools.js` — tool registry. `registerTool(name, {description,
  inputSchema}, handler)` / `toolNames()` / `toolSchema()` / `invokeTool()`,
  stored on `runtime.tools`. There are TWO agent workflows — one speaking
  MCP over HTTP, one running the CLI and reading its output — and every
  tool used to live in the mcp plugin, reachable only through a session,
  so the CLI agent saw a much smaller engine. The registry is substrate
  and the transports are consumers: `--tools` / `--tool` dispatch through
  it, mcp mirrors its registrations into it, and a tool registered by any
  plugin reaches both surfaces with no per-tool CLI code. MCP keeps the
  tools themselves, the transport, sessions, resources and prompts.
  Dispatched at `onImport`, not `onLoaded` — the engine's own onLoaded is
  registered during setup(), ahead of the plugins that register the tools.
- `builtin-tools.js` — the engine's own diagnostics as tools
  (`mikser_explain`, `mikser_verify`, `mikser_build_report`). Registered
  by the engine, not by mcp, so `--tool mikser_verify` works on a bare
  engine exactly as `--verify` does. Schemas use a neutral
  `{ type, required?, description? }` vocabulary; mcp converts to zod at
  bind time, because the registry must not depend on one transport's
  schema library.
- `provenance.js` — where a value was WRITTEN: source, field path, line,
  column. Formats register (`registerProvenanceFormat` / `probeFormat`)
  rather than being special-cased; yaml/json/front-matter use the `yaml`
  parser's ranges, and anything without ranges uses the one-pass uuid
  probe. Field paths are free; line/col is computed on demand and cached
  in `mikser_provenance` against the entity's checksum, so a build pays
  nothing.
- `routes.js` — HTTP route registry. Plugins mount on
  `runtime.options.app` directly; the Express router stack has the
  paths but not the intent (loopback-only? streaming?). So plugins
  declare each mount via `registerRoute({ path, plugin, reachability,
  streaming })` as they make it. `reachability` is `public` | `token`
  | `loopback`; `streaming` flags SSE/WS routes a facade must not
  buffer. Inventory lives at `runtime.routes`; consumers (a Caddy/nginx
  facade generator, healthcheck list, `mikser://routes` resource) read
  it — none baked in. `registerRoute` also folds in the origin/location
  URL building and the standard `"<label> mounted: <loc>
  [<reachability>]"` boot log that api/preview/mcp/vector/forms/decap
  were each copy-pasting. Pure inventory — takes no position on what to
  do with the routes.
- `constants.js` — `OPERATION` (CREATE/UPDATE/DELETE/RENDER/
  POSTPROCESS), `ACTION` (sync action types), `TASKS` (`INLINE`/
  `SERIAL`/`WORKER` — dispatch modes).
- `../testing/harness.js` — the in-memory plugin harness, OUTSIDE
  `src/` because it ships in the package (`.npmignore` excludes
  `test/`). Sibling plugins import it as
  `mikser-io/testing/harness.js` rather than copying it; the copies
  drifted before it moved here. `test/unit/plugin-harness.js` is a
  re-export for this repo's own tests.

## Canonical sibling plugins

These ship as separate repos but most projects pull them in. They're
not bundled because the engine is renderer-agnostic — each plugin
encodes a particular recipe (SSG, MJML, PDF, email) rather than
substrate.

- **`mikser-io-layouts`** — the canonical SSG-flavor task-production
  policy. Owns multi-match layout assignment (`meta.layout` /
  `meta.layouts` dual key + `autoLayouts` peel ladder), per-layout
  destination Handlebars templates, collision detection, postprocess
  chain parsing (filename `name.html-mjml-email.hbs` → `postprocessors:
  ['mjml','email']` + frontmatter `postprocessor`/`postprocessors`),
  `inspect()` primitive at `runtime.options.layouts.inspect`. The
  engine has no opinion on layouts; this plugin is one way of producing
  render tasks. Other domains (3D rendering, video) would have their
  own task-production plugins.
- **`mikser-io-render-{hbs,liquid,eta,markdown,metatext}`** — renderer
  plugins. `renderHbs` is bundled in core; the rest are siblings.
- **`mikser-io-post-{mjml,pdf,email}`** — postprocessor plugins,
  composable in chains (see `docs/rendering.md#postprocess`).
- **`mikser-io-mcp`** — AI tooling surface (ADR-0006 test #5).
- **`mikser-io-vector`** — vector index over the catalog.
- **`mikser-io-forms`** — HTTP form receivers → entities.
- **`mikser-io-schemas`** — TypeScript type generation from entity meta.

## Plugin map (`src/plugins/`)

- `documents` — file→entity sync for the documents collection
- `files` — file→entity sync for the files collection
- `assets` — asset references and copy
- `resources` — resource references
- `front-matter` — YAML frontmatter extraction (HTML/MD files)
- `yaml` — YAML format support (.yml/.yaml entities)
- `json` — JSON format support
- `api` — HTTP catalog access. Pure transport — exposes nothing on
  `runtime.options.*`. Per-query disk cache.
- `preview` — in-memory render cache + GET /preview/:filename route.
  Exposed at `runtime.options.preview = { store, get, stats, config }`.
- `data` — JSON snapshots of entities/context/catalog to disk
- `observer` / `mapper` / `validator` / `commands` / `shares` —
  utility plugins

## Built-in content providers (`src/plugins/providers/`)

The substrate-side `readEntityContent(entity)` dispatches by URI
scheme. Two schemes are handled inline by built-in providers
(no separate package required, ships with mikser-io):

- **No scheme / plain path / `file://`** — filesystem read. Lives
  inline in `src/utils.js readEntityContent` because the engine
  already touches the filesystem everywhere.
- **`http://` / `https://`** — `src/plugins/providers/http.js`.
  Conditional GET with ETag + Last-Modified, in-memory response
  cache, inflight coalescing on the same URL, binary mirror to
  `runtime/http-cache/<sha-of-url>.<ext>`, operator-supplied
  headers via `entity.meta.httpHeaders`, configurable timeout via
  `entity.meta.httpTimeoutMs`. Test affordance:
  `__resetHttpCacheForTests()` clears the module-level caches
  between unit tests.

Any other scheme (`gdrive://`, `notion://`, `s3://`, …) routes
through the dynamic-import-by-name path — `mikser-io-provider-<scheme>`
must be installed as a sibling package and export a top-level
`read(entity)` function. See ADR-0010 / the gdrive provider for
the convention.

## Multi-emitter collections (sweep ownership)

Collections like `documents` / `files` / `assets` aren't owned by a
single plugin. The file source (via `useSource`) emits into them
from its scanned folder, but other plugins legitimately emit into
the same collection: `mikser-io-csv` fans CSV rows into `documents`,
a gdrive sync would emit there too, an API endpoint can push into
`files`. The catalog has no opinion on emitter identity — only on
collection.

The delete sweep MUST respect that. `sweepDeleted(collection,
scanned, onDelete, ownerPrefix)` requires `ownerPrefix` (typically
`absFolder` for file sources, `layoutsFolder` for layouts) and only
considers entities whose `entity.uri` is rooted under that prefix.
Foreign-emitter entities have a different `uri` shape:
- CSV row entities: empty `uri` (synthetic — meta is the content)
- HTTP-fetched CSV parent: `uri = 'https://…'`
- gdrive-sourced docs: `uri = 'gdrive://…'`

…and the LIKE clause excludes them. Without the scope, every cycle's
file-source sweep silently wipes every co-collection emitter's
entities. Throwing instead of silently sweeping the whole collection
is intentional — this used to be a class-of-bugs landmine. If you're
writing a new source-shaped plugin, the scoping is mandatory.

Test coverage: `test/unit/source-sweep.test.js`.

## Naming conventions

- **Engine state** at `runtime.<name>` — `runtime.refs`, `runtime.catalog`.
- **Plugin surfaces** at `runtime.options.<plugin>` —
  `runtime.options.preview`, `runtime.options.layouts.inspect`.
- **Reachability:** `runtime.options.url` is the engine's resolved
  public URL (from `--url` or `config.url`, trailing slash stripped,
  validated). Plugins that need external reachability — webhook
  receivers, absolute links in emails, MCP preview URLs returned to
  agents, forms share links — read this. Standard gating pattern:
  ```js
  const canPush = runtime.options.url?.startsWith('https://')
  if (canPush) registerWebhookAt(`${runtime.options.url}/api/X/webhook`)
  else         setupPollingFallback()
  ```
  `runtime.options.port` is the internal listener port (kept for
  loopback/dev URL building); `runtime.options.url` is the external
  origin. When in doubt: external = `url`, internal = `port`.
- **Trust proxy default is `'loopback'`** (server.js), not Express's
  `false`. The dominant deployment puts a same-host reverse proxy in
  front, where every socket peer is 127.0.0.1; with no trust, mikser
  reads every proxied request as loopback and the loopback-only gate
  (api/mcp/forms/decap enforce `isLoopback(req.ip)`) inverts the
  moment a facade is added. `'loopback'` honors `X-Forwarded-For` only
  from a loopback peer — safe everywhere (a remote attacker's kernel-
  set peer is never 127.0.0.1, so they can't forge a loopback
  `req.ip`). Override via `config.server.trustProxy` — `'uniquelocal'`
  for a sibling-container proxy, a CIDR for a specific subnet, `false`
  to opt out. The loopback-enforcement and this default are a pair; a
  facade that injects `X-Forwarded-For` (Caddy/nginx do) makes it work.
- **Engine functions** as module-level exports from `mikser-io`:
  `import { queryEntities, subscribe, useRenderer, useCollection,
  readEntityContent, isTextEntity } from 'mikser-io'`.
- **Plugin packages**: `mikser-io-<name>` (mikser-io-mcp, mikser-io-vector,
  mikser-io-schemas, etc.). Each exports a v9 named factory in
  camelCase: `import { vector } from 'mikser-io-vector'`,
  `import { renderHbs } from 'mikser-io'`. Consumer uses
  `plugins: [vector({...})]` — never the bare string.
- **Route paths**: a plugin mounts at `/<name>`, with a `base` or `path`
  option to move it — api `/api`, auth `/auth`, drive `/drive`, forms
  `/forms`, mcp `/mcp`, preview `/preview`, vector `/vector`, decap
  `/admin`. The output folder is served from `/`, so a route CAN shadow a
  page; the accepted answer is a predictable name plus a way to change
  it, not a reserved prefix. Follow the eight, do not invent a ninth
  shape.
- **Tool names**: the registry (`src/tools.js`) holds BARE names —
  `explain`, `verify`, `sources`, `search`. The `mikser_` prefix is MCP's
  namespacing, because its tool names are flat across every connected
  server; `mikser-io-mcp` strips it when mirroring a registration into the
  engine and re-adds it when binding into a session. `invokeTool` accepts
  either form. On the CLI the prefix is stutter: `mikser --tool
  mikser_explain` says mikser twice.
- **MCP tools** (as a client sees them): `mikser_<verb>` or
  `mikser_<subsystem>_<verb>`:
  `mikser_query_entities`, `mikser_read_entity`, `mikser_update_entity`,
  `mikser_delete_entity`, `mikser_render`, `mikser_refs_inbound`,
  `mikser_refs_outbound`, `mikser_refs_broken`, `mikser_refs_rename`,
  `mikser_layouts_inspect`, `mikser_preview_render`,
  `mikser_preview_ui`, `mikser_ui_action`, `mikser_ping`.
  **Never `mikser_api_*`** — that prefix is dead.
- **TASKS constants**: `INLINE` (main-thread async), `SERIAL`
  (p-queue concurrency 1), `WORKER` (Piscina pool). **Not** the old
  `POOL`/`QUEUE`/`WORKER` (which misled readers — `POOL` was actually
  main-thread, not Piscina).

## Code style

- **No historical-narrative comments.** Describe what's there now.
  "Used to live in X, moved in 8.2.0" → git log territory.
- **No separator-line comments** (`// ---- Section -----`).
- **No `_` prefix on engine-managed paths** (`runtimeFolder/foo`,
  not `runtimeFolder/_foo`).
- **Engine-set entity fields under `entity.options`**, not
  `_`-prefixed top-level.
- **No cross-plugin imports.** Plugins compose through lifecycle +
  `runtime.options.*`. Shared pure helpers go in `src/utils.js`.
  Audit: `grep -rEn "from '\./|await import\('\./" src/plugins/*.js`
  should return nothing.
- **Single source of truth fixes.** For cross-plugin bugs, ask
  "what's the canonical copy?" before symptom-site patching.
- **README claims are promises.** Every line in mikser-io's README
  is a commitment — true today or actively being made true. Stale
  claims are bugs.

## ADRs (canonical decisions)

- **0001-0005** — foundational: content-layer-not-the-app,
  files-as-source-of-truth, plugins-independent-engine-stable,
  compose-via-protocols, engine-infrastructure-runs-before-plugin-hooks
- **0006** — five-test framework for adding to core: (1) substrate,
  (2) strengthens strategy, (3) god-plugin check, (4) composability,
  (5) release cadence. Conjunctive. Express passes; MCP failed test
  #5 and ships as mikser-io-mcp.
- **0007** — `$`-prefixed reference declaration + `expand`
  resolution. Implemented in `catalog.js` + `refs.js`. Caps
  configurable under `catalog.expand.{maxDepth,maxPaths,maxResolved}`
  (defaults 5/20/100).
- **0008** — MCP-UI rendering + action delivery. Lives in
  `mikser-io-mcp/documentation/decisions/` (not core — moved with
  MCP).
- **0009** — TWO databases, split by whether the data is DERIVED.
  `runtime/mikser.sqlite` is the CACHE: sqlite + better-sqlite3, synchronous
  (render workers need a sync handle for template helpers), holding
  `mikser_entities` / `mikser_refs` / `mikser_snapshots` / `mikser_journal` /
  `mikser_meta`. Deletable at any moment; a wipe is `unlink`.
  `mikser.data.sqlite` at the WORKING-FOLDER ROOT is the DURABLE store: auth
  grants, the change-set log — behind **knex**, async, main-thread only, so it
  can point at Postgres via `config.database.durable`. Built by
  `registerMigrations(owner, [{ name, up }])`, per owner, recorded in
  `mikser_migrations`; `registerSchema(..., { durable: true })` now THROWS.
  Outside `runtime/` because that folder exists to be deleted, and gitignored
  on creation because it holds credentials. `runtime.start()` closes the knex
  pool for a one-shot run or the process never exits.
  Sift→SQL pushdown + LRU for findById on the cache side.
  Journal-on-sqlite (Phase 7) enables `--resume`; auto-persist (Phase 9) means
  plugins mutate the yielded entity and the journal writes back without an
  explicit `updateEntry` call.
- **0010** — Plugin bundles + factory-call form + inline options.
  Plugins are imported by name and called as factories;
  `plugins: []` carries factory returns, never strings.
  Lifecycle plugins are `(options) => (core) => void`; renderers
  return `{name, options, load?, render?}`; postprocessors return
  `{name, options, output?, setup?, postprocess, teardown?}`. Per-
  plugin config moved entirely off `runtime.config.<plugin>`; it
  arrives as factory args, gets stashed on the descriptor, and is
  passed as `config` to `load`/`render`/`setup`/`postprocess`.
- **0011** (implemented; proven against gpoint) — File and resource
  entities expose deployed URLs. References to served files
  (image/video/PDF) are `$`-keyed **served paths** (`/img/X.jpg`,
  `/media/clip.mp4` — the path content authors, = the entity's
  `meta.url`), resolving via a new `refFilter` `{ 'meta.url': … }`
  clause (utils.js) backed by an indexed `meta_url` column
  (catalog.js + the `INDEXED_COLUMNS` map in sift-to-sql.js; schema
  9.0.1 → 9.0.2). No collection-prefixed ids leak into content.
  Id-refs were tried and rejected — gpoint references content by
  served path everywhere, and its `/media/**` `resources()` library
  means the entity only exists *because* content references
  `/media/…`. The `files` plugin stamps `meta.url`; the `resources`
  plugin stamps its library's served location; the `assets` plugin
  stamps `meta.presets` in `onProcessed` via the pure `presetUrl()`
  helper. Expanding a ref then yields the served entity's URL set,
  not a string to reconstruct; `lookupUrl` (render.js) is the sync
  Handlebars helper resolving a ref to `meta.url` or a named preset.
  Base-relative in the live catalog, absolute in static renders
  (from `runtime.options.url`). Umbrella term is *served entity*
  (file/resource/preset).

## MCP

Lives in `mikser-io-mcp` plugin (separate repo). Activate by calling
`mcp()` **first** in your `mikser.config.js` plugins array:

```js
import { mcp } from 'mikser-io-mcp'

export default {
    plugins: [
        mcp({
            // path: '/mcp',          // default '/mcp'
            // endpoints: { ... },    // per-endpoint token + scope
        }),
        /* ...other plugins */
    ],
}
```

Must be first because its factory creates `runtime.options.mcp`
synchronously when its closure runs, and other plugins gate their
MCP tool registration on `if (runtime.options.mcp)` in their own
`onLoaded`.

There is **no `--mcp` CLI flag**. Activation is plugin-presence only.

## Perf

- Rig: `npm run test:perf` (generates 10k corpus, runs render-only
  pipeline). Configurable: `node test/perf/generate.js 50000`.
  `SIZE=realistic node test/perf/generate.js 10000` switches to fat
  entities (full SEO meta, hero/gallery image objects, $-refs to
  author/category/related, longer body — ~7KB per catalog entry
  instead of ~3KB). Add `task: worker` to a layout's frontmatter to
  dispatch its renders + postprocess through Piscina.
- Current honest numbers (Apple Silicon, 4-thread default, INLINE
  dispatch; see ADR-0009 for the substrate the numbers below run on):
  - 14k realistic cold (--clear):   33s,    RSS 1.4GB peak
  - 14k realistic warm clean:       2.6s,   RSS 156MB peak
  - 14k realistic warm + 1 change:  3.0s,   RSS 156MB peak
  - 110k realistic cold (--clear):  5.5 min
  - 110k realistic warm clean:      25s,    RSS 3.2GB
- vs the Map+NDJSON baseline (origin/main 6922b33) at 14k realistic:
  cold ~4× faster, warm ~2× faster, warm RSS ~9× smaller. 110k is a
  workload Map+NDJSON couldn't reach — process OOMed before ADR-0009.
- Catalog scan cost was the 2024-era objection to sqlite. The
  resolution lives in `src/database/sift-to-sql.js`: indexed sift
  clauses ($eq/$in/$lt/$exists/etc. on collection / type / format /
  name / meta_href / meta_layout / meta_lang / meta_cache / time /
  uri) push down to SQL, so layouts.onLoaded and source.sweep don't
  materialize the table per cycle. `findById` is a 10k-entry LRU in
  front of PK lookup. Without those two, sqlite is strictly slower
  than the old Map (we measured it — see ADR-0009).
- Piscina is lazy (`minThreads: 0` + `idleTimeout: 30_000`). INLINE
  dispatch is the default for both render and postprocess; layouts
  that opt into TASKS.WORKER (`task: worker` in frontmatter) get a
  thread per first task. At 14k the lazy init dropped peak RSS
  ~130MB on workloads that never use WORKER (which is most).
- **Profile before optimizing.** `node --cpu-prof app.js
  --working-folder test/perf --clear` produces `.cpuprofile` for
  Chrome DevTools. Intuition has a real miss rate (multiple perf
  hypotheses across this rewrite turned out wrong; the profile
  caught them every time).
- What actually helps when RSS is too high: trim entity weight
  (don't store source `content` in the catalog if the renderer
  re-reads it; don't keep computed fields you can recompute),
  filter your `data.entities` exports so the catalog isn't
  carrying the rendered shape, or drop `--threads` to 1-2 if the
  build is memory-bound and cold time is acceptable.

## When extending

- **New engine capability?** Run through ADR-0006's five tests. Bar
  is high. Express is the only earned addition.
- **New plugin?** Own repo, named `mikser-io-<name>`. Exports a
  named v9 factory (e.g. `export function vector(options = {}) {
  return (core) => { ... } }`). Composes against
  `runtime.options.app` / `runtime.options.mcp` / lifecycle hooks.
  Never imports another plugin's source — and the engine never
  reads `runtime.config.<plugin>` for plugin options; everything
  flows through the factory arg (ADR-0010).
- **New MCP tool?** Add to `mikser-io-mcp/index.js` via
  `mcp.simpleTool(name, description, zodSchema, handler)`. Tool name
  follows `mikser_*` convention.
- **New lifecycle hook?** Almost certainly no. Existing hooks cover
  all known patterns. If you think you need one, post the use case
  to ADR-0006 review.
- **New content source (gdrive, notion, s3, github, …)?** Two
  things ship together:
  - A regular lifecycle plugin (the sync — emits entities into the
    catalog, sets `entity.uri = '<scheme>://...'` so the dispatch
    knows where to route reads).
  - A named export `read(entity)` from the same package, which
    must be named `mikser-io-provider-<scheme>` so the engine can
    find it. `readEntityContent(entity)` parses the scheme out of
    `entity.uri`, dynamic-imports the package, calls its `read`.
    No registry, no descriptor — same package-name convention as
    `mikser-io-render-*` and `mikser-io-post-*`.
  Built-in: plain local paths (no scheme) and `file://` URIs are
  read via `fs.readFile` directly — no provider package needed for
  the canonical local-filesystem case. `entity.content` already
  populated is a fast-path that skips the dispatch entirely (for
  small remote docs eager-fetched at sync time).

## Test suites

- `npm run test:unit` — 540 unit tests across plugins + utilities
- `npm run test:scenarios` — 96 assertions over 20 subprocess-spawned
  end-to-end runs (manifest skip, refs replay, watch-mode
  change/delete, lookup + asset invalidation, unchanged output,
  `--force`, `--explain`, `--json`). Spawns mikser fresh per scenario
  so module-level catalog/refs/manifest state can't leak between
  tests. Scenarios use `freshWorkdir()` in os.tmpdir — never
  `test/fixture`, which is tracked and must stay byte-identical
  (`git status --short test/fixture` after any run that builds).
- `npm run test:smoke` — full lifecycle build of `test/fixture/`
  (with vector + decap + post-mjml + post-pdf if env supports).
  Exercises both INLINE postprocess (PDF) and WORKER postprocess
  (MJML via `task: worker` on `welcome.yml`).
- `npm run test:perf` — render-pipeline perf rig (corpus generation
  + clean-build timing). `SIZE=realistic` + entity count knobs
  documented in **Perf**.

## Dev workspace

The siblings live side-by-side in one parent folder and share an npm
workspace declared at that parent's `package.json`:

```json
{
  "private": true,
  "workspaces": ["mikser-io", "mikser-io-*"]
}
```

`npm install` at that root hoists everything: each sibling's
`node_modules/mikser-io` (and any other cross-workspace dep)
becomes a symlink to the working copy. The whole tree runs
against ONE module instance of mikser-io.

**This isn't optional ergonomics — it's correctness.** Plugins
use `AsyncLocalStorage` (currently `queryContext` for sidecar
findEntities tracking; the schema-version meta could grow more).
Without workspace deduplication, npm 7+ auto-installs the peer
dep into each sibling's own `node_modules`. Layouts'
`import { queryContext } from 'mikser-io'` then resolves to its
bundled copy — a different AsyncLocalStorage instance than the
engine uses. Sidecar queries don't get tracked → no `query`
edges in `mikser_snapshots.refClosure` →
`manifest.queryAffected` returns empty → aggregate layouts
(index pages, sitemaps, RSS feeds) never invalidate when new
matching entities land. Silent broken-incremental.

`test/scenarios/_harness.js` also auto-coalesces (replaces any
real `mikser-io-layouts/node_modules/mikser-io` directory with a
symlink to MIKSER_ROOT on every `setupFixture`) as a backstop —
the scenarios pass with or without the workspace, but the
workspace is the canonical setup. Same shape applies to any
future sibling that uses `queryContext` or other module-level
state from mikser-io.

For production consumers (someone `npm install mikser-io
mikser-io-layouts` in their own project), npm resolves both from
the consumer's own project tree — no duplication, no bug.

## Reference

- `docs/diagnostics.md` — "why did it do that?" — `--explain`,
  `--json`, `--verify`, the sqlite tables, and every introspection
  surface, indexed by the question it answers. Start here when
  debugging rather than reading engine source.
- `docs/architecture.md` — module map (audit before relying
  on specifics; may have drift)
- `docs/decisions/` — ADRs
- `docs/configuration.md` — config reference
- `docs/api-reference.md` — public API
- `test/perf/` — render-pipeline perf rig
- Sibling repos: `mikser-io-layouts` (canonical SSG-flavor render-task
  production policy), `mikser-io-mcp`, `mikser-io-vector`,
  `mikser-io-schemas`, `mikser-io-forms`, `mikser-io-post-{mjml,pdf,email}`,
  `mikser-io-render-{eta,liquid,markdown,metatext}`,
  `mikser-io-sdk-{api,react,svelte,vue,vector}`, `mikser-io-example-blog`
