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
import { expandEntity, projectMeta } from './utils.js'

// Render-time context propagated through async boundaries via Node's
// AsyncLocalStorage. The engine's onRender wraps each render in
// `_renderContext.run({entityId, track}, …)`; catalog query methods
// below read it back to report which filters the render consulted.
// Those filter records flow into the manifest snapshot's refClosure
// as `kind: 'query'` entries, so a future cycle can detect when a
// mutation matches a stored filter and invalidate the render.
//
// When the catalog is accessed outside a render (plugin lifecycle
// hooks, MCP/API handlers), `getStore()` returns undefined and no
// tracking happens — the same query methods serve all callers.
export const _renderContext = new AsyncLocalStorage()

// Internal raw chain accessors that bypass query tracking. Used by the
// query-recording wrappers below to call the lowdb chain without
// re-entering the tracker (which would otherwise log the unfiltered
// inner findAll as a sentinel-forced re-render dependency).
function _rawFindEntity(query) {
	return runtime.catalog.chain.get('entities').find(query).value()
}

function _rawFindEntities(query) {
	if (!query) return runtime.catalog.chain.get('entities').value()
	return runtime.catalog.chain.get('entities').filter(query).value()
}

// Normalize a filter for snapshot storage. Object filters are
// serializable as-is; function filters and primitives can't be
// serialized for replay so we record a `null` sentinel that forces
// conservative invalidation (any mutation re-renders) — safer than
// silently losing the dep.
function _normalizeFilter(filter) {
	if (filter && typeof filter === 'object' && !Array.isArray(filter)) return filter
	return null
}

function _recordQuery(filter) {
	const ctx = _renderContext.getStore()
	if (!ctx?.track) return
	ctx.track.query(_normalizeFilter(filter))
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
		entities: [],
	})
	catalog.chain = _.chain(catalog).get('data')
	runtime.catalog = catalog
})

onPersist(async () => {
	const logger = useLogger()
	const catalog = runtime.catalog
	for await (let { operation, entity } of useJournal('Catalog')) {
		switch (operation) {
			case OPERATION.CREATE:
				logger.trace('Database %s %s: %s', entity.collection, operation, entity.id)
				catalog.data.entities.push(entity)
				break
			case OPERATION.UPDATE: {
				logger.trace('Database %s %s: %s', entity.collection, operation, entity.id)
				// Upsert semantics: if the entity doesn't already exist,
				// treat UPDATE as CREATE. Plugins that "ensure an entity
				// is in the catalog" can call runtime.update without a
				// findEntity-then-branch dance. Previously a no-op when
				// the id was new, which was a silent footgun.
				const existing = catalog.chain.get('entities').find({ id: entity.id }).value()
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
	_recordQuery(query)
	return _rawFindEntity(query)
}

export async function findEntities(query) {
	_recordQuery(query)
	return _rawFindEntities(query)
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
// checks — id, meta.href, or stripped-extension id. Centralised so the
// expand walker resolves refs the same way everywhere.
async function findRef(ref) {
	if (!ref || typeof ref !== 'string') return null
	// Use the raw chain accessor so expand-driven lookups don't get
	// logged as query deps — the parent queryEntities call already
	// recorded its own filter, and the $-ref edges are tracked
	// separately via runtime.refs.
	const matches = _rawFindEntities(e =>
		!!e && (
			e.id === ref ||
			e.meta?.href === ref ||
			(typeof e.id === 'string' && e.id.replace(/\.[^./]+$/, '') === ref)
		),
	)
	return matches[0] ?? null
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

	// Record the filter (or sentinel) for manifest invalidation when
	// inside a render context. Use the raw accessor for the inner
	// findAll so the unfiltered scan doesn't show up as a separate
	// "depends on everything" sentinel.
	_recordQuery(filter)
	let all = _rawFindEntities()
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
