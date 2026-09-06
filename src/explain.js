// `--explain <entity-id>` — what happened to one entity, and why.
//
// Assembly, not new machinery: every line comes from state the engine already
// keeps (catalog, manifest snapshots, inputHashOf, the layouts matcher's
// output). It exists because the question asked most often about a build is
// "why did this NOT change?", and until now the only way to answer it was to
// read plugin source and hand-query runtime/mikser.sqlite — which works, and
// needs knowledge a user of the tool should not need.
//
// Follows --audit-output's shape: report and exit, no build phases run.
import { existsSync } from 'node:fs'
import { inputHashOf, inputPartsOf, diffInputParts, lookupKeys, checksum as fileChecksum, isLocalUri, uriScheme } from './utils/index.js'
import { recomputeSourceChecksum } from './source.js'
import { outputMissing } from './invalidation.js'
import { filterKey } from './track.js'
import { findEntity, findEntities, findById } from './catalog.js'
import runtime from './runtime.js'

const shortHash = (h) => (h ? String(h).slice(0, 8) : null)
const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : null)

// Resolve loosely: an id, a meta.href, or an id without its extension. The
// same extension-tolerant resolution refs and the catalog already use — so a
// caller can paste whatever form they have in front of them.
async function resolve(reference) {
    const direct = await findEntity({ id: reference })
    if (direct) return direct
    const byHref = await findEntity({ 'meta.href': reference })
    if (byHref) return byHref
    // id-minus-extension: /documents/bg/index → /documents/bg/index.md
    const like = await findEntity({ id: { $regex: `^${reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[^./]+$` } })
    return like ?? null
}

// How many entities each recorded query filter matches RIGHT NOW.
//
// A query edge is a predicate — "any entity matching this" — and the
// recording layer deliberately stores the filter without its results, so
// that an entity appearing later still invalidates the render. That is the
// property that makes aggregate pages work and it must not change.
//
// Explaining is a different situation: read-only, reporting instead of
// building, with the catalog already open. So the count is computed here,
// at read time, where it costs nothing and answers "is this reference
// dangling?" for the edge kind that carries most of a real site's
// references.
//
// Run through findEntities rather than hand-rolled SQL: stored filters
// include $regex and anything else sift accepts, and one code path is the
// only way the count means the same thing the render meant.
//
// A null filter is the sentinel for a predicate that could not be
// serialized (a function filter, or findEntities() with no argument). It
// invalidates on any mutation by design, and there is nothing to evaluate,
// so it reports null rather than a misleading zero.
async function countQueryMatches(snapshots) {
    const counts = new Map()
    for (const snap of snapshots) {
        for (const entry of snap.refClosure ?? []) {
            if (entry.kind !== 'query') continue
            const key = filterKey(entry.filter ?? null)
            if (counts.has(key)) continue
            if (entry.filter == null) {
                counts.set(key, null)
                continue
            }
            try {
                // recordQuery no-ops outside a render's queryContext, so
                // explaining a page cannot record edges onto it.
                const matches = await findEntities(entry.filter)
                counts.set(key, { count: matches.length, sample: matches[0]?.id ?? null })
            } catch {
                // A stored filter the catalog can no longer evaluate is worth
                // saying so about, not worth failing the whole report for.
                counts.set(key, 'unevaluable')
            }
        }
    }
    return counts
}

// Project a counted filter into the report's shape.
function queryCount(counts, filter) {
    const hit = counts.get(filterKey(filter ?? null))
    if (hit === null) return { matched: null }
    if (hit === 'unevaluable') return { matched: null, unevaluable: true }
    if (!hit) return { matched: null }
    return { matched: hit.count, ...(hit.count === 1 && hit.sample ? { sample: hit.sample } : {}) }
}

// A destination two entities claim outranks anything the hashes say. The
// hash reasoning would be true AND useless: "would be SKIPPED, input hash
// unchanged" is correct about this entity and silent about the fact that
// its output is being overwritten by someone else's.
function contestedVerdict(competing) {
    if (!competing.length) return null
    const parts = competing.map(c => `${c.destination} is also claimed by ${c.entities.join(', ')}`)
    return `CONTESTED — ${parts.join('; ')}. Whichever renders last wins and the other output is discarded; `
        + 'the input-hash reasoning below describes this entity only.'
}

// The verdict line names what moved when it can. That line is the one
// people read, so "the input hash differs" there is the answer stopping one
// step short of useful.
function renderVerdict(snapshots, currentHash, currentParts) {
    const moved = new Set()
    for (const snap of snapshots) {
        if (snap.inputHash === currentHash || !snap.inputParts) continue
        const d = diffInputParts(snap.inputParts, currentParts)
        for (const key of [...d.changed, ...d.added, ...d.removed]) moved.add(key)
    }
    if (!moved.size) {
        return 'would re-render — the entity\'s input hash differs from what it was last rendered at'
    }
    return `would re-render — ${[...moved].join(', ')} changed since it was last rendered`
}

export async function explain(reference) {
    const entity = await resolve(reference)
    if (!entity) {
        return {
            found: false,
            reference,
            // The likeliest reasons, in the order they actually happen.
            hint: 'Not in the catalog. Either nothing imported it (check the source plugin\'s folder and extensions), '
                + 'it was filtered as junk (see the `junk` config), or the id is spelled differently — '
                + 'try the meta.href or the id without its extension.',
        }
    }

    const snapshots = runtime.manifest?.snapshotsFor(entity.id) ?? []
    const currentHash = inputHashOf(entity)
    const currentParts = inputPartsOf(entity)
    const queryMatches = await countQueryMatches(snapshots)
    // Checked before the hash comparison in the verdict: a destination whose
    // last attempt threw will re-render regardless of what the hashes say.
    const failedSnapshots = snapshots
        .map(snap => runtime.manifest?.failureAt?.(entity.id, snap.destination))
        .filter(Boolean)
    // Same position in the verdict for the same reason: a destination whose
    // file is gone re-renders whatever the hashes say. Ranked below a failed
    // attempt — if the last render threw, that is the more useful sentence,
    // and it explains the absence too.
    const missingDestinations = snapshots
        .filter(snap => outputMissing(snap.destination))
        .map(snap => snap.destination)

    // The catalog is as of the LAST BUILD. If the file has been edited since,
    // nothing here knows it yet — the hashes would all agree and the verdict
    // would say "skipped", which is true of the catalog and misleading about
    // the next build. So check the file too, and say which is being reported.
    //
    // Compared like with like.
    //
    // Some collections store a COMPOSED checksum rather than a file hash —
    // layouts stores md5("<template>:<sidecar>:<shared>") so a sidecar edit
    // invalidates the layout. Comparing that against a fresh md5 of the
    // template is comparing two recipes: it never matches, and this reported
    // `differs: true` for every layout on every site, permanently, for files
    // nobody had touched.
    //
    // So the collection is asked how to recompute its own value. Only where
    // nothing is registered — every ordinary source — is the file hash the
    // right comparison, and there it still is.
    let source = null
    // A provider-backed entity has no local file, and asking the filesystem
    // about `https://...` returns ENOENT — which this used to report as
    // "file is gone", and the verdict then told the reader a build would
    // DELETE the entity. It would do no such thing: mikser-io-csv pulls rows
    // over http and the entity is perfectly healthy.
    //
    // Whether the remote moved is a real question, but it is not one a local
    // checksum can answer, and answering it here would put a network fetch
    // inside a read-only explain. So the comparison is declined, out loud.
    if (entity.uri && !isLocalUri(entity.uri)) {
        source = {
            uri: entity.uri,
            scheme: uriScheme(entity.uri),
            catalogChecksum: entity.checksum ?? null,
            remote: true,
            // No `differs`. Absent would read as false to anything checking
            // truthiness, so the reason it is absent is stated instead.
            notCompared: 'the source is fetched by a provider, so there is no local file to compare against',
        }
    } else if (entity.uri) {
        try {
            const onDisk = await fileChecksum(entity.uri)
            const composed = await recomputeSourceChecksum(entity)
            const comparable = composed ?? onDisk
            source = {
                uri: entity.uri,
                catalogChecksum: entity.checksum ?? null,
                fileChecksum: onDisk,
                // Reported only when it is not simply the file hash, so its
                // presence means "this collection composes" rather than noise.
                ...(composed ? { comparableChecksum: composed } : {}),
                differs: entity.checksum != null && entity.checksum !== comparable,
            }
        } catch (err) {
            source = { uri: entity.uri, error: err.code === 'ENOENT' ? 'file is gone' : err.message }
        }
    }

    return {
        found: true,
        id: entity.id,
        collection: entity.collection,
        type: entity.type,
        name: entity.name,
        // The layouts matcher records both the layout and the pattern that
        // claimed the entity; with several layouts, all of them.
        layouts: (entity.layouts ?? (entity.layout ? [entity.layout] : [])).map(l => ({
            name: l?.name ?? null,
            matchedBy: l?.matchedBy ?? entity.meta?.layoutMatch ?? null,
            format: l?.format ?? null,
            postprocessors: l?.postprocessors ?? (l?.postprocessor ? [l.postprocessor] : []),
            // The layout's OWN declared inputs — its .js sidecar, and the
            // digest covering everything the sidecar imports. Surfaced on the
            // page's report rather than only the layout's, because "does
            // editing this helper module invalidate my page" is asked about
            // the page. Not seeing it is what makes people build a workaround
            // for something already handled.
            inputs: l?.inputs ?? null,
        })),
        destination: entity.destination ?? null,
        lang: entity.meta?.lang ?? null,
        href: entity.meta?.href ?? null,
        // Why a render would or would not happen. `inputHash` is the entity's
        // current hash; each snapshot carries the hash it was rendered at, so
        // the two disagreeing IS the answer to "why did this change".
        inputHash: currentHash,
        // The components that actually went into the hash for THIS entity,
        // read off the parts rather than restated — a hardcoded label drifts
        // the moment the payload changes, and this one had.
        inputHashOf: [...new Set(Object.keys(currentParts).map(k => k.split('.')[0]))].join('+')
            || 'nothing',
        inputs: entity.inputs ?? null,
        checksum: entity.checksum ?? null,
        source,
        renders: snapshots.map(snap => ({
            destination: snap.destination,
            renderedAt: when(snap.renderedAt),
            inputHash: snap.inputHash,
            // The single most useful field: does this entity's current hash
            // match what it was last rendered at?
            stale: snap.inputHash !== currentHash,
            // The last render ATTEMPT for this destination, if it threw.
            // Without this, a destination whose render is failing reports
            // `[current]` and `would be SKIPPED` — both true of the recorded
            // state, and together the wrong answer to the only question
            // --explain is ever asked.
            failed: (() => {
                const f = runtime.manifest?.failureAt?.(entity.id, snap.destination)
                if (!f) return null
                return {
                    error: f.error,
                    since: when(f.firstFailedAt),
                    lastAttempt: when(f.lastFailedAt),
                    attempts: f.attempts ?? 1,
                }
            })(),
            // WHICH input moved, not merely that one did. This is the whole
            // question behind "why did this re-render" — answering it from
            // the recorded parts costs nothing, and not answering it sends
            // the reader to a database query for something already here.
            moved: snap.inputHash === currentHash
                ? null
                : snap.inputParts
                    ? diffInputParts(snap.inputParts, currentParts)
                    : 'unknown',
            // The file this render wrote, gone from disk.
            //
            // Same shape as `failed` above and added for the same reason: the
            // recorded state is entirely consistent — the input hash matches,
            // the snapshot is intact — so without this the report reads
            // `[current]` and `would be SKIPPED` for an entity a build now
            // re-renders. --explain contradicting the build is worse than
            // --explain being incomplete, because it is the tool someone
            // reaches for when the build has already surprised them.
            missing: outputMissing(snap.destination),
            outputHash: snap.outputHash ?? null,
            parent: snap.parent ?? null,
            // Which keys of its OWN meta the render read, and which keys it
            // read off OTHER entities.
            //
            // refClosure answers "what would re-render this". These answer
            // "what does it actually use", which is the question behind a
            // document that renders to a hole: a key the layout never touches
            // is either a typo or dead weight, and nothing else on this report
            // distinguishes them. Empty when the catalog predates the record.
            metaReads: snap.metaReads ?? [],
            consumedReads: (snap.consumedReads ?? []).map(([id, keys]) => ({ entity: id, keys })),
            refClosure: (snap.refClosure ?? []).map(entry =>
                entry.kind === 'query'
                    ? {
                        kind: 'query',
                        filter: entry.filter,
                        // An explicit integer, because a MISSING key is
                        // ambiguous to a consumer: an audit script reading
                        // absence as "unresolved" reports every query edge
                        // as dangling. `null` means the filter could not be
                        // evaluated (unserializable predicate); a number is
                        // a number.
                        ...queryCount(queryMatches, entry.filter),
                    }
                    : {
                        kind: entry.kind,
                        target: entry.target,
                        // What the name resolved to. An absent binding
                        // means a dangling edge — the most useful single
                        // fact when a page will not re-render and nothing
                        // says why.
                        bound: entry.targetIds?.length ? entry.targetIds
                            : entry.targetId ? [entry.targetId]
                            : [],
                        // `bound` is what the edge resolved to WHEN RECORDED.
                        // A target deleted since then still shows an id and a
                        // hash, which reads as healthy — so check the catalog
                        // rather than describing the record as if it were
                        // current.
                        gone: (entry.targetIds?.length ? entry.targetIds
                            : entry.targetId ? [entry.targetId]
                            : []).filter(id => !findById(id)),
                        hash: shortHash(entry.hash),
                    }),
        })),
        // What a plain build would do next, stated plainly.
        verdict: contestedVerdict(competingFor(snapshots, entity.id))
            ?? (source?.remote
            ? `source is fetched over ${source.scheme} — a build asks its provider, and no local `
              + 'file was compared here'
            : source?.error === 'file is gone'
            ? 'source file is gone — a build would DELETE this entity and unlink its output'
            : source?.differs
                ? 'source differs from the catalog — a build would re-import it first, then re-render. '
                  + '(Some plugins compose a checksum from several files, so verify before concluding.)'
                : snapshots.length === 0
            ? 'never rendered — no manifest snapshot. Either it has no layout, or its layout produced no destination.'
            : failedSnapshots.length
                ? `would re-render — the last render attempt failed and nothing has changed since `
                  + `(${failedSnapshots[0].error})`
            : snapshots.some(s => s.inputHash !== currentHash)
                ? renderVerdict(snapshots, currentHash, currentParts)
            : missingDestinations.length
                ? `would re-render — the output is gone from disk (${missingDestinations.join(', ')}). `
                  + 'The inputs are unchanged, so nothing about the entity says this; the file being '
                  + 'absent is the whole reason.'
                : 'would be SKIPPED — input hash unchanged. A dependency in refClosure changing is the only other thing that would re-render it.'),
        lookupKeys: lookupKeys(entity),
        // Other entities rendering to the same path as this one.
        //
        // The failure this makes visible: an empty stub and a real page both
        // claiming /bg/index.html. Whichever renders last wins, the other's
        // output is discarded, and nothing else says so — not the build
        // (green), not verify (each render hashes the file after writing, so
        // the loser records the winner's bytes and both snapshots agree with
        // disk), and not this report, which showed the destination and a
        // clean "would be SKIPPED".
        competingDestinations: competingFor(snapshots, entity.id),
    }
}

// Entities other than `id` whose snapshots claim the same destinations.
function competingFor(snapshots, id) {
    const mine = new Set(snapshots.map(s => s.destination).filter(Boolean))
    if (!mine.size) return []
    const all = runtime.manifest?.collisions?.() ?? []
    return all
        .filter(c => mine.has(c.destination))
        .map(c => ({ destination: c.destination, entities: c.entities.filter(e => e !== id) }))
        .filter(c => c.entities.length)
}

// Human-readable rendering. Deliberately aligned columns rather than prose:
// the point is to be scanned, and to be diffable between two runs.
export function formatExplain(report) {
    const out = []
    const row = (label, value) => out.push(`${label.padEnd(12)}${value}`)

    if (!report.found) {
        out.push(`not found   ${report.reference}`)
        out.push('')
        out.push(report.hint)
        return out.join('\n')
    }

    row('entity', `${report.id}   (${report.collection}/${report.type})`)
    if (report.href) row('href', report.href)
    if (report.lang) row('lang', report.lang)
    if (report.layouts.length) {
        for (const l of report.layouts) {
            row('layout', `${l.name ?? '(unnamed)'}${l.matchedBy ? `   (matched ${JSON.stringify(l.matchedBy)})` : ''}`
                + (l.postprocessors?.length ? `   → ${l.postprocessors.join(' → ')}` : ''))
            const li = l.inputs && Object.entries(l.inputs).filter(([, v]) => v != null)
            if (li?.length) {
                out.push(`  inputs     ${li.map(([k, v]) => `${k} ${shortHash(v)}`).join(', ')}`)
            }
        }
    } else {
        row('layout', 'none matched — this entity is not rendered')
    }
    row('destination', report.destination ?? '(none — never assigned)')
    row('inputHash', `${shortHash(report.inputHash)}  = ${report.inputHashOf}`)
    if (report.source) {
        row('source', report.source.error
            ? `${report.source.uri}   [${report.source.error}]`
            : `${report.source.uri}${report.source.differs ? '   [DIFFERS from the catalog — not yet re-imported]' : ''}`)
    }
    if (report.inputs) {
        const parts = Object.entries(report.inputs)
            .filter(([, v]) => v != null)
            .map(([k, v]) => `${k} ${shortHash(v)}`)
        if (parts.length) row('inputs', parts.join(', '))
    }

    if (!report.renders.length) {
        row('rendered', 'never')
    }
    for (const r of report.renders) {
        row('rendered', `${r.renderedAt ?? 'unknown'}   → ${r.destination}`
            + (r.failed ? '   [STALE: last render attempt failed]'
                : r.missing ? '   [MISSING: the file is not on disk]'
                : r.stale ? '   [STALE: input hash moved since]'
                : '   [current]'))
        if (r.failed) {
            out.push(`  failed     ${r.failed.lastAttempt}  ${r.failed.error}`)
            if (r.failed.attempts > 1) {
                out.push(`             ${r.failed.attempts} attempts since ${r.failed.since}`)
            }
        }
        const closure = r.refClosure
        row('refClosure', `${closure.length} edge${closure.length === 1 ? '' : 's'}`)
        for (const e of closure) {
            if (e.kind === 'query') {
                // The count is the point: a query matching nothing is the
                // dangling-reference case for the edge kind that carries most
                // of a real site's references, and it printed identically to
                // one that matched.
                const state = e.unevaluable ? '  [FILTER CANNOT BE EVALUATED]'
                    : e.matched === null ? '  (untracked predicate — any mutation invalidates)'
                    : e.matched === 0 ? '  [MATCHES NOTHING]'
                    : e.matched === 1 ? `  → ${e.sample ?? '1 entity'}`
                    : `  → ${e.matched} entities`
                out.push(`  query      ${JSON.stringify(e.filter)}${state}`)
                continue
            }
            // Show the name asked for and the entity it bound to, since
            // the two can differ (an href or a served path resolves to
            // an id) and a missing binding is itself the diagnosis.
            const bound = e.bound?.length
                ? (e.bound.length === 1 && e.bound[0] === e.target ? '' : ` → ${e.bound.join(', ')}`)
                : '  [UNRESOLVED — nothing answers to this name]'
            const gone = e.gone?.length ? '  [TARGET DELETED SINCE]' : ''
            out.push(`  ${e.kind.padEnd(10)} ${e.target}${bound}${e.hash ? `  ${e.hash}` : ''}${gone}`)
        }

        // What the render actually READ, as against what would re-render it.
        // Capped, because a large page reads a lot and a wall of keys buries
        // the rest of the report — the full list is in --json.
        const SHOWN = 12
        const shown = (keys) => keys.length > SHOWN
            ? `${keys.slice(0, SHOWN).join(', ')} … +${keys.length - SHOWN} more`
            : keys.join(', ')
        if (r.metaReads?.length) {
            row('metaReads', `${r.metaReads.length} key${r.metaReads.length === 1 ? '' : 's'} of its own meta`)
            out.push(`             ${shown(r.metaReads)}`)
        }
        for (const c of r.consumedReads ?? []) {
            row('consumed', `${c.entity}  (${c.keys.length})`)
            out.push(`             ${shown(c.keys)}`)
        }
    }

    out.push('')
    out.push(report.verdict)
    return out.join('\n')
}
