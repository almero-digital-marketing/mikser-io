// The render dispatcher: which entities render, on which of the three task
// modes, and what the manifest records about each one.

import Piscina from 'piscina'
import map from 'p-map'
import path from 'node:path'
import postprocess from '../postprocess.js'
import render from '../render.js'
import runtime from '../runtime.js'
import { OPERATION, TASKS } from '../constants.js'
import { queryContext } from '../database/query-context.js'
import { updateEntry, useJournal } from '../journal.js'
import { onRender } from '../lifecycle.js'
import { renderErrorCount, reportAssetUse, reportError, reportRendered, reportSkipped } from '../report.js'
import { createTrack, mergeTrack } from '../track.js'
import { useLogger } from '../use-logger.js'
import { formatErrorContext, inputHashOf, lookupKeys, projectMeta } from '../utils/index.js'
import { workerMessages, workerSafeOptions } from './workers.js'

export function registerRenderCycle() {

    onRender(async (signal) => {
        const logger = useLogger()
        const renderJobs = new Set()
        // destination → the entity ids that actually rendered to it this
        // cycle. Recorded past the skip gate rather than alongside renderJobs
        // so it holds renders that ran, which is what makes "one overwrote
        // the other" a true statement rather than a guess about two claims.
        const renderedTo = new Map()

        // Collect this cycle's mutated entity ids/hrefs/entities so the
        // manifest skip check can re-render anything whose dependencies
        // (layout, partials, $-refs, catalog queries) changed even if
        // the entity itself is byte-identical. Built once from this
        // cycle's CREATE/UPDATE/DELETE journal entries — RENDER entries
        // are this cycle's work, not the trigger.
        //
        // - `mutatedRefs` is a Map<key, Set<lang|null>>: the keys are
        //   the ids / hrefs / id-minus-extension forms a refClosure
        //   entry might target; the values are the set of languages
        //   that touched that key this cycle (null for entities with
        //   no meta.lang). The Map shape preserves the fast `.has(key)`
        //   membership check the existing skip logic relied on AND
        //   adds language information so multilingual sites don't
        //   over-invalidate. When a French author entity changes,
        //   English posts that reference the same /authors/<name>
        //   href don't re-render — the lang sets disagree.
        // - `currentHashes` carries the current input hash for each
        //   mutated entity. Cold-start file discovery emits CREATE for
        //   every file even when content didn't change; without the
        //   hash gate, every render whose dep appears in the journal
        //   would falsely invalidate.
        // - `mutatedEntities` carries the entity payloads themselves so
        //   the query-match check can call `sift(filter)` against each
        //   mutation to decide whether a stored query dep is hit.
        const mutatedRefs = new Map()
        const currentHashes = new Map()
        const mutatedEntities = new Map()
        for await (let { entity, operation } of useJournal('Manifest mutations', [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE])) {
            if (!entity?.id) continue
            mutatedEntities.set(entity.id, entity)
            const hash = operation === OPERATION.DELETE ? null : inputHashOf(entity)
            const lang = entity.meta?.lang ?? null
            // Expand the mutated entity into every form a refClosure
            // entry might target — id, meta.href, AND id-minus-extension
            // — via lookupKeys. Without the stripped form, a refClosure
            // recorded against the natural author/blog-post pattern
            // (`$author: /documents/authors/dick`) would never match
            // the mutated `/documents/authors/dick.yml` here and
            // manifest.shouldSkip would silently return true, pinning
            // the post's output to bytes that reference stale author
            // data. refs.inverseClosureOf and catalog.findEntity both
            // use the same extension-tolerant resolution; the manifest
            // layer has to match.
            //
            // Each key carries the language tag of the mutation so
            // shouldSkip can constrain by language compatibility.
            //
            // For DELETE we set `null` as the current hash so manifest.
            // shouldSkip can distinguish "target was deleted from the
            // catalog" from "target wasn't in this cycle's mutations
            // at all." Without this distinction, a consumer whose
            // refClosure points at a deleted partial/layout would
            // silently skip re-rendering.
            for (const key of lookupKeys(entity)) {
                if (!mutatedRefs.has(key)) mutatedRefs.set(key, new Set())
                mutatedRefs.get(key).add(lang)
                currentHashes.set(key, hash)
            }
        }
        let skipped = 0

        await map(useJournal('Rendering', [OPERATION.RENDER], signal), async entry => {
            const { id, entity, options, context } = entry
            const jobId = entity.id + ':' + entity.destination
            if (!renderJobs.has(jobId) && !options.ignore) {
                renderJobs.add(jobId)

                // Manifest skip: prior snapshot exists, inputHash and
                // layoutHash match, no ref-target mutated this cycle.
                // Disabled when a postprocessor is configured because
                // postprocessors typically consume the intermediate
                // rendered file (post-pdf, post-mjml). Skipping the
                // render leaves the postprocess input missing on the
                // next run. A postprocess-aware manifest that also
                // skips when the postprocess output is current would
                // close the gap — not yet implemented.
                const decision = options.postprocessor
                    // A postprocessor consumes the intermediate rendered
                    // file, so skipping would leave its input missing.
                    ? { skip: false, reason: 'postprocessor' }
                    // Scheduled BECAUSE the thing that renders it moved. The
                    // manifest cannot see that: an asset's input hash is its
                    // own source, and a preset's revision is not part of it,
                    // so the skip was correct about the entity and wrong about
                    // the render. Bumping a preset's `revision` — the
                    // documented way to force a rebuild — therefore deleted
                    // the stale marker and left the derivative untouched.
                    : options.rendererChanged
                    ? { skip: false, reason: 'renderer-changed' }
                    : runtime.manifest?.skipDecision(entity, mutatedRefs, currentHashes, mutatedEntities)
                        ?? { skip: false, reason: 'no-manifest' }
                if (decision.skip) {
                    skipped++
                    entry.output = { success: true, skipped: 'manifest' }
                    await updateEntry({ id, output: entry.output })
                    reportSkipped(entity, decision.reason)
                    logger.debug('Manifest skip: %s → %s', entity.name || entity.id, entity.destination)
                    return
                }
                if (entity.destination) {
                    if (!renderedTo.has(entity.destination)) renderedTo.set(entity.destination, new Set())
                    renderedTo.get(entity.destination).add(entity.id)
                }
                // Reported on the way OUT, not here: `rendered` means the
                // output moved, and a render that throws writes nothing. The
                // decision is carried down to the success path so the reason
                // and its detail still travel with it.
                //
                // Same detail at debug, for tailing a watch run. One line per
                // render is too much for a build's normal output — the counts
                // are the summary and --json is the record — but when you are
                // watching one page misbehave, the trigger is the whole point.
                if (logger.isLevelEnabled?.('debug') ?? true) {
                    logger.debug('Render %s: %s%s', entity.id, decision.reason,
                        decision.changed?.length ? ` (${decision.changed.join(', ')})`
                        : decision.matched ? ` (${JSON.stringify(decision.matched.filter)}`
                            + `${decision.matched.by ? ` ← ${decision.matched.by}` : ''})`
                        : decision.dependency ? ` (${decision.dependency.kind} `
                            + `${decision.dependency.target} ${decision.dependency.cause})`
                        : '')
                }
                // Project reference-marker keys (`$author`, `$hero`, …)
                // into their normalized form (`author`, `hero`) before
                // the entity crosses into the renderer — applies whether
                // the render runs in-process or on a worker thread.
                // Templates and renderer plugins see plain field names;
                // the canonical `$`-keyed form stays in the catalog entry
                // where the schemas and refs plugins consume it.
                // Per ADR-0007 A4, on collision the `$`-version wins
                // deterministically in the projection.
                const renderEntity = entity?.meta
                    ? { ...entity, meta: projectMeta(entity.meta) }
                    : entity
                // Per-render dep tracker — partials reported by the
                // renderer plugin's partial-loading hooks, queries
                // reported automatically by catalog methods via the
                // queryContext ALS established below. Worker dispatch
                // can't share this object across thread boundaries —
                // those renders get layout-only deps (added by
                // manifest.collectEdges) and rely on coarser
                // invalidation. INLINE is the default mode.
                // `meta: true` turns on read-recording over the entity's own
                // meta. Opt-out rather than opt-in: a contract that is only
                // correct when someone remembered to enable it is a contract
                // nobody can rely on. Set `metaReads: false` to switch it off.
                const track = createTrack({ meta: runtime.options.metaReads !== false,
                                            consumed: runtime.options.metaReads !== false })
                const renderOptions = {
                    entity: renderEntity,
                    options: {
                        tasks: TASKS.INLINE,
                        ...runtime.options,
                        ...options,
                    },
                    // Per-renderer options live on each renderer
                    // descriptor (.options) and are picked up inside
                    // render.js at dispatch time — no top-level config
                    // channel anymore (ADR-0010).
                    config: {},
                    context,
                    state: runtime.state,
                    track,
                }
                try {
                    let result
                    // Wrap the dispatch in the queryContext so catalog
                    // queries called anywhere inside the render (renderer
                    // plugin, layout sidecar, helper functions) report
                    // their filters to the track object automatically.
                    // INLINE/SERIAL inherit the ALS through await
                    // boundaries; WORKER mode crosses a thread boundary
                    // so its renders don't pick up the context — they
                    // fall back to layout-only deps.
                    result = await queryContext.run({ entityId: entity.id, track }, async () => {
                        switch (renderOptions.options.tasks) {
                            case TASKS.INLINE:
                                renderOptions.logger = logger
                                renderOptions.signal = signal
                                if (!signal.aborted) {
                                    return await render(renderOptions)
                                }
                                return undefined
                            case TASKS.SERIAL:
                                renderOptions.logger = logger
                                renderOptions.signal = signal
                                if (!signal.aborted) {
                                    return await runtime.engine.queue.add(() => render(renderOptions), { signal })
                                }
                                return undefined
                            case TASKS.WORKER:
                                const mc = new MessageChannel();
                                mc.port2.onmessage = workerMessages()
                                mc.port2.unref()
                                renderOptions.port = mc.port1
                                // Strip plugin-surface functions
                                // (the layouts service's inspect, etc.) so
                                // Piscina's structured clone doesn't choke on
                                // them. Engine-side primitives pass through;
                                // plugin surfaces are reachable via the
                                // worker's own sqlite handle or by IPC over
                                // the port.
                                renderOptions.options = {
                                    ...workerSafeOptions(runtime.options),
                                    tasks: renderOptions.options.tasks,
                                    ...options,
                                }
                                // Track is a closure object — its .partial /
                                // .query methods can't cross thread
                                // boundaries. Workers fall back to
                                // layout-only deps (added by
                                // manifest.collectEdges), so drop the track
                                // entirely before dispatch.
                                renderOptions.track = undefined
                                return await runtime.engine.renderWorkers.run(
                                    renderOptions,
                                    { signal, transferList: [mc.port1] }
                                )
                        }
                    })

                    // One shape from both dispatch modes. A worker returns its
                    // track's CONTENTS alongside the output, because the track
                    // itself could not be sent to it — folding them in here is
                    // what gives a worker render the same partial, lookup and
                    // meta-read deps an inline one has always had.
                    const rendered = result
                    result = rendered?.output
                    if (rendered?.track) mergeTrack(track, rendered.track)

                    // Which files this entity's template linked to. Harvested
                    // here because this is the one place that has both the
                    // track and the entity that produced it — a worker's track
                    // has just been folded in, so a worker render is covered
                    // the same as an inline one.
                    for (const destination of track.assets ?? []) {
                        reportAssetUse(destination, renderEntity.id)
                    }

                    if (!signal.aborted) {
                        // Meta reads ride on `output`, which is already
                        // free-form JSON on the journal row, rather than in
                        // `deps`: deps is the edge list that drives
                        // invalidation, and a property path is not an edge.
                        //
                        // Both halves are merged here. The template's reads
                        // come through the render track; the SIDECAR's come
                        // through the context, because a sidecar runs earlier,
                        // in the layouts plugin, against its own track — and
                        // the sidecar is the half no parser can see.
                        const metaReads = [
                            ...(track?.metaReads ?? []),
                            ...(context?.sidecarMetaReads ?? []),
                        ]
                        // Which keys of OTHER entities this render read, keyed
                        // by the entity they belong to. Merged from the same two
                        // places: the render's own track, and the sidecar's,
                        // which runs earlier on the main thread.
                        const consumedReads = new Map()
                        for (const [cid, paths] of [
                            ...(track?.consumedReads ?? []),
                            ...(context?.sidecarConsumedReads ?? []),
                        ]) {
                            const into = consumedReads.get(cid) ?? new Set()
                            for (const path of paths) into.add(path)
                            consumedReads.set(cid, into)
                        }
                        entry.output = {
                            success: true,
                            result,
                            ...(metaReads.length ? { metaReads: [...new Set(metaReads)].sort() } : {}),
                            ...(consumedReads.size ? {
                                consumedReads: [...consumedReads]
                                    .map(([cid, paths]) => [cid, [...paths].sort()])
                                    .sort(([a], [b]) => a.localeCompare(b)),
                            } : {}),
                        }
                        // A render that produced nothing at all. Distinct from
                        // a render that THREW, which lands in `errors` and
                        // leaves the previous good bytes on disk: this one
                        // succeeded, wrote an empty file over whatever was
                        // there, and counted itself in `rendered`.
                        //
                        // Deliberately narrow. It catches total failure, not a
                        // page that rendered its chrome and lost its content —
                        // that output is not empty and this will not see it.
                        // Only a string can be judged; a renderer returning
                        // some other shape is left alone rather than guessed at.
                        if (typeof result === 'string' && result.trim() === '') {
                            logger.warn(
                                { code: 'empty-output', entity: entity.id,
                                  layout: entity.meta?.layout ?? null,
                                  destination: entity.destination ?? null },
                                'Rendered %s to an EMPTY file at %s. The render succeeded, so this is not in ' +
                                'errors — but it overwrote the destination with nothing. Usually the layout ' +
                                'produced no output for this entity: check that it matched the layout you expect ' +
                                'and that the branch it took writes something.',
                                entity.name || entity.id, entity.destination ?? '(no destination)')
                        }
                        // Manifest owns the refClosure schema; we just
                        // hand it the entity, the track, and the sidecar
                        // queries (collected at layouts.onBeforeRender
                        // inside queryContext). collectEdges adds the
                        // auto-layout edge, hashes track.partials via
                        // catalog lookup, and merges template-time +
                        // sidecar queries.
                        const edges = runtime.manifest.collectEdges({
                            entity,
                            track,
                            sidecarQueries: context?.sidecarQueries,
                        })
                        entry.deps = edges
                        // Pagination produces synthetic pageEntities
                        // (index.2.html, index.3.html, ...) whose ids
                        // are NOT in mikser_entities — they exist only
                        // at render time. Roll their dynamic refs up to
                        // entity.parent (set by layouts.onBeforeRender
                        // for pages 2+) so the mikser_refs FK to
                        // mikser_entities holds. The parent's own
                        // render also writes to the same source_id;
                        // INSERT OR IGNORE in stmtInsertEdge handles the
                        // dedup across pages. Invalidation re-dispatches
                        // the parent and the pagination expansion
                        // produces the children from there, so granular
                        // per-page refs aren't needed.
                        runtime.refs?.replaceDynamic(entity.parent ?? entity.id, edges)
                        await runtime.complete(entry)
                        await updateEntry({ id, output: entry.output, deps: edges })
                    }

                    // A success clears whatever was recorded about this
                    // destination failing, so the retry set drains itself.
                    runtime.manifest?.clearFailure(entity)
                    reportRendered(entity, decision.reason, decision)
                    logger.debug('Rendered: [%s] %s → %s', options.renderer, entity.name || entity.id, entity.destination)
                } catch (err) {
                    if (!signal.aborted) {
                        await updateEntry({ id, output: { success: false } })
                        const context = formatErrorContext(entity, err, runtime.options)
                        logger.error('Render error: %s%s %s', entity.id, context, err.message)
                        // The machine-readable half of that same line. Without
                        // it a build that fails every page reports rendered:N,
                        // warnings:0 and exits 0 — three clean signals and only
                        // the human log knowing otherwise.
                        // Durable, so the next cycle knows to try again and
                        // --explain stops calling this destination current.
                        runtime.manifest?.recordFailure(entity, {
                            error: err.message,
                            context: context.trim() || null,
                            at: Date.now(),
                        })
                        const failure = runtime.manifest?.failureAt(entity.id, entity.destination)
                        reportError(entity, err, {
                            renderer: options.renderer ?? null,
                            layout: entity.layout?.id ?? null,
                            context: context.trim() || null,
                            // When it STARTED failing, and how many attempts.
                            // "broke just now" and "broken since 14:02" are
                            // different situations and the reader needs to
                            // tell them apart at a glance.
                            since: failure?.firstFailedAt ?? null,
                            attempts: failure?.attempts ?? 1,
                        })
                    }
                    logger.debug('Render canceled')
                }
            } else {
                await updateEntry({ id, output: { success: true } })
            }
        }, {
            concurrency: runtime.options.threads,
            signal
        })
        // Jobs minus skips minus THROWS. Counting a failed render as
        // rendered is the same overstatement the report used to make.
        const failed = renderErrorCount()
        renderJobs.size && logger.info('Rendered: %d', renderJobs.size - skipped - failed)
        skipped && logger.info('Manifest skipped: %d', skipped)
        failed && logger.error('Render errors: %d', failed)

        // Two entities writing one destination in the same cycle: one
        // silently overwrote the other, and every other signal reads clean.
        // Reported per cycle rather than only by --audit-output because this is
        // the moment it happened, and because a build that discards half its
        // output must not report warnings: 0.
        //
        // Derived from the destinations THIS cycle rendered, so an
        // established collision the operator already knows about does not
        // re-warn on every unrelated build; --audit-output is where the standing
        // state lives.
        for (const [destination, ids] of renderedTo) {
            if (ids.size < 2) continue
            const entities = [...ids].sort()
            logger.warn(
                { code: 'destination-collision', destination, entities },
                'Destination collision: %s written by %d entities in this cycle (%s). '
                + 'One overwrote the other — whichever rendered last wins.',
                destination, entities.length, entities.join(', '),
            )
        }
    })
}
