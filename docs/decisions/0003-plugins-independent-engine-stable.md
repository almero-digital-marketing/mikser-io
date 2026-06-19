# ADR-0003 — Plugins are independent packages; the engine doesn't grow

**Status:** Accepted
**Date:** 2026

## Context

Most plugin systems start clean and grow muddy. Features get absorbed into the engine "for convenience"; plugin authors reach into engine internals; abstractions leak in both directions. Within a few major versions the plugin API and the engine internals are entangled enough that breaking changes ripple unpredictably, plugin compatibility becomes a matrix, and the cost of every change rises.

The opposite end is rigid: the engine has a small, stable contract; plugins build on top via that contract only; sharing logic between plugins requires another package, not a direct import.

The rigid end has trade-offs (slightly more files, no engine-side optimizations for plugin behavior, occasional duplication), but it has one critical property: the engine stays stable across many years of plugin churn. New plugins can be experiments without affecting the engine. Old plugins keep running as the engine evolves.

For an agency tool that should serve client projects over 5+ years, engine stability is the load-bearing property.

## Decision

Mikser plugins are independent npm packages. Each plugin lives in its own repo, has its own version, declares mikser as a peer dependency, and uses only the documented plugin API.

The plugin API surface — the lifecycle hooks, the runtime singleton, the `useJournal` / `useRenderer` / `useCollection` helpers — is the only contract. Plugins do not import from mikser internals. The engine has no plugin-specific code (no `if (plugin === 'foo')` branches, no plugin allowlists).

New features go in plugins, not in the engine. The engine grows *only* when:

1. A capability is load-bearing for the lifecycle itself (e.g., a new lifecycle phase), AND
2. The capability cannot be expressed as a plugin without privileged access, AND
3. The change is reviewed as a public-API change with a documented rationale.

These criteria are deliberately strict. The engine should grow rarely.

## Consequences

**Easier:**
- Plugins can be experiments. Decap was added as a probe (~150 lines) without touching the engine. Vector switched backends from sqlite-vec to pgvector with no engine changes.
- The engine has a stable contract that survives plugin churn — useful both for plugin authors and for client projects that depend on specific plugins.
- Adding capabilities for one client doesn't entangle other clients. A custom plugin for one project never appears in another's dep tree.
- Plugins are independently versioned, installed, and dropped.
- Pattern-matching across plugins is dense — a new plugin author has 15+ working examples to study, all in the same shape.

**Harder:**
- More files to maintain. Each plugin is its own repo, with its own README, LICENSE, package.json, version log.
- Plugins cannot optimize by reaching into core. Performance work that would benefit from privileged access has to either go in the engine (with high bar — see decision criteria above) or accept the public-API performance ceiling.
- Sharing logic between plugins requires extracting another package, not a direct import. We've accepted some duplication (e.g., MikserError lives in both SDKs).

## Examples in the codebase

- 15+ plugin packages, each in its own repo, each with its own version cycle. None reach into engine internals.
- `mikser-io-vector` migrated from sqlite-vec to pgvector with zero engine changes.
- `mikser-io-decap` wrapped a substantial external project (Decap CMS — its own SPA, its own backend protocol) in ~150 lines of plugin code, no engine changes. See ADR-0004 framing — this is also evidence that the principle generalizes.
- `mikser-io-render-eta`, `-liquid`, `-markdown` add template engines without touching the renderer core. The renderer just dispatches to the registered renderer.
- Cross-plugin sharing happens via the runtime singleton (e.g., `runtime.findSimilar` exposed by the vector plugin) rather than via imports.

## Watch for drift

Pressure-test phrasing to recognize:

- "This is much cleaner if we just add it to the engine"
- "The plugin needs a flag that only makes sense in core"
- "Let's expose this internal so plugin X can be faster"

Each of these is asking for the engine to grow without meeting the three criteria. Default: extend the plugin, not the engine. Engine changes are the last resort, not the first.

The single biggest sign of drift is the engine accumulating plugin-specific code paths. The moment we have `if (plugins.includes('foo'))` anywhere in the engine, the principle has been violated. The engine should not know which plugins are loaded.

When pressure is genuinely structural (e.g., a new lifecycle phase is needed), make the engine change small and document it as an ADR. Don't bundle multiple plugin-shaped concerns into one engine change.
