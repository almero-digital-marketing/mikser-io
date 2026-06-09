import runtime from './runtime.js'
import { useLogger } from './engine.js'
import { onInitialized, onPersist, onFinalized } from './lifecycle.js'
import { useJournal } from './journal.js'
import { OPERATION } from './constants.js'
import { Low } from 'lowdb'
import path from 'node:path'
import { JSONFile } from 'lowdb/node'
import _ from 'lodash'
import sift from 'sift'
import { AsyncLocalStorage } from 'node:async_hooks'
import { expandEntity, projectMeta, matchesRef } from './utils.js'
import { normalizeFilter } from './track.js'
import packageInfo from '../package.json' with { type: 'json' }

// Context propagated through async boundaries via Node's AsyncLocalStorage.
// Consumers (engine's render dispatch, api plugin's per-query cache,
// preview plugin's in-memory cache) wrap a slice of work in
// `queryContext.run({track}, …)`; catalog query methods below read
// the store and report which filters the work consulted. Collected
// filters flow into whatever cache the consumer maintains — render
// manifest snapshots, per-endpoint disk cache, in-memory preview cache.
//
// Called from outside any `.run(...)` (plugin lifecycle, raw MCP
// handlers, anywhere without a context): `getStore()` returns
// undefined, no tracking. Same query methods serve all callers.
export const queryContext = new AsyncLocalStorage()

function recordQuery(filter) {
	const ctx = queryContext.getStore()
	if (!ctx?.track) return
	ctx.track.query(normalizeFilter(filter))
}

// Same reasoning as journal.js — initialize the catalog in
// onInitialized so every plugin hook from onLoad onwards can safely
// call findEntity / findEntities and write through the journal.
// catalog.js imports useJournal from journal.js, so journal.js's
// onInitialized registers first within the phase — its hook runs
// before this one.
//
// The catalog lives at `runtime.catalog` — single source of truth.
// All operations below read through that property so tests can stub
// `runtime.catalog` with an in-memory equivalent and the same call
// shapes work without code changes.
onInitialized(async () => {
	const adapter = new JSONFile(path.join(runtime.options.runtimeFolder, `catalog.json`))
	const catalog = new Low(adapter, {
		version: packageInfo.version,
		entities: [],
	})
	// Explicit load of persisted catalog. Without this, every restart
	// starts with an empty catalog and source plugins re-CREATE every
	// entity — the source.js checksum gate has nothing to compare
	// against and the savings disappear.
	//
	// Wrapped in try/catch because malformed catalog.json (truncated by
	// a crash, hand-edited badly, partially-written on disk-full) would
	// otherwise blow up the whole startup. Fall back to defaults and
	// flag the cache as invalidated so the rest of the cycle treats
	// this as "start from scratch."
	try {
		await catalog.read()
	} catch (err) {
		const logger = useLogger()
		logger.error('Catalog read failed (%s) — starting with empty catalog', err.message)
		catalog.data = { version: packageInfo.version, entities: [] }
		catalog.cacheInvalidated = true
	}

	// Version-stamp gate. Catalog persists post-processing state
	// (entity.meta populated by plugins, entity.checksum from source.js,
	// etc.). If the engine version changed since this catalog was
	// written, the plugin chain may have evolved and gate-aware paths
	// should re-process every entity to capture the new behavior.
	// `runtime.catalog.cacheInvalidated` is the signal — source.js's
	// checksum gate consults it and bypasses; layouts dispatcher
	// could too.
	const persistedVersion = catalog.data?.version
	if (persistedVersion !== packageInfo.version) {
		catalog.cacheInvalidated = true
	}
	catalog.data.version = packageInfo.version

	catalog.chain = _.chain(catalog).get('data')
	runtime.catalog = catalog

	if (catalog.cacheInvalidated) {
		useLogger().notice(
			'Catalog cache invalidated: prior=%s current=%s — re-processing this cycle',
			persistedVersion ?? '(none)',
			packageInfo.version,
		)
	}
})

onPersist(async () => {
	const logger = useLogger()
	const catalog = runtime.catalog
	for await (let { operation, entity } of useJournal('Catalog')) {
		switch (operation) {
			case OPERATION.CREATE:
			case OPERATION.UPDATE: {
				logger.trace('Database %s %s: %s', entity.collection, operation, entity.id)
				// Upsert in both directions. Required for CREATE now that
				// the catalog persists across runs (catalog.read() at
				// onInitialized): source plugins re-emit CREATE for every
				// scanned file, and without upsert a warm restart would
				// duplicate every entity. Required for UPDATE so plugins
				// that "ensure an entity is in the catalog" can call
				// runtime.update unconditionally without a
				// findEntity-then-branch dance — previously a silent
				// no-op when the id was new.
				const existing = findById(entity.id)
				if (existing) {
					catalog.chain.get('entities').find({ id: entity.id }).assign(entity).value()
				} else {
					catalog.data.entities.push(entity)
				}
				break
			}
			case OPERATION.DELETE:
				logger.trace('Database %s %s: %s', entity.collection, operation, entity.id)
				catalog.chain.get('entities').remove({ id: entity.id }).value()
				break
		}
	}
})

onFinalized(async () => {
	await runtime.catalog.write()
})

export async function findEntity(query) {
	if (!query) return
	recordQuery(query)
	return runtime.catalog.chain.get('entities').find(query).value()
}

// Synchronous by-id lookup. Untracked — does NOT record a query
// dependency in queryContext, because the consumers are hot-path
// internal modules (manifest snapshot construction, refs inverse
// walk, catalog's own upsert check) that read the catalog for engine
// bookkeeping, not as a render-time data dep. Returns the entity or
// null.
//
// Currently sync because the underlying lowdb chain is sync. If a
// future storage backend forces async, the change is mechanical:
// add `async` here, then `await` at each callsite. Either way the
// helper centralizes the "by-id" intent, vs the previous inline
// chain construct at five sites which would need a riskier
// fragment-by-fragment grep on swap day.
export function findById(id) {
	if (!id) return null
	return runtime.catalog?.chain.get('entities').find({ id }).value() ?? null
}

export async function findEntities(query) {
	recordQuery(query)
	if (!query) return runtime.catalog.chain.get('entities').value()
	return runtime.catalog.chain.get('entities').filter(query).value()
}

// High-level CRUD-with-query surface — sift filters, sort, pagination,
// dotted-path projection, plus optional inline-expand of $-keyed
// references (ADR-0007). Used by the api plugin's HTTP handlers, the
// mikser-io-mcp plugin's tools, and any library-mode caller.
//
// `findEntity`/`findEntities` above are raw catalog access (no filter,
// no pagination, callback-style query). The queryEntities / readEntity
// pair below are the higher-level operations that compose findEntities
// with sift + expand + projection.
//
// Lives in catalog.js (not in the api plugin) because catalog operations
// are engine-level: render workers, library embedders, and other plugins
// all need to query the catalog with the same semantics. The api plugin
// is one consumer that adds HTTP routing + an on-disk cache on top.

// Match the same heuristic the schemas plugin uses for ref-existence
// checks — id, meta.href, or stripped-extension id — via the shared
// `matchesRef` predicate. Centralised so the expand walker resolves
// refs the same way everywhere.
async function findRef(ref) {
	if (!ref || typeof ref !== 'string') return null
	// Direct chain access. Expand-driven ref resolution is an
	// implementation detail of queryEntities and shouldn't surface
	// as a separate query dep — the parent queryEntities call already
	// recorded its filter, and $-ref edges are tracked separately via
	// runtime.refs.
	return runtime.catalog.chain.get('entities').find(e => matchesRef(e, ref)).value() ?? null
}

// Per-call expansion caps. Plumbed from mikser.config.js:
//   catalog: { expand: { maxDepth, maxPaths, maxResolved } }
// Defaults match ADR-0007 B7. Centralised here so every expand-aware
// operation reads the same numbers. Private — callers reach it via
// `assertExpand` (pre-flight validation) or via queryEntities (which
// applies the same caps inside the walker).
function expandLimits() {
	const cfg = runtime?.config?.catalog?.expand ?? {}
	return {
		maxDepth:    typeof cfg.maxDepth    === 'number' ? cfg.maxDepth    : 5,
		maxPaths:    typeof cfg.maxPaths    === 'number' ? cfg.maxPaths    : 20,
		maxResolved: typeof cfg.maxResolved === 'number' ? cfg.maxResolved : 100,
	}
}

// Validate an `expand` spec against the configured caps. Throws on
// violation; returns nothing on success. Used by `subscribe()` at
// registration time to reject bad expand before opening any transport
// channels. The same caps are enforced inside the walker, so this is
// purely about early/clean error surfacing.
export function assertExpand(expand) {
	if (!expand?.length) return
	const { maxPaths, maxDepth } = expandLimits()
	if (expand.length > maxPaths) {
		throw new Error(
			`expand has ${expand.length} paths, exceeds maxPaths (${maxPaths})`,
		)
	}
	for (const p of expand) {
		const parts = p.split('.').filter(Boolean)
		if (parts.length > maxDepth) {
			throw new Error(
				`Path '${p}' has length ${parts.length}, exceeds maxDepth (${maxDepth})`,
			)
		}
	}
}

// Apply expand-then-project to one entity. When `expand` has entries
// the walker inlines resolved refs first; in all cases the final meta
// is normalized (`$`-keys stripped) so the wire shape matches what the
// SDK consumers and templates expect per ADR-0007 A3. Private — the
// only callers are queryEntities (per-item) and readEntity (via
// queryEntities). External code expands by going through one of those.
async function expandAndProject(entity, expand) {
	let result = entity
	if (expand?.length) {
		result = await expandEntity(entity, expand, {
			findRef,
			...expandLimits(),
		})
	}
	if (!result?.meta) return result
	return { ...result, meta: projectMeta(result.meta) }
}

// Paginated, sorted, filtered, projected query over the catalog. The
// `scope` arg is an optional pre-filter predicate (used by the api
// plugin's per-endpoint allowedEntities lambda); library callers
// usually pass nothing. Returns `{ items, total, skip, limit, hasNext }`.
export async function queryEntities({
	filter, sort, fields, skip, limit, expand, scope,
} = {}) {
	const effectiveLimit = Math.min(100, Math.max(1, limit ?? 25))
	const effectiveSkip = Math.max(0, skip ?? 0)

	// Record the filter (or sentinel) for invalidation when inside a
	// queryContext. Direct chain access for the inner findAll so the
	// unfiltered scan doesn't show up as a separate "depends on
	// everything" sentinel.
	recordQuery(filter)
	let all = runtime.catalog.chain.get('entities').value()
	if (scope) all = all.filter(scope)

	if (filter && Object.keys(filter).length) {
		const match = sift(filter)
		all = all.filter(match)
	}

	const total = all.length

	if (sort && Object.keys(sort).length) {
		const entries = Object.entries(sort)
		all.sort((a, b) => {
			for (const [key, dir] of entries) {
				const av = _.get(a, key)
				const bv = _.get(b, key)
				if (av == null && bv == null) continue
				if (av == null) return 1
				if (bv == null) return -1
				if (av < bv) return -dir
				if (av > bv) return dir
			}
			return 0
		})
	}

	let items = all.slice(effectiveSkip, effectiveSkip + effectiveLimit)
	items = await Promise.all(items.map(item => expandAndProject(item, expand)))
	if (fields?.length) items = items.map(e => _.pick(e, fields))

	return {
		items,
		total,
		skip: effectiveSkip,
		limit: effectiveLimit,
		hasNext: effectiveSkip + effectiveLimit < total,
	}
}

// Read a single entity by catalog id. Returns the entity (post-expand,
// post-project) or null when not found. Throws on missing id.
// Source-file content loading is a separate concern — compose with
// `readEntityContent` from utils.js if you want `entity.content`
// populated (with the text/binary gate) or call `readFile(entity.uri)`
// directly if you want raw bytes.
export async function readEntity({ id, expand } = {}) {
	if (!id) throw new Error('id is required')
	const result = await queryEntities({
		filter: { id },
		skip: 0,
		limit: 1,
		expand,
	})
	return result.items[0] ?? null
}
