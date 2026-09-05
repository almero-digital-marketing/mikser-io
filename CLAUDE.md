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
- **The cache stamp is a SHAPE fingerprint, not a release number.**
  `mikser_meta.schema_version` holds `<derived-shape>:<hash of the
  registered schema SQL>`. It was `packageInfo.version`, so every release
  wiped every deployment's cache — a patch that touched a README discarded
  the corpus and rebuilt from cold, and the riskiest path in the system ran
  on every upgrade for no reason. Two things invalidate a cache and both are
  in the fingerprint: the SQL (hashed from the scripts that are actually
  applied, so it cannot drift from the tables) and `DERIVED_SHAPE`, a number
  in `database/index.js` you **bump when a release changes the meaning of
  anything already stored** — how inputHash is computed, the edge kinds in a
  refClosure, what a destination is relative to. No parser can see those. A
  needless wipe costs one cold rebuild; a missed one costs a site serving
  wrong output with every signal green, so when in doubt bump. The release
  that wrote a cache is recorded separately as `built_by_version` and
  compared against nothing.
- **The cache stamp means a cycle FINISHED.** `mikser_meta.schema_version`
  (and `config_checksum`) are written by `db.commitStamp()` from
  `onFinalized`, never at `db.open()`. Written at open they recorded only
  that the cache was opened, and an upgrade whose rebuild was then
  interrupted left a current stamp over a half-built cache — catalog
  matching disk, no snapshots, `out/` holding the previous build — after
  which every build correctly reported "N unchanged" and rendered nothing.
  A deployment served the previous day's pages that way, green on every
  signal. Deferred, the same sequence self-heals. Its absence beside a
  populated catalog is an invalidation override
  (`REASON.REBUILD_INTERRUPTED`); an absent stamp with an EMPTY catalog is
  an ordinary first run and emptiness already opens every gate. A unit test
  that wants a stamped cache has to call `commitStamp()` — that is what a
  finished cycle does.
- `invalidation.js` — **"should this work be redone?"**, and the only
  module allowed to answer the half of it that is not layer-specific.
  Four layers ask (source.js's checksum gate, `recordedHashes` for the
  layouts dispatcher, `skipDecision` at the render gate, the assets
  `.md5` marker) and each owns its own EVIDENCE. None owns what
  OVERRIDES that evidence: `bypassReason()` is the single declaration
  of `--force`, a wiped cache, a reload event and an output that is
  gone, so a fifth override added there reaches every gate. Also holds
  `resolveOutputPath` / `outputMissing` / `missingOutputIds`
  (memoized per cycle, dropped in manifest's onFinalize), the `REASON`
  vocabulary that `--json` carries out to callers, and `isFullCycle`.
  A leaf module — runtime and node builtins only, reading
  `runtime.manifest` lazily so the manifest can import it.
  This exists because the override rules were written four times and
  drifted: an output-existence check added to one gate was missed by
  the other three, and a build over a deleted output folder rendered
  nothing and exited 0. Layers may own what they know, never what
  overrides them.
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
- **Progress is TRACKED always, DRAWN only where a bar belongs, and the
  RUNNING commentary is throttled to one line per `PROGRESS_INTERVAL_MS`
  (30s).** Three decisions that were once one. Drawing is gated on
  `carriesDocument` at the single place a bar starts — the gauge writes to
  stdout, which under `--json` / `--tool` carries the DOCUMENT, and
  forwarded it landed inside the JSON (`^[[?25lDocuments import: >416/800`
  at byte 0). Tracking must survive that gate, because `stopProgress` is
  where phase timings come from and tying the two together left every
  piped build reporting none. The commentary is on a TIME interval and not
  on quartiles: a quartile is a fraction of the WORK, so it says nothing
  about how often a line appears — four records in three seconds on a fast
  phase, four over an hour on a slow one. Quartiles took a piped no-op
  build from 32 lines to 97, because eleven of thirteen phases carry five
  items. `updateProgress(detail)` takes whatever the call site already
  holds — a path, an id — so a running record says WHAT is progressing;
  stored per item, formatted at emit, so naming the work costs a 14k
  import nothing. An entity id LOOKS absolute and is not a path, so
  `progressDetail` shortens only what is genuinely inside the working
  folder.
- **`progress-finished` is never gated, and the PHASE is its subject.**
  Every phase says that it ran and what it cost, at any duration — with
  the commentary throttled it is the only record most phases produce, and
  off a TTY it is the only place phase timings come from. It has to stand
  alone, which `Documents import finished: 5 0s` did not: a count with no
  subject and a duration rounded away to nothing. **Phases are timed with
  `performance.now()`, not `Date.now()`** — moving from seconds to
  milliseconds moved the same defect one order of magnitude down, where
  nine of thirteen phases printed `0ms`, and Date.now() cannot resolve
  below a millisecond at all. `formatDuration` prints each band at the
  resolution it has (`0.12ms`, `340ms`, `3.2s`) with a `<0.01ms` floor,
  because a monotonic clock can still return two identical readings and
  `0.00ms` would be the same lie a third time. The subject is the
  phase NAME, deliberately not the last item walked — that item is not
  what the phase was about: seven journal phases in a row reported the
  same `/layouts/page.hbs` because that is where the walk ended, and
  `Files import finished: 3, last .../social-fb.svg` put a filename into
  the log that nothing had anything to say about, breaking a scenario
  asserting that file is never mentioned. Running records keep the item,
  because there it shows MOVEMENT.
- **The version banner is an info record and obeys the level.** Written in
  `setup()`, before commander has applied `--log`, so it reads the level
  off argv the same way `quietStdout` does. Without that, `--log silent`
  printed the version line and nothing else — and only the FORWARDED path
  was ever silent, which is the path the tests exercise, so nothing could
  see it.
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
- **A preset `.md5` marker means a render FINISHED, and its absence is read.**
  Presets are the one place user code is handed a final output path and left
  to fill it, and a half-written derivative there is not self-correcting:
  the marker is keyed on the SOURCE checksum, which an interruption does not
  change, and the file is present, so `outputMissing` does not fire either.
  Both gates say "nothing to do" over truncated bytes for as long as nobody
  looks. Three parts, and all three are needed. (1) `forgetPresetMarkers`
  removes the marker BEFORE the render; `onComplete` writes it after — so it
  cannot outlive the render it describes. (2) `render.js`'s preset renderer
  removes the destination when a failed render is what changed it, measured
  by size+mtime before and after: a preset that throws before writing keeps
  its good derivative, because deleting that would take a working asset off
  the site until the next build. (3) A derivative with no marker schedules
  its source and forces it past the reuse check (`preset-unfinished`) —
  without this the removal in (1) is inert, since nothing consults a marker
  for an entity the journal never mentioned, which is exactly the state a
  SIGKILL or the OOM killer leaves. **That scan asks the MANIFEST which
  outputs exist, never the folder what is in it.** Only the destination the
  engine hands a preset gets a marker, so a preset that legitimately writes
  more than one file — a poster frame beside a video — made a folder walk
  report a permanent failure that never happened: `preset-unfinished` on
  every build for ever, announcing a re-derive that could not occur because
  no entity's destination matched the extra file. A warning that fires on
  every healthy build is worse than the silence it replaced. A file nothing
  claims is an ORPHAN, a different fault with its own report. Snapshots also
  make the recovery possible at all: one carries the entity id, so there is
  nothing to reverse-map and no catalog to walk. Three states the scan must
  tell apart, each of which survived a mutation until it was written down:
  a rendered PAGE (no marker, not under a preset root), a derivative that is
  GONE (the engine's missing-output path owns it), and a derivative whose
  SOURCE is gone (nothing to schedule, so nothing may claim a recovery — the
  warning is raised from what was scheduled, never from what looked suspect). Not fixable from here: a preset that wraps a tool and
  does not check its exit code RESOLVES, so the manifest snapshots the
  truncated bytes and `--audit-output` reads green. A preset that reports
  success is believed.
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
- `siteRelativeUrl` / `siteRootFor` (utils.js) — every url helper (`asset`,
  `href`, `resource`) builds an output-root absolute destination and
  relativises it from the page. With one site per build the output folder IS
  the deployed root and that is right; with several it is not, and each url
  carries an extra `..` for the site segment that a browser FLOORS rather
  than failing on — so it works, at every depth, and nothing says the base is
  wrong. `runtime.config.siteRoots` declares the deployable subtrees and is
  copied onto `runtime.options` in the engine's onLoad, because the helpers
  run in render workers which never see `runtime.config`. Three cases and the
  third is the reason it is not a one-liner: a target OUTSIDE every root is a
  shared asset and is addressed inside the page's own root (the case that was
  wrong); a target in the SAME root is already correct; a target in a
  DIFFERENT root is a cross-site link that no relative path can reach on a
  per-domain deploy, so it is left alone and the reference check reports it
  rather than this inventing a path. Nothing declared → `''` → byte-identical
  output, which is the compatibility guarantee.
- **`--audit-output` walks every tree that holds outputs, not just
  `outputFolder`.** Preset derivatives live at the working-folder root and
  reach the site through a symlink the walk does not follow, so the one check
  whose job is "what is on disk that mikser did not record" reported
  `0 orphaned` over any amount of debris in the one tree where debris
  accumulates. Plugins DECLARE their trees on `runtime.options.auditRoots`
  as `{ path, ignore }`, so nothing in core knows what a preset is or that a
  `.md5` beside a derivative is bookkeeping — without that ignore every
  derivative on a site reports exactly one orphan. `claimed` is keyed on
  ABSOLUTE paths; keyed relative to `outputFolder` it silently claimed
  nothing for any destination outside it. Roots nested inside an
  already-walked one are skipped, or `--assets out/derived` lists every file
  twice. **The dispatch is at `import`, not the engine's `onLoaded`** — same
  reason `--tool`/`--tools` moved there: the engine's own onLoaded is
  registered during setup(), ahead of every plugin's, so an audit dispatched
  from it asked which trees hold outputs before a single plugin had answered,
  and the declaration was correct but arrived too late to be read. A preset
  that writes MORE than one file leaves the extras genuinely unclaimed and
  genuinely reported; `assets({ auditIgnore: [...] })` is how a project says
  they are expected, because otherwise a legitimate preset shape is a
  permanent non-zero exit.
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
  the instance's log output and exit code. There is NO opt-out: a flag for
  starting a second engine on a held folder only ever enabled the accident
  this file prevents — two engines on one catalogue and one output tree
  with no lock — and every case it was reached for is served by stopping
  the instance. Socket lives in `os.tmpdir()` keyed by a hash of the resolved
  working folder — NOT under `runtime/`, because sun_path caps a socket
  path at ~107 bytes and a nested working folder fails as `listen
  EINVAL`. chmod 0600, so the filesystem permission is the access
  decision. A forwarded build RESCANS (`runtime.rebuild()`), never
  drains: a client can beat the inotify event for the file it just
  wrote. Report-only commands (`--tool`, `--tools`, `--audit-output`,
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
  `captureOutput` frames the instance's writes to the client AND echoes
  them locally, so an operator watching the instance sees that a forwarded
  request happened — right for log lines, wrong for a DOCUMENT. A `--json`
  request wrote its whole report into the instance's own console as well,
  which under pm2 is a few hundred lines in the out log for every report an
  agent asks for. `echoStdout: false` suppresses just the local write, and
  the seam is exact rather than a guess: under `--json` / `--tool` the
  logger writes to stderr and stdout carries only the document.
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
  (`mikser_explain`, `mikser_audit_output`, `mikser_build_report`). Registered
  by the engine, not by mcp, so `--tool mikser_audit_output` works on a bare
  engine exactly as `--audit-output` does. Schemas use a neutral
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
- **`verify` in `src/auth.js` is a different word.** It is the credential
  check — the cross-package contract `{ verify(req) }` that `mikser-io-auth`
  and any custom verifier implement, and the same term jwt/passport/WebAuthn
  use. It has nothing to do with checking output, which is `--audit-output`
  and was called `--verify` until 9.78.0. A blanket rename across the repo
  breaks authentication in two packages; the rename that happened had to skip
  twelve references here deliberately.
- **Tool names**: the registry (`src/tools.js`) holds BARE names —
  `explain`, `audit_output`, `sources`, `search`. The `mikser_` prefix is MCP's
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
  `--json`, `--audit-output`, the sqlite tables, and every introspection
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
