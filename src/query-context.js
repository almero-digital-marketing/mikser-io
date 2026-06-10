// Pure module — no dependencies. Holds the AsyncLocalStorage instance
// that propagates a query-tracking context through async boundaries.
// Lives outside catalog.js so engine.js can import the context without
// pulling catalog.js into a circular load order (database → engine →
// catalog → database).
//
// Consumers (engine's render dispatch, api plugin's per-query cache,
// preview plugin's in-memory cache) wrap a slice of work in
// `queryContext.run({track}, …)`; catalog query methods read the
// store and report which filters the work consulted to `track.query`.
//
// Called from outside any `.run(...)` (plugin lifecycle, raw MCP
// handlers, anywhere without a context): `getStore()` returns
// undefined, no tracking. Same query methods serve all callers.

import { AsyncLocalStorage } from 'node:async_hooks'

export const queryContext = new AsyncLocalStorage()
