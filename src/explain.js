// `--explain <entity-id>` — what happened to one entity, and why.
//
// Assembly, not new machinery: every line comes from state the engine already
// keeps (catalog, manifest snapshots, inputHashOf, the layouts matcher's
// output). It exists because the question asked most often about a build is
// "why did this NOT change?", and until now the only way to answer it was to
// read plugin source and hand-query runtime/mikser.sqlite — which works, and
// needs knowledge a user of the tool should not need.
//
// Follows --verify's shape: report and exit, no build phases run.
import { inputHashOf, lookupKeys, checksum as fileChecksum } from './utils.js'
import { findEntity } from './catalog.js'
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

    // The catalog is as of the LAST BUILD. If the file has been edited since,
    // nothing here knows it yet — the hashes would all agree and the verdict
    // would say "skipped", which is true of the catalog and misleading about
    // the next build. So check the file too, and say which is being reported.
    //
    // A caveat rather than a bug: some plugins compose a checksum from more
    // than one file (layouts folds in its .js sidecar), so a difference does
    // not always mean the entity's own source moved. Both values are reported
    // and the wording avoids claiming more than is known.
    let source = null
    if (entity.uri) {
        try {
            const onDisk = await fileChecksum(entity.uri)
            source = {
                uri: entity.uri,
                catalogChecksum: entity.checksum ?? null,
                fileChecksum: onDisk,
                differs: entity.checksum != null && entity.checksum !== onDisk,
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
        inputHashOf: entity.checksum && entity.meta == null && entity.content == null
            ? 'checksum'
            : 'meta+content+inputs',
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
            outputHash: snap.outputHash ?? null,
            parent: snap.parent ?? null,
            refClosure: (snap.refClosure ?? []).map(entry =>
                entry.kind === 'query'
                    ? { kind: 'query', filter: entry.filter }
                    : { kind: entry.kind, target: entry.target, hash: shortHash(entry.hash) }),
        })),
        // What a plain build would do next, stated plainly.
        verdict: source?.error === 'file is gone'
            ? 'source file is gone — a build would DELETE this entity and unlink its output'
            : source?.differs
                ? 'source differs from the catalog — a build would re-import it first, then re-render. '
                  + '(Some plugins compose a checksum from several files, so verify before concluding.)'
                : snapshots.length === 0
            ? 'never rendered — no manifest snapshot. Either it has no layout, or its layout produced no destination.'
            : snapshots.some(s => s.inputHash !== currentHash)
                ? 'would re-render — the entity\'s input hash differs from what it was last rendered at'
                : 'would be SKIPPED — input hash unchanged. A dependency in refClosure changing is the only other thing that would re-render it.',
        lookupKeys: lookupKeys(entity),
    }
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
            + (r.stale ? '   [STALE: input hash moved since]' : '   [current]'))
        const closure = r.refClosure
        row('refClosure', `${closure.length} edge${closure.length === 1 ? '' : 's'}`)
        for (const e of closure) {
            out.push(e.kind === 'query'
                ? `  query      ${JSON.stringify(e.filter)}`
                : `  ${e.kind.padEnd(10)} ${e.target}${e.hash ? `  ${e.hash}` : ''}`)
        }
    }

    out.push('')
    out.push(report.verdict)
    return out.join('\n')
}
