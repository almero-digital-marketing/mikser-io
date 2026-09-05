// End-of-cycle checks that read what was WRITTEN rather than what was
// recorded: broken and over-deep references in the emitted output, and asset
// URLs a template asked for that nothing produced.

import path from 'node:path'
import render from '../render.js'
import runtime from '../runtime.js'
import { checkReferences } from '../references.js'
import { assetUse } from '../report.js'
import { siteRootFor } from '../utils.js'
import { existsSync } from 'fs'

// Warn for anything the EMITTED output points at that is not there.
//
// Complements the helper-call check below rather than repeating it: this reads
// what shipped, so it also sees paths written by hand, and it resolves them the
// way a browser does, which is the only way to see a url that works solely
// because a `..` run was floored at the site root.
//
// A floored url is not broken today. It is the same markup one level deeper
// away from being broken, and it means the emitted depth does not match the
// page — so it is reported separately rather than folded in with the failures.
//
// Warn, never fail: a missing asset must not stop a dev server. Both lists
// carry stable codes into `--json` so a deploy script can decide for itself.
// Returns the set of broken targets so the helper-call check can skip them.
export async function reportBrokenReferences(logger) {
    const outputFolder = runtime.options.outputFolder
    if (!outputFolder || !existsSync(outputFolder)) return new Set()

    const siteRoots = runtime.config?.siteRoots ?? []
    const { broken, overDeep, checked } = await checkReferences(outputFolder, { siteRoots })
    if (!checked) return new Set()

    const SHOWN = 10
    const named = (files) =>
        files.slice(0, 3).join(', ') + (files.length > 3 ? ` and ${files.length - 3} more` : '')

    // Ask the assets plugin before guessing.
    //
    // A derivative that was never produced has its SOURCE sitting in the
    // output — files() copies it there — so the same-name search finds it and
    // "the file is at media/icons/logo.svg" reads as a base that is off by a
    // folder. It is not: the base is right and the derivative does not exist,
    // because the preset does not cover that file. Confidently naming the
    // wrong cause is worse than naming none, so a real answer wins over the
    // heuristic wherever there is one.
    const explain = runtime.engine?.assets?.explainMissing
    const reasons = new Map()
    if (explain) {
        // Every broken entry, not the ones that happen to sort first. The cap
        // below is about how much gets PRINTED; asking only within it made the
        // answer depend on the position of the entry that had one, so a site
        // with ten unrelated broken urls reported "No derivative produced: 0"
        // while holding the cause of the eleventh. Cheap to ask: anything not
        // under the assets folder is rejected on the first path segment, and
        // the catalog index behind it is built once and only if something gets
        // past that.
        for (const { target } of broken) {
            // Site-relative, because that is what the assets folder is named
            // relative to. A build that deploys out/<lang> as its own domain
            // root resolves this target to `a/derived/web/...`, and a plain
            // prefix test on the assets folder sees `a` and gives up — the
            // check goes quiet on exactly the multi-site builds where a
            // derivative is shared into each root.
            const root = siteRootFor(target, siteRoots)
            const local = root ? target.slice(root.length).replace(/^\/+/, '') : target
            try { reasons.set(target, await explain(local)) } catch { /* never break the report */ }
        }
    }

    // A stated cause outranks a guess in what gets printed, not only in how it
    // is worded. The cap exists so one broken preset cannot bury the rest of
    // the build — it must not bury the answer instead.
    const ordered = reasons.size
        ? [...broken].sort((a, b) => (reasons.get(b.target) ? 1 : 0) - (reasons.get(a.target) ? 1 : 0))
        : broken

    for (const { url, target, files, elsewhere } of ordered.slice(0, SHOWN)) {
        const reason = reasons.get(target)
        // Two different problems wear the same symptom. A target whose file
        // exists elsewhere in the output is a base that is wrong, not an asset
        // that is missing — and saying which one saves the reader the search.
        if (reason) {
            logger.warn({ code: 'reference-no-derivative', url, target, files, reason },
                'No derivative was produced: %s (from %s) — %s',
                url, named(files), reason)
        } else if (elsewhere?.length) {
            logger.warn({ code: 'reference-wrong-base', url, target, files, elsewhere },
                'Points at the wrong place: %s (from %s) — nothing at %s, but the file is at %s',
                url, named(files), target, elsewhere.join(', '))
        } else {
            logger.warn({ code: 'reference-broken', url, target, files },
                'Resolves to nothing, and nothing produced it: %s (from %s) — %s',
                url, named(files), target)
        }
    }
    if (broken.length) {
        const explained = broken.filter(b => reasons.get(b.target)).length
        const misplaced = broken.filter(b => b.elsewhere?.length && !reasons.get(b.target)).length
        logger.warn({
            code: 'reference-broken-summary',
            broken: broken.length, wrongBase: misplaced, noDerivative: explained, checked,
        },
            '%d of %d reference(s) in the output resolve to nothing%s. No derivative produced: %d. '
            + 'Wrong base (the file exists elsewhere): %d. Never produced: %d. A URL helper builds the '
            + 'path rather than looking it up, so none of them can fail at the point it is written.',
            broken.length, checked, broken.length > SHOWN ? `, ${SHOWN} shown` : '',
            explained, misplaced, broken.length - misplaced - explained)
    }

    // Grouped by how FAR each climbed, because a site whose every over-deep url
    // climbs the same distance does not have N problems — it has one base that
    // is off by a constant. Printing it N times is precisely how a real signal
    // gets filtered out, which is the failure this check exists to prevent.
    const byClimb = new Map()
    for (const entry of overDeep) {
        if (!byClimb.has(entry.floored)) byClimb.set(entry.floored, [])
        byClimb.get(entry.floored).push(entry)
    }
    // One distance, many urls: structural. The helper's base is wrong, the urls
    // are not — they load at every depth, because the climb is always floored.
    // That wants a different reaction than a hand-written `../..` that happens
    // to be right on one page and is a 404 waiting on the next.
    const structural = byClimb.size === 1 && overDeep.length > 1

    for (const [climb, entries] of [...byClimb].sort(([a], [b]) => a - b)) {
        const examples = entries.slice(0, 3).map(e => e.url)
        logger.warn(
            {
                code: 'reference-over-deep', climbs: climb, count: entries.length,
                structural, urls: examples,
                files: [...new Set(entries.flatMap(e => e.files))].slice(0, 3),
            },
            structural
                ? '%d references climb %d level(s) above the site root — every one of them, by the '
                  + 'same amount. They load: a browser discards the extra `..`. What is wrong is the '
                  + 'base they were built from, not the links. Examples: %s'
                : '%d reference(s) climb %d level(s) above the site root and load only because a '
                  + 'browser discards the extra `..`. Each breaks if the same markup renders one '
                  + 'level deeper. Examples: %s',
            entries.length, climb, examples.join(', '))
    }

    if (overDeep.length) {
        logger.warn({ code: 'reference-over-deep-summary', overDeep: overDeep.length, checked, structural },
            '%d of %d reference(s) resolve above the site root.%s',
            overDeep.length, checked,
            siteRoots.length ? '' : ' No siteRoots are declared, so this resolved against the output '
                + 'root — declare siteRoots if a subtree is deployed as its own domain.')
    }

    return new Set(broken.map(b => b.target))
}

// Warn for anything a render linked to that is not in the output.
//
// Deliberately phrased as what was OBSERVED. Only entities that rendered this
// cycle recorded anything, so an incremental build checks the pages it built
// and says nothing about the rest — the same reasoning the assets plugin
// already applies to its preset warning, and for the same reason: a warning
// that overclaims gets filtered, and the filtered-out line is the real one.
export async function reportMissingAssets(logger, alreadyReported = new Set()) {
    const used = assetUse()
    if (!used.length) return
    const outputFolder = runtime.options.outputFolder
    if (!outputFolder) return

    const missing = []
    for (const [destination, ids] of used) {
        const file = path.join(outputFolder, destination.replace(/^\//, ''))
        // The output scan resolves the same file the way a browser does and
        // names the pages that link it, which is strictly more useful. Where
        // both would fire, one warning is enough.
        if (alreadyReported.has(destination.replace(/^\//, ''))) continue
        if (!existsSync(file)) missing.push([destination, ids])
    }
    if (!missing.length) return

    // Capped, with the total alongside. One broken preset can be referenced by
    // every page on the site, and a thousand lines of it buries whatever else
    // the build said.
    const SHOWN = 10
    const explain = runtime.engine?.assets?.explainMissing
    for (const [destination, ids] of missing.slice(0, SHOWN)) {
        // Same question, same answer, wherever the symptom surfaces. This path
        // sees urls that never reach an html file at all — a sitemap, a feed —
        // which the output scan cannot look at.
        let reason = null
        if (explain) {
            try { reason = await explain(destination) } catch { /* never break the report */ }
        }
        logger.warn({ code: 'asset-missing', destination, referencedBy: ids, reason },
            'Linked but not in the output: %s — referenced by %s%s', destination,
            ids.slice(0, 3).join(', ') + (ids.length > 3 ? ` and ${ids.length - 3} more` : ''),
            reason ? `. ${reason[0].toUpperCase()}${reason.slice(1)}` : '')
    }
    logger.warn({ code: 'asset-missing-summary', missing: missing.length, checked: used.length },
        '%d of %d linked file(s) are not in the output%s. A URL helper builds the path rather than looking it '
        + 'up, so this is a link to something nothing produced — usually a preset that did not run, or a '
        + 'template naming an extension the preset no longer emits.',
        missing.length, used.length,
        missing.length > SHOWN ? `, ${SHOWN} shown` : '')
}

// The report-only commands, as functions that RETURN their exit code.
//
// They used to be inline here and call process.exit, which is fine for a
// process whose only job is to answer one question and stop. It is not fine
// for the instance that has to answer the same question on behalf of a client
// and stay alive — and answering it there is the point, because a local run
// reads a catalogue another process is in the middle of writing.
//
// `request` carries the CLIENT's arguments. Reading runtime.options here would
// answer with the instance's own flags, which are whatever it happened to be
// started with.
// Bytes at a size a person reads. Not in the document — that carries the
// integer, because a caller comparing two builds subtracts.
export function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`
    const units = ['kB', 'MB', 'GB']
    let value = bytes / 1024
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
    return `${value.toFixed(1)} ${units[unit]}`
}
