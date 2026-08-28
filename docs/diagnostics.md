# Diagnostics

The other documents here are organised by subsystem — the lifecycle, the
catalog, the render pipeline. That is the shape for learning how mikser
works. This one is organised by the question you arrive with, which is
almost always a form of *"why did it do that?"*

Every surface below already exists. If answering a question means reading
engine source, the entry point is missing and belongs on this page.

## Start here

| Your question | Reach for |
| --- | --- |
| Why didn't this page rebuild? | [`--explain`](#--explain-entity) |
| What did this build actually change? | [`--json`](#--json) |
| Does the output folder match what mikser thinks it wrote? | [`--verify`](#--verify) |
| What happened during the last cycle, in order? | [`mikser_journal`](#mikser_journal) |
| What depends on this entity? | [`runtime.refs`](#runtimerefs) |
| Which layout claimed this document, and why that one? | [`layouts.inspect()`](#layoutsinspect) |
| Why does this page's output look stale? | [`runtime.manifest`](#runtimemanifest) |
| Two files seem to fight over one output | [`--explain`](#--explain-entity), [`--verify`](#--verify) |
| Which source file produced this built output? | [`runtime.manifest`](#runtimemanifest), `mikser_which` |
| Where was this VALUE written — file, field, line? | [`runtime.provenance`](#runtimeprovenance) |
| What would break if I changed this file? | [`runtime.manifest`](#runtimemanifest) `affectedBy` |
| I am an agent reading CLI output, not speaking MCP | [`--tools` / `--tool`](#the-two-agent-workflows) |
| Did my schema validate anything at all? | [`schemas.names()`](#schemasnames--schemaslookup) |

## Command line

### `--explain <entity>`

The single most direct answer to "why didn't this rebuild". Reports
instead of building. Accepts an id, a `meta.href`, or an id without its
extension — the same three forms a `$`-ref accepts, so you can paste
whatever you have.

```bash
npx mikser --explain /documents/en/posts/hello.md
```

It prints the entity's layout and **why that layout matched**, its
destination, its `inputHash` and the components that went into it,
whether the file on disk still agrees with the catalog, every recorded
render with its `refClosure`, and a verdict in plain words.

When an entity's inputs have moved since a render, the verdict names what
moved rather than only that something did:

```
would re-render — meta.title changed since it was last rendered
```

and the render line carries the same detail per snapshot:

```
rendered    2026-08-22 21:07:52   → /page-a.html   [STALE: input hash moved since]
  moved      content, meta.weight (added)
```

A snapshot written before per-input recording says so rather than
guessing.

When another entity renders to the same destination, that leads the
verdict and the hash reasoning follows it:

```
CONTESTED — /bg/index.html is also claimed by /documents/bg/index.md.
Whichever renders last wins and the other output is discarded; the
input-hash reasoning below describes this entity only.
```

The full list is under `competingDestinations` in `--json` form. The
hash reasoning on its own is true and useless here: "would be SKIPPED,
input hash unchanged" is correct about the entity you asked about and
silent about its output being overwritten by someone else's.

A destination whose **last render attempt threw** reads as such, rather
than as current:

```
rendered    2026-08-22 21:52:24   → /page-a.html   [STALE: last render attempt failed]
  failed     2026-08-22 21:52:25  The partial partials/btn could not be found
             3 attempts since 2026-08-22 21:52:24
  partial    /layouts/partials/btn.hbs  b6ab7ccc  [TARGET DELETED SINCE]
would re-render — the last render attempt failed and nothing has changed since
```

`[TARGET DELETED SINCE]` is the same distinction one level down: an edge's
binding is what it resolved to *when recorded*, so a target deleted
afterwards still shows an id and a hash and reads as healthy unless the
catalog is asked. Note that `--explain` compares the CATALOG's entity against the
snapshot: if you have edited a file and not yet built, the verdict is
`source differs from the catalog` — the edit has not been imported yet, so
there is nothing to attribute. Build, then ask.

Each `refClosure` edge shows what was asked for and what answers to it,
and flags the ones nothing answers to:

```
refClosure  6 edges
  ref        /hero.txt → /files/hero.txt  24dc5b87
  ref        /does-not-exist  [UNRESOLVED — nothing answers to this name]
  layout     /layouts/page.hbs  f274678c
  lookup     /contacts  [UNRESOLVED — nothing answers to this name]
  query      {"meta.href":"/system/navigation"}  → /documents/navigation.yml
  query      {"meta.href":"/cosmetics/celestetic"}  [MATCHES NOTHING]
```

A dangling edge is usually the answer on its own, and `query` edges are
where most of it hides on a site whose references go through a sidecar's
`findEntity` — there, `ref` and `lookup` may be zero and `query`
everything.

Query counts are computed when you ask, not when the edge was recorded.
That is deliberate: an edge stores the filter WITHOUT its results, so an
entity appearing tomorrow still invalidates the page that links to it
today. An edge that recorded its bindings would record nothing for a query
matching nothing, and creating the target later would re-render nothing.

In `--json`, every query edge carries `matched` explicitly — an integer,
or `null` for a predicate that could not be serialized (`findEntities()`
with no argument, or a function filter), which invalidates on any mutation
by design. `matched: 1` also carries `sample` with the id. The field is
always present, so a consumer never has to read absence as meaning
anything.

Add `--json` for the whole report as a machine-readable object. Exits `3`
when the entity cannot be found.

### `--json`

A build report on stdout, as JSON. Logs and the banner move to stderr
under this flag, so stdout parses whole.

```bash
npx mikser --json | jq '.summary'
```

Five buckets, and the distinction between them is the point:

| Bucket | Meaning |
| --- | --- |
| `rendered` | the render ran and the output moved, with a `reason` per entity |
| `skipped` | the manifest decided not to render, with a `reason` |
| `unchanged` | the render ran and produced bytes identical to what was already on disk |
| `errors` | the render ran and **threw** — with `id`, `destination`, `error`, `layout` |
| `gated` | a count — the source was unchanged, so no render was ever scheduled |

Each report also carries `cycleId`, `startedAt` and `finishedAt`. Under
`--watch` two consecutive reports are otherwise indistinguishable, so
"is this my edit's cycle or the one before it" has no answer without the
id. A cold build is cycle 1.

A failed render appears in `errors` and **not** in `rendered`: that bucket
means the output moved, and a throw writes nothing. The previous good bytes
stay on disk, which is what makes a failed render survivable — and also
what makes it invisible without this bucket.

A failed render is **retried on every subsequent build** until it
succeeds, reported as `reason: "retry-failed"`. Nothing else would schedule
it — the entity's own source has not changed, so it is gated at import, and
the manifest still describes the last good render — so without the retry a
build after a failing one reported success with the site still stale.

Retries are unbounded and deliberately noisy: a page that fails every cycle
is failing every cycle. `errors[].since` and `errors[].attempts` are what
make that readable — "broke just now" and "broken for an hour" are
different situations. The marker clears itself on the first success.

**A one-shot build with render errors exits `1`.** That is the signal a CI
gate needs, because `mikser && mikser --verify` would otherwise pass a
build in which nothing rendered: `--verify` compares the output against the
manifest, both of which still describe the last good render. Watch mode
keeps running — a failed render there is a state to fix on the next cycle,
not a reason to tear down the watcher.

`reason` is a stable vocabulary you can assert on: `unchanged`,
`never-rendered`, `inputs-changed`, `ref-changed`, `query-matched`,
`cache-disabled`, `postprocessor`, `force`, `no-manifest`.

Each reason carries the detail behind it, so the answer does not require a
database query. The key is per-reason — `changed`, `matched`,
`dependency` — because each means something specific:

| reason | detail | says |
| --- | --- | --- |
| `inputs-changed` | `changed: ["meta.title"]` | which of the entity's own inputs moved |
| `query-matched` | `matched: { filter, by }` | which query fired, and which mutated entity tripped it |
| `ref-changed` | `dependency: { kind, target, key, cause }` | which dependency, and whether it `changed`, was `deleted`, or was `unhashed` (nothing resolved when the edge was recorded) |

`query-matched` is the one worth reading. It fires on pages you were not
thinking about — a listing whose filter happens to cover the document you
just edited — and on a page with a dozen query edges, *which* one fired is
the whole question:

```json
{ "destination": "/index.html", "reason": "query-matched",
  "matched": { "filter": { "id": { "$regex": "^/documents/devices/" } },
               "by": "/documents/devices/hera.md" } }
```

A `matched.filter` of `null` is a different statement: the page's predicate
could not be serialized (`findEntities()` with no argument, or a function
filter), so it re-renders on **any** mutation. That is not a query that
matched — it is a page with no filter, and narrowing it is the fix the
catalog already warns about at record time.

`inputs-changed` carries a `changed` array naming **which** input moved:

```json
{ "id": "/files/hero.jpg",     "reason": "inputs-changed", "changed": ["checksum"] }
{ "id": "/documents/page.md",  "reason": "inputs-changed", "changed": ["meta.title"] }
{ "id": "/documents/page.md",  "reason": "inputs-changed", "changed": ["content"] }
{ "id": "/layouts/post.hbs",   "reason": "inputs-changed", "changed": ["inputs.shared"] }
```

`checksum` means the bytes on disk moved; `content` means the body did;
`meta.<field>` names the front-matter field; `inputs.<key>` is a declared
input such as a layout's sidecar digest. A field that appeared or vanished
reads as `meta.weight (added)` / `(removed)`, which is the answer when a
document gains or loses front-matter.

The array is absent on a first render — there is no prior snapshot to
compare against. It never appears alongside `matched` or `dependency`
either: a consumer switches on `reason` and reads one field, so a stray
key from another branch would make that switch wrong.

The same detail appears at `--debug` for a watch run, one line per render.
It is deliberately not in the build's normal output — the counts are the
summary and `--json` is the record — but when you are watching one page
misbehave, the trigger is the point.

`unchanged` is the interesting one. It means invalidation was coarser
than it needed to be — the render was scheduled, ran, and produced
nothing new. A high count is not a bug, but it tells you where the
dependency graph is conservative.

Warnings carry a stable `code` alongside their prose, so a test can
assert "this build produced no preset-no-match" without grepping a
sentence someone may later reword.

### `--verify`

Walks the output folder against the recorded snapshots and reports drift
instead of building. Four categories, and the split matters:

| Category | Meaning | Severity |
| --- | --- | --- |
| `Missing` | a snapshot records a destination that is not on disk | error |
| `Mismatched` | the file's bytes differ from the recorded `outputHash` | error |
| `No hash` | a snapshot with no recorded hash — nothing to compare | warning |
| `Orphan` | a file on disk that no snapshot claims | warning |
| `Collision` | two or more entities record snapshots for the same destination | warning |

`Collision` is the one that does not show up as drift. Every render
hashes the file *after* writing it, so when two entities write the same
path the loser records the winner's bytes and both snapshots agree with
disk — missing, mismatched and orphaned are all empty and the output is
still wrong. It is reported by shape rather than by comparison, which is
why it is here and not in the three categories above.

Exit codes make it usable as a CI gate directly: `2` if anything is
missing or mismatched, `1` if only warnings, `0` when clean, and `2` when
there is no manifest to check against.

```bash
npx mikser --verify || echo "output folder has drifted"
```

A destination is resolved against the output folder first and, when that
finds nothing, treated as a filesystem path — assets carry an absolute
destination built from `assetsFolder`, which may sit outside the output
folder entirely.

`Orphan` still needs reading with that in mind: only files under the
output folder are walked, and a file is an orphan when no snapshot claims
it. That is normal for anything written without a render snapshot (the
`files` and `data` plugins), and a real signal for a page whose layout
stopped producing it.

### The rest, briefly

| Flag | Use |
| --- | --- |
| `-f, --force` | ignore all three gates (import checksum, dispatch, manifest) and re-render everything |
| `-R, --resume` | continue from a previous interrupted run's journal; skips the filesystem scan |
| `-r, --clear` | clear state before running |
| `-d, --debug` / `-t, --trace` | raise log level; `trace` includes per-entity catalog writes |
| `--tools` | list the registered tools, then exit; `--json` for full schemas |
| `--tool <name>` | run one tool and print its result, then exit. `--tool-args '<json>'` supplies arguments |

`--force` composes with the unchanged-output check: it redoes the work
without touching files whose bytes did not move, so it is cheap to reach
for and its `unchanged` count tells you how much of the catalog was stale
by suspicion rather than in fact.

## The two agent workflows

There are two ways an agent drives mikser and they are equally real: one
speaks MCP over HTTP, the other runs the CLI and reads its output. Both
read the same tool registry, so neither sees a smaller engine than the
other.

```bash
npx mikser --tools
```

```bash
npx mikser --tool which --tool-args '{"destination":"/bg/index.html","text":"Контакти"}'
```

Tool names are **bare** here — `explain`, `verify`, `sources`, `which`. The
`mikser_` prefix belongs to MCP, where tool names share one flat namespace
across every server a client has connected to and an unprefixed `verify`
would collide with anyone else's. The engine has no such problem, and
`mikser --tool mikser_explain` says mikser twice. The prefix is added at
the session boundary, so an MCP client sees exactly the names it always
did. Either form is accepted on the CLI, because an agent reading MCP
documentation should not have to know which surface stripped what.

A report-and-exit run — `--explain`, `--verify`, `--tools`, `--tool` —
never wipes the cache, even when the config or the schema version has
moved. Wiping for one destroys the state it was asked to describe and
then answers from the empty result as though that were the answer;
measured, one `--tool mikser_query_entities` after an edit to
`mikser.config.js` dropped 521 entities and replied `total: 0`. The
staleness is still reported, loudly. A build still wipes, because a build
is what repopulates.

An empty catalog is said out loud too, before the answer: every tool
replies `null` / `total: 0` / "no render claims this destination" when
nothing has been built, and all of those read as "the thing you asked
about does not exist".

`--tools` lists what is registered, with `--json` for the full schemas.
`--tool` runs one and prints its result; stdout carries only that result
— the banner and every log line move to stderr, as under `--json` — so
piping into `jq` works. Exit status is `0` on success, `1` when the tool
itself reported an error, and `3` when the tool does not exist or its
arguments are not valid JSON, because an agent reading CLI output has
only the status to branch on.

The registry lives in the engine (`registerTool` / `toolNames` /
`invokeTool`), and the transports are consumers of it. That is what makes
the parity hold rather than decay: a tool registered through
`runtime.options.mcp` — by mcp, layouts, vector, or one written next week
— is reachable from both surfaces the moment it exists, with no per-tool
CLI code and no second list to keep in step. The mcp plugin still owns
the tools themselves, the transport, sessions, resources and prompts; the
engine knows only a name, a description, an input schema and a function.

The mirroring runs both ways. mcp's registrations flow into the engine's
registry, so everything it registers is reachable from `--tool`; and a
session binds the engine's own registrations too, converting their schema
to zod at bind time. The engine declares an input as
`{ name: { type, required?, description? } }` rather than as zod, because
the registry is transport agnostic and should not depend on one
transport's schema library. The vocabulary covers string / number /
boolean / array and stops there — anything richer would be a schema
language, which the engine has no business owning. A tool needing real
validation registers through `runtime.options.mcp` with zod, which is
what every tool in that plugin does.

**`explain`, `verify`, `sources` and `build_report` are the engine's own**,
registered in `src/builtin-tools.js` rather than by a plugin. `sources`
is the reverse lookup — what produced this destination, each source
tagged with how it got there — reading the `refClosure` through
`manifest.sourcesOf`. Locating a string *inside* those sources stays in
`mikser-io-mcp`'s `which`, which reports each occurrence's line and
whether the string begins it: a declaration usually does and a use
usually does not, which separates the two in any text format without a
per-language grammar. That is what makes `--tool mikser_verify` work on a bare engine,
the same as `--verify` — before, the engine's diagnostics needed an agent
surface configured to be reachable as tools, which is backwards.

`--explain` and `--verify` stay as flags rather than becoming `--tool`
invocations. They are not a second implementation: the flag and the tool
both call `explain()` and `manifest.verify()`. Routing the flag through
the tool would add a JSON serialize-and-reparse for nothing. What the
flags carry that the tool cannot is presentation and exit status —
`formatExplain`'s aligned columns are for a person, and `--verify` exits
`0` / `1` / `2` for OK / WARN / FAIL, a CI gate contract that `--tool`'s
`0` / `1` cannot express without lying about one of the three.

## Over a transport

Everything above assumes a shell on the machine. Three of these questions
are also answerable from a running server, which is what CI, a dashboard,
an SDK, or an agent speaking MCP actually has.

**MCP** — `mikser_explain`, `mikser_build_report`, `mikser_verify`,
alongside the existing `mikser_refs_*`, `mikser_layouts_inspect` and the
`mikser://logs/recent` resource. Four more answer the questions a shell
would otherwise be needed for: `mikser_search` finds a string across
entity meta, source files and — with `in: ["output"]` — the built files,
reporting occurrences per destination; `mikser_read_output` reads the
bytes currently on disk for a destination, which is a different question
from what the catalog or the manifest says should be there;
`mikser_which` goes the other way, from a built destination back to the
source that produced it — reading recorded provenance where it exists and
labelling each answer `meta-field` / `source-content` (recorded) or `scan`
(not), because a recorded answer and a guessed one warrant different trust;
and
`mikser_update_entity({ dryRun: true })` reports the blast radius of an
edit before making it.

**REST** — on the `api` plugin, gated on their own `diagnostics`
operation:

```
GET <endpoint>/explain?reference=/documents/en/page.md
GET <endpoint>/report
GET <endpoint>/verify
```

```js
api({ endpoints: {
    ops: { token: process.env.OPS_TOKEN, operations: ['diagnostics'] },
} })
```

`diagnostics` is in **no** default operation set, and that is deliberate
rather than tidy: these responses carry absolute filesystem paths, layout
ids and raw error text. Folding them into `list` would leak engine
internals through every endpoint that only meant to publish content, and
adding them to the token default would do it silently on upgrade.

`/verify` answers `200` whether the verdict is `OK`, `WARN` or `FAIL` —
the check ran, and that is its answer. A status code would conflate "drift
found" with "request failed", so a CI gate reads `verdict`, which mirrors
the CLI's exit vocabulary.

The build report is recorded only when something can read it: `--json`, or
a transport that asked for it. It describes the LAST cycle — a watch
server clears it as each new cycle starts, so "what did that rebuild do"
does not become "everything since boot".

There is no transport for `--force`. A forced rebuild of a large site is a
denial-of-service knob rather than a diagnostic, and it stays on the CLI.

## The database

Everything mikser knows lives in one SQLite file at
`<workingFolder>/runtime/mikser.sqlite`. It is readable while a build
runs (WAL mode) and it is often faster to ask it directly than to add
logging.

```bash
sqlite3 runtime/mikser.sqlite
```

Five tables:

| Table | Holds |
| --- | --- |
| `mikser_entities` | the catalog — one row per entity, `data` is the JSON body |
| `mikser_journal` | the current cycle's operations, in order — cleared per cycle, which is what makes `--resume` possible |
| `mikser_refs` | the dependency graph, both directions |
| `mikser_snapshots` | what was rendered, where, and from which inputs |
| `mikser_meta` | schema version and config checksum, for cache invalidation |

### `mikser_journal`

The ordered record of what the engine did this cycle — one row per
operation, per consumer. When a build "did nothing" and you cannot see
why, this is where the absence becomes visible: an entity that was never
imported has no CREATE, and an entity gated at import has no RENDER.

```sql
SELECT operation, count(*) FROM mikser_journal GROUP BY operation;
```

### `mikser_refs`

One row per dependency edge, carrying both the question and the answer:

| Column | Meaning |
| --- | --- |
| `source_id` | the entity that depends |
| `target_ref` | the string it asked for — an id, a `meta.href`, a `meta.url`, or an id minus its extension |
| `target_id` | the entity that string resolved to, `''` if nothing did |
| `kind` | `ref` (static `$`-ref), `layout`, `partial`, `query`, `lookup` |
| `field` | for `ref`, the dotted path in `meta` |

"What breaks if I rename this?" is one query:

```sql
SELECT source_id, kind, target_ref FROM mikser_refs
 WHERE target_id = '/documents/en/authors/dick.yml';
```

A row with `target_id = ''` is a dangling reference — the dependent asked
for a name nothing currently answers to.

### `mikser_snapshots`

One row per rendered destination: `inputHash` (what it was rendered
from), `outputHash` (the bytes it produced), `refClosure` (the
dependencies it recorded), `renderedAt`. An entity can have several — one
per matched layout, one per paginated page.

## From inside a plugin or a REPL

### `runtime.refs`

The dependency graph, queryable both ways.

| Method | Answers |
| --- | --- |
| `inboundFor(ref)` | which entities `$`-ref this, and through which field |
| `outboundFor(id)` | which refs this entity emits |
| `dynamicInboundFor(target)` | which entities depend on this via layout / partial / query / lookup |
| `dynamicOutboundFor(id)` | the render-time edges this entity recorded |
| `inverseClosureOf(seeds)` | everything that transitively depends on these — the set a change dispatches |
| `resolveRefIds(ref)` | which entity ids a ref string resolves to, by all four forms |
| `allRefs()` / `size()` | every static ref target; edge and source counts |
| `subscribeGraph(opts)` | react to changes within N hops of entities matching a filter |
| `subscribeQuery(opts)` | react to changes matching a query |

`inverseClosureOf` is the one to reach for when a change re-rendered more
than you expected — it returns exactly the set the scheduler will act on.

### `runtime.manifest`

What was rendered and whether it needs redoing.

| Method | Answers |
| --- | --- |
| `snapshotsFor(id)` | every snapshot for an entity, without knowing its destinations |
| `lookup({id, destination})` | one snapshot |
| `skipDecision(entity, …)` | `{ skip, reason }` — the same reason `--json` reports |
| `recordedHashes()` | the dep-hashes dependents last saw |
| `queryAffected(mutated)` | which query-dependent snapshots this mutation hits |
| `snapshotsAt(destination)` | every snapshot claiming a destination — the reverse of `snapshotsFor`, and the way back from a built file to what produced it |
| `sourcesBehind(snapshot)` | the source entities that fed one render, each with `via` naming HOW it got there (layout, partial, ref, or the recorded query it matched) |
| `sourcesOf(destination)` | the same across every entity claiming a destination, unioned — what `mikser_which` answers from |
| `affectedBy(entity)` | which destinations would re-render if this entity changed, each with the same `reason` the build report uses |
| `verify({outputFolder})` | `{ verdict, missing, mismatched, unverifiable, orphaned, collisions }` — what `--verify` reports; pure, no mutations |
| `collisions()` | destinations claimed by more than one entity, with the ids claiming each |
| `writerOf(destination, outputHash)` | which of several claimants wrote the bytes now on disk, when the hashes can tell them apart |
| `size()` | snapshot count |

`snapshotsFor(id)` exists because an entity can render to several
destinations and a caller asking "what happened to this?" does not know
them in advance — which is exactly the position you are in when a page
did not change and you want to know why.

`sourcesBehind` is the reverse of everything else here, and it lives in the
engine because the `refClosure` IS the engine's record of what a render
consumed — which is what makes the answer authoritative rather than a
guess at which file might hold something. A bundle assembled from
`findEntities({ collection: 'styles' })` records that query, so re-running
it returns exactly the parts that went in. A query whose filter could not
be serialized names no members: it invalidates on any mutation, which is
not the same as "every entity fed this render".

`affectedBy(entity)` answers the same question one step earlier: *before*
editing a shared file, which outputs does this reach? It runs the real
`skipDecision` against each candidate rather than reimplementing the
rule, so the preview and the cycle it previews cannot disagree. What it
cannot model is how the entity's own frontmatter would change — that is
parsed during import, so an edit that moves `meta.layout` moves the
destination too, and this does not see it.

### `runtime.provenance`

Where a value was **written** — source file, field path, line and column.

| Method | Answers |
| --- | --- |
| `positionsFor(entity)` | `{ 'items[2].label': { line, col }, … }` for every leaf of the entity's meta |
| `locate(entity, fieldPath)` | one position, or null |
| `forget(id)` | drop a cached entry |

The field PATH costs nothing — it comes from walking `entity.meta`, which is
already in memory, so it is always available. Line and column need one parse
of the raw source, and that happens **on demand**, never during a build. The
result is cached in `mikser_provenance` against the entity's checksum, so the
first question about a file pays one parse and every later one pays nothing
until the file changes. A build pays nothing at all.

Formats are handled by registered handlers rather than by a chain of
`if (extension === …)`:

| Format | How the position is found |
| --- | --- |
| yaml, json | `YAML.parseDocument` reports a range on every node; YAML is a superset of JSON, so one parse covers both |
| front matter | the block is parsed the same way, with the line offset added back |
| archieml | no ranges from the parser — the uuid probe below; registered by `mikser-io-aml` |
| csv rows | synthetic entities with no file of their own; the row is located in the PARENT csv by its key; registered by `mikser-io-csv` |
| remote (`gdrive://`, `github://`, …) | read through `readEntityContent`, so the provider dispatch applies as everywhere else |
| assets | none — meta is synthesized, so no source position exists |

`registerProvenanceFormat(name, { test, positions })` adds one; `probeFormat(name,
{ test, parse })` is the shortcut for a parser that reports no ranges. Later
registrations win. A format that ships in its own package registers there — the
engine has no business knowing archieml exists.

**The probe**, for a parser with no ranges: substitute a unique token for every
value, re-parse **once** with the format's own parser, and read each position
off wherever its token actually landed. This is mikser 4.x's `plugins/guide.js`
mechanism with the thing that killed it removed — it re-parsed once per FIELD
and needed worker processes and a disk cache to survive that. Positions are
read from where tokens landed rather than from assuming a substitution matched
the intended field, so a repeated value cannot produce a confidently wrong
answer. There is no regex over the value, so its size is irrelevant.

Nothing is injected into the output. The predecessor printed provenance into
HTML comments for a browser script to turn into tooltips, which is why it was
only ever safe in development — it changed the bytes that ship. The consumer
here is an editing agent, which never looks at rendered bytes, so the answer is
returned as data instead: `mikser_which` for "what produced this output", and
`mikser_read_entity({ include: ["positions"] })` for "where is this value
written".

### `layouts.inspect()`

Exposed by `mikser-io-layouts` at `runtime.options.layouts.inspect(id)`.
Answers "what does this layout actually do?" — its template source, the
partials and references the renderer parses out of it, and the recorded
`refClosure` of up to `samples` entities that used it, so you can see
what it depended on in practice rather than in theory.

```js
const report = await runtime.options.layouts.inspect('/layouts/post.hbs', { samples: 3 })
```

Throws with `code: 'LAYOUT_NOT_FOUND'` for an id that is not a layout.

### `schemas.names()` / `schemas.lookup()`

Exposed by `mikser-io-schemas` at `runtime.options.schemas`. `names()`
lists every loaded schema; `lookup(name)` returns the zod object.

The failure worth knowing about: a schema that loaded but matched no
entity is reported at finalize, because validation that silently never
runs looks exactly like validation that passed. If you configured
schemas and see no errors, check that warning before believing the
content is clean.

### `preview`

`mikser-io`'s preview plugin exposes `runtime.options.preview = { store,
get, stats, config }` — the on-demand render cache, useful for asking
what has been rendered outside a build.

## When mikser is silent

Silence is this engine's characteristic failure mode: a declaration that
selected nothing, or an input nothing tracked, and a green build. The
surfaces that turn silence into a statement:

- **A build that rendered nothing** — `--json` distinguishes `gated`
  (source unchanged, never scheduled) from `skipped` (scheduled, manifest
  declined). Those have different causes.
- **A page pinned to stale bytes** — `--explain` on it, then read the
  `refClosure` for an `[UNRESOLVED]` edge or a dependency you expected to
  be listed and is not. An input nothing recorded is an input nothing
  invalidates.
- **A pattern or query that matched nothing** — several plugins warn on
  this now (layout patterns, preset matching, null filters). The warnings
  carry stable `code`s in `--json`.
- **Output that does not match the config** — the config's bytes take
  part in cache invalidation, so a config change forces a rebuild; but a
  module the config *imports* does not. If you changed a helper the config
  pulls in, use `--force`.
- **A plugin that appears to do nothing** — `No plugins loaded` with a
  config present is a warning naming the file. A config that fails to
  load now exits non-zero rather than loading as empty.

## See also

- [Entities](./entities.md) — the entity model, operations, journal, catalog
- [Lifecycle](./lifecycle.md) — which phase a hook can see what in
- [API Reference](./api-reference.md) — full signatures
- [Decisions](./decisions/) — why the graph is shaped this way, especially
  ADR-0002 (files are the source of truth) and ADR-0009 (SQLite substrate)
