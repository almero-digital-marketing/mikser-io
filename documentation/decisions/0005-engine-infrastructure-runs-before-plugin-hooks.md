# ADR-0005 — Engine infrastructure is ready before any plugin hook runs

**Status:** Accepted
**Date:** 2026
**Supersedes:** —
**Superseded by:** —

## Context

Mikser's lifecycle is divided into phases (initialize → initialized → load → loaded → import → processed → persist → render → finalize). Within each phase, hooks fire in **registration order**. This is fine in principle, but it created a recurring footgun: engine infrastructure — the journal, the catalog — used to initialize itself in `onLoaded` hooks. Plugin authors who tried to write to the journal in their own `onLoad` or `onLoaded` would discover that:

- Their `onLoad` ran before the journal existed.
- Their `onLoaded` worked only because journal.js happened to be imported before their plugin (and so registered earlier in the `loaded` phase).
- `runtime.update(entity)` did silent nothing if the entity didn't already exist in the catalog (the catalog's UPDATE handler was a strict patch, not an upsert).

Three plugins independently hit this — vector, decap, schemas — and each had to discover the workaround empirically. That's a sign the implementation detail was leaking into the plugin contract.

## Decision

Three guarantees, documented as part of the public contract:

**1. Engine infrastructure (journal, catalog) initializes during `onInitialized`, not `onLoaded`.** By the time any plugin hook runs — including `onLoad`, the earliest phase available to plugins — `runtime.create`, `runtime.update`, `runtime.delete`, `findEntity`, and `findEntities` all work. Plugin authors don't need to know which engine module loaded first.

To make this work, engine.js's folder resolution (workingFolder, runtimeFolder, outputFolder) moves from `onInitialized` into `onInitialize` — the first phase. By `onInitialized`, the runtime folder exists on disk, journal.js can open its sqlite file, and catalog.js can locate its lowdb file.

**2. `runtime.update(entity)` is upsert.** If an entity with that id doesn't exist in the catalog, UPDATE creates it. If one does, UPDATE replaces it. There is no "patch-existing-only" semantic to think about; "ensure this entity is in the catalog" is one call.

`runtime.create` is still available for callers who want strict create semantics, but most source plugins should prefer `runtime.update` because it's idempotent across reloads.

**3. A `useSource` helper codifies the "folder of files becomes entities" pattern.** Plugin authors of source-style plugins (schemas, layouts, documents, files, resources, assets) can call:

```js
useSource({
    collection: 'schemas',
    type:       'schema',
    folder:     'schemas',
    extensions: ['js', 'mjs', 'cjs'],
    load: async ({ file, name }) => ({ meta: { ... } }),
})
```

…and the helper handles folder resolution, glob scanning, the chokidar wiring, entity construction (id, name, format, uri, stamp), and upsert into the catalog. Plugin authors only carry the domain-specific load step.

## Consequences

**Easier:**
- Plugin authors don't need to understand engine module import order.
- A new source plugin is ~30 lines instead of ~150.
- `runtime.update(entity)` is the one call you reach for; create vs update is no longer a decision.
- The "your hook ran before the journal existed" class of bug is eliminated by construction.

**Harder:**
- Slightly more coupling between engine.js, journal.js, and catalog.js — the contract that engine.js sets folders in `onInitialize` (before `onInitialized`) is now load-bearing. Documented here so it doesn't get refactored away accidentally.
- Plugins that historically relied on `runtime.update` being a strict patch (silent no-op when missing) will now create entities they didn't before. This is the intended behavior change; the old behavior was a bug.

## The lifecycle contract (documented summary)

These properties hold across the engine; plugin authors can rely on them:

**Phase order:** `initialize → initialized → load → loaded → import → imported → process → processed → persist → persisted → beforeRender → render → afterRender → beforePostprocess → postprocess → afterPostprocess → finalize → finalized`. Plus `cancel / cancelled / complete / sync / validate` as event-shaped hooks.

**Within a phase, hooks fire in registration order.** Engine modules register at module-load time and therefore run before plugins. Plugin factories run during the `load` phase (in `plugins.js`'s `onLoad`), so plugin code can register hooks only for `loaded` onwards. Hooks registered for already-past phases never fire.

**Engine infrastructure is ready by the start of the `load` phase:**
- Logger is configured.
- `runtime.options.workingFolder`, `runtimeFolder`, `outputFolder` are resolved (absolute paths).
- `runtimeFolder` exists on disk.
- Journal and catalog are initialized.
- `runtime.create`, `runtime.update`, `runtime.delete`, `findEntity`, `findEntities`, `useJournal` all work.

**Journal semantics:**
- `useJournal(name, operations, signal)` returns an async iterator over journal entries that match `operations`.
- The journal is **broadcast** — every iterator sees all entries matching its filter. Nothing is consumed.
- The `name` argument is a progress-tracking label, not a state key or filter.
- The journal is cleared by `journal.js`'s `onFinalized` handler at the end of each cycle. To read journal entries at end-of-cycle, hook `onFinalize` (one phase earlier) — not `onFinalized`.

**Catalog semantics:**
- UPDATE upserts (see Decision #2).
- CREATE pushes unconditionally; double-creating the same id will produce duplicate rows. Prefer UPDATE for idempotent registration.
- DELETE removes by id; missing id is a no-op (no error).

**Sync semantics:**
- `onSync(collection, handler)` is called when the file watcher detects a change in that collection's folder. Despite the name, this is *chokidar dispatch*, not "synchronise data."
- The handler receives `{ action, context }` where action is one of `CREATE`, `UPDATE`, `DELETE` and `context.relativePath` is set for file-shaped events.

## Watch for drift

Pressure-test phrasing to recognize:

- "We need plugin foo to run before plugin bar in onLoaded — let's add a priority field." — No. Registration order is the rule. If you need a specific ordering, put the dependent work in a later phase.
- "Let's add a guard that warns when runtime.update is called for a missing entity." — No. Upsert is now the contract.
- "Let's let plugins register `onInitialize` hooks for setup." — No. Plugins load during `load`; earlier-phase registrations would silently never fire. The contract is "plugin hooks from `loaded` onwards." If a plugin needs initialization, do it in `onLoaded`.

The drift here is treating registration order as a contract worth manipulating. It's an implementation detail that happens to be deterministic; the *contract* is what's documented in this ADR.
