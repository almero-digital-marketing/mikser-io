# ADR-0010 — Plugin bundles, factory-call form, and inline options

**Status:** Accepted
**Date:** 2026
**Supersedes:** —
**Superseded by:** —

## Context

Today's plugin shape pushes three frictions into every plugin author and
every consumer config:

1. **One npm package = one plugin.** When a coherent concern naturally
   splits across two lifecycle slots — assets (main-process import +
   render-side template helper), MCP (core substrate + UI dispatcher) —
   the author either ships two packages with cross-imports of shared
   business logic, or stuffs everything into one plugin and forces every
   consumer to take both halves. The first violates the no-cross-plugin-
   imports rule; the second forces an all-or-nothing decision the user
   shouldn't have to make.
2. **String-based resolution couples the consumer to the npm name.**
   `plugins: ['vector']` resolves to `mikser-io-vector`'s default export.
   The mapping is implicit (lives in `src/plugins.js`), uncheckable by
   the IDE, and silently dies on typos. Worse, the prefix-sniff
   `'render-*' → renderer loader, 'post-*' → postprocessor loader` mixes
   *naming convention* with *dispatch shape* — a renderer named
   `mikser-io-rendr-foo` (typo or not) wouldn't get treated as a
   renderer at all.
3. **`runtime.config.<plugin>` namespace contract.** Each plugin reads
   options from a top-level config block whose key has to match the
   plugin name. Sibling plugins in the same package that share config
   either duplicate it (the user writes the same options under two top-
   level keys) or violate the contract by reading another plugin's
   block. Either way the user has to learn a convention that the
   language already solves with variables.

The audit (sweeping every `mikser-io-*` repo + `src/plugins/`) confirmed
that today's shape is the constraint, not the design. The packages that
*should* ship multiple plugins are forced into either fragmentation or
god-plugins; the packages that don't need multiplicity pay no cost
either way.

## Decision

### 1. Plugins are bundled via plain ESM named exports

A plugin package exports one or more **named factory functions**. No
`default` is required and no descriptor object wraps them. Each named
export is a plugin in its own right. Sibling factories in the same
package share private business logic through normal module-level
imports — the no-cross-plugin-imports rule applies *across packages*,
not within one.

```js
// mikser-io-assets/index.js
import { presetState, normalizePresetConfig } from './shared.js'

export function assets(options = {}) { /* ... */ }
export function renderAssets(options = {}) { /* ... */ }
```

### 2. Factory-call form, three minimal shapes

Every entry in `plugins: []` is a **factory call** (or the result of
one). The factory takes options and returns one of three shapes; the
engine duck-types the dispatch on the return value.

**Plugin** — registers lifecycle hooks. Factory returns a closure that
receives `core` and registers handlers.

```js
export function vector(options = {}) {
    return (core) => {
        core.onLoaded(...)
        core.onBeforeRender(...)
    }
}
```

**Renderer** — turns entities into rendered output. Factory returns an
object with `load` + `render`. No `core`, no hook ceremony.

```js
export function renderMarkdown(options = {}) {
    return {
        name: options.name ?? 'markdown',
        load({ runtime }) { /* ... */ },
        render({ entity, runtime }) { /* ... */ },
    }
}
```

**Postprocessor** — transforms rendered output. Factory returns an
object with `output` + `setup`/`postprocess`/`teardown`.

```js
export function postPdf(options = {}) {
    return {
        name: options.name ?? 'pdf',
        output: 'pdf',
        setup, postprocess, teardown,
    }
}
```

The author of a renderer or postprocessor never needs to know what
`core` is. The lifecycle layer is the ceiling, not the floor — a new
author writing a Liquid wrapper learns the renderer shape and stops
there.

### 3. Inline options — no `runtime.config.<plugin>` lookup

Plugin options arrive as the factory's first argument. There is no
engine-level "plugin's config key" contract.

```js
// before
runtime.config.vector?.stores

// after
options.stores
```

Shared options between sibling factories are shared the JavaScript way:

```js
const sharedAssetOpts = { presets: {...}, assetsFolder: 'assets' }
plugins: [assets(sharedAssetOpts), renderAssets(sharedAssetOpts)]
```

Top-level config keys in `mikser.config.js` remain valid only for
*engine* concerns — `logging`, `server`, `catalog`, etc. — anything
consumed by `src/` modules in the engine itself, not by a plugin
factory.

### 4. Always call the factory

The plugins list carries the *return value of the factory call*, not
the factory itself.

```js
plugins: [documents(), files(), layouts(), vector({ stores: {...} })]
```

Bare references (`documents` without `()`) are not accepted. This keeps
the engine's dispatch mechanical — every entry is "something a factory
returned" — and matches the shape consumers see for plugins that need
options.

## Engine changes

- `src/plugins.js`
  - Drop the `plugin.indexOf('render-')` / `'post-'` prefix filter.
  - Drop the `await import('mikser-io-${name}')` string resolution.
  - Drop the `plugin.default(core)` call path.
  - New loop: iterate `runtime.options.plugins` as already-instantiated
    return values; dispatch by shape (function → call with core; object
    with `render` → register renderer; object with `postprocess` →
    register postprocessor).
- `src/render.js`
  - Renderer registry replaces the per-package lazy `await import`
    keyed off layout `render:` frontmatter. Registry is populated at
    `onLoad` from the dispatched factory returns.
- `src/postprocess.js`
  - Same shape — postprocessor registry populated at `onLoad`,
    consulted at dispatch time.
- `src/config.js`
  - No longer reads `runtime.config.<plugin>`. Plugin options have left
    the config object entirely.

## Migration scope

- **Core built-in plugins** (`src/plugins/*.js`): 16 plugins. Each
  default-export factory becomes a named export following the v9
  shape. Re-exported from `index.js` so `import { documents } from
  'mikser-io'` works.
- **Plugin-shape packages** (8): `mcp`, `vector`, `schemas`, `archive`,
  `decap`, `aml`, `live`, `whitebox`. Default export → named factory.
  `runtime.config` reads → options arg. `mcp`'s existing named exports
  (`createMcpSubstrate`, `mountMcpOnExpress`, `wireLoggerToMcp`) stay
  as helpers alongside the new `mcp` factory.
- **Renderer packages** (5): `render-ect`, `render-eta`, `render-liquid`,
  `render-markdown`, `render-metatext`. Wrap existing `load`/`render`
  exports in a named factory that returns the object form.
- **Postprocessor packages** (2): `post-pdf`, `post-mjml`. Wrap existing
  `setup`/`postprocess`/`teardown` + `output` in a named factory.
- **Not in scope**: `claude-plugin` (Claude Code skills, not a mikser
  plugin).

All packages bump to a major version since the export shape changes.
Per the till-v10-no-users posture, there's no back-compat layer; the
old shape stops working when v9 lands.

## Why this works

- **Bundles solve the two-package-for-shared-BL problem** without
  forcing all-or-nothing on consumers — each named export is opt-in.
- **Inline options remove the convention layer.** Sharing config
  between sibling factories is a variable, not a documented rule.
- **Duck-typed dispatch keeps the per-category minimum.** A renderer
  author writes a factory + two functions and learns nothing about
  `core`; a plugin author touches the lifecycle but never thinks about
  factory return shape because the only return shape for plugins is a
  function.
- **Engine-side: fewer dispatch paths.** The string-prefix sniff and
  the per-category string resolver collapse into one
  shape-discriminating loop.

## Consequences

- **Consumer config is more JavaScript-shaped.** `plugins: [...]`
  carries function calls and inline options instead of strings + top-
  level config blocks. The file gets a little longer in width per
  entry; the top-level config object correspondingly shrinks.
- **No "plugin name" at the config level.** The string identifier a
  plugin had under v8 (`'vector'`) is gone. Where a name is still
  needed at runtime (e.g. layout's `render: 'markdown'` frontmatter
  refers to the renderer by name), the factory's returned object
  carries it explicitly.
- **`runtime.config.<plugin>` reads from plugin source are a v9
  regression target.** The migration sweep has to grep them all out;
  the audit shows 3 plugin packages and 16 core plugins to touch.
- **String-only configs (CLI flags producing `--plugin foo`) lose
  support.** v9 plugins must be imported and called; you can't activate
  a plugin via a CLI string. The shorthand was used in test fixtures
  and a handful of docs examples; both get migrated.
