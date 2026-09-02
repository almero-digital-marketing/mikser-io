// useSource — codifies the "folder of files becomes entities" pattern
// that documents, layouts, schemas, files, resources, and assets all
// implement variations of.
//
// Usage from a plugin factory:
//
//   export default (core) => {
//       useSource(core, {
//           collection: 'schemas',
//           type:       'schema',
//           folder:     'schemas',
//           extensions: ['js', 'mjs', 'cjs'],
//           load: async ({ file, name, entity }) => ({ meta: { ... } }),
//       })
//   }
//
// Takes the plugin factory's `core` context as first argument so it
// uses the same hook-registration functions the plugin would —
// production goes through src/lifecycle.js, test harnesses substitute
// them with recorders.
//
// Responsibilities the helper handles:
//   - Resolve `folder` relative to runtime.options.workingFolder
//   - mkdir the folder if missing
//   - Stash the absolute path at runtime.options.<collection>Folder
//   - Glob-scan for matching files in the chosen lifecycle phase
//   - Build the base entity (id, name, format, uri, stamp) for each
//   - Optionally read file content (`content: true`)
//   - Call your load() to merge in domain-specific fields
//   - createEntity / updateEntity / deleteEntity through `core`
//   - Wire chokidar via watch() in watch mode
//   - Hot-reload on file change via onSync (CREATE/UPDATE/DELETE)
//
// What you do NOT handle in your plugin:
//   - Hook ordering
//   - Folder path resolution / mkdir
//   - The journal/catalog interaction
//   - chokidar wiring
//   - DELETE on file unlink
import path from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { globby } from 'globby'
import pMap from 'p-map'
import runtime from './runtime.js'
import { ACTION } from './constants.js'
import { checksum as fileChecksum, checksumOf, junkIgnore } from './utils.js'
import { reportGated, reportChanged } from './report.js'
import { findById, findEntities, checksumsByCollection } from './catalog.js'
import { useDatabase } from './database/index.js'

// Per-source-scan registerFile concurrency. The work is dominated by
// file reads + MD5 checksums (I/O-bound); per-file CPU is negligible.
// 16 keeps the per-process file-descriptor count well below the
// default ulimit (256 on macOS) while saturating the I/O lane on
// typical SSDs. At 14k corpus the sequential register loop is ~1-2s;
// parallel cuts that to ~150ms. At 1M it's the difference between
// ~150s and ~10s.
const SCAN_CONCURRENCY = 16

// Three building blocks shared by useSource and the layouts plugin's
// custom scan. Extracted so the gate + sweep + summary mechanics live
// in one place — adding a third scanning consumer in the future is a
// matter of calling the same three helpers, not re-implementing them.

// Per-file checksum gate. Returns the file's checksum so the caller
// can stash it on the emitted entity. Returns `null` when the catalog
// already has this entity at the same checksum and the caller should
// skip emitting it. Bypassed by reload events (chokidar fires
// because the file actually changed), --force, and cache
// invalidation (engine version differs; plugin chain may have evolved).
//
// `priorChecksums` is the optional bulk-prefetch map produced by
// `checksumsByCollection(collection)` and shared by every gate call
// within one scan. When present, the gate hits the map (O(1) read,
// no SQL) instead of per-file findById. The single-file chokidar
// event handler (no scan context) doesn't pass it and falls back to
// findById, which is fine for low-frequency one-off mutations.
// `bytes`, when given, is content the caller has ALREADY read: the checksum
// is derived from those exact bytes rather than from a second, independent
// read. That is the whole point — two reads of a file being written can
// disagree, and the losing combination (empty content + a checksum correct
// for the finished file) is permanent, because every later sync then
// short-circuits on "unchanged".
export async function gateChecksum(file, id, { reload = false, priorChecksums, bytes } = {}) {
    const compute = () => (bytes !== undefined ? checksumOf(bytes) : fileChecksum(file))
    const canGate = !reload
        && !runtime.options.force
        && !runtime.catalog?.cacheInvalidated
    if (canGate) {
        const priorChecksum = priorChecksums
            ? priorChecksums.get(id)
            : findById(id)?.checksum
        if (priorChecksum) {
            const current = await compute()
            if (priorChecksum === current) return null
            return current
        }
    }
    return await compute()
}

// Delete sweep. After a scan, find every catalog entity in `collection`
// AND owned by this source (uri rooted at `ownerPrefix`) whose id wasn't
// seen by the scan and emit DELETE via the caller's `onDelete(entity)`
// hook (which performs the actual deleteEntity() call plus any plugin-
// specific cleanup — state-map removal, etc).
// Bypassed by --force (operator wants a full rebuild; deletes still
// flow naturally on the rebuild).
//
// `ownerPrefix` (required) is the absolute folder the calling source
// owns — typically `absFolder` for documents/files/assets, or
// `layoutsFolder` for layouts. Sweep only considers entities whose
// `entity.uri` is rooted there, so foreign entities co-existing in
// the same collection (CSV-emitted documents-collection rows with
// `uri` empty, gdrive-sourced docs with `uri = 'gdrive://...'`,
// API-injected entities, etc.) are invisible to this sweep and stay
// in the catalog. Without this scope, every non-file emitter in a
// shared collection gets silently wiped on every cycle by whichever
// file source ran last — a class-of-bugs landmine.
//
// Set difference runs in SQL. The scanned ids land in a session-scoped
// TEMP table, then a LEFT JOIN against mikser_entities returns just the
// "in catalog, not in scanned, owned by us" rows. Memory is bounded by
// the *delete set* (typically 0-10 per cycle) rather than the corpus —
// at 1M docs the prior `for (const e of await findEntities({collection}))`
// walk allocated ~7GB; this allocates a few KB.
//
// Setup cost is one INSERT per scanned id (~2μs prepared-and-batched).
// At 1M scanned files that's ~2s of sweep overhead — comparable to the
// LRU population the scan already does, and we get rid of the 7GB JS
// heap peak in return.
export async function sweepDeleted(collection, scanned, onDelete, ownerPrefix) {
    // --force does NOT skip this any more.
    //
    // It used to, on a stated premise — "operator wants a full rebuild;
    // deletes still flow naturally on the rebuild" — that is not true and can
    // be disproved in one command: delete a document, run `mikser --force`,
    // and both the entity and its output are still there, while an ordinary
    // build removes them. Nothing about --force wipes the catalog (that is
    // --clear, via forceWipe), so a row for a file that no longer exists
    // simply survives.
    //
    // Which made --force the one flag that could not fix what it is reached
    // for. It defeats the checksum GATE; the scanned set is built from the
    // glob before any gate runs, so it is exactly as complete under --force as
    // without it, and the sweep is no less accurate for running.
    if (!ownerPrefix) {
        throw new Error(
            'sweepDeleted: ownerPrefix is required — pass the absolute folder ' +
            'this source owns so the sweep can stay scoped to entities whose ' +
            'uri is rooted there. Without it, every co-collection emitter ' +
            '(CSV, gdrive, API, …) gets silently wiped on every cycle.'
        )
    }
    const ownerLike = ownerPrefix.endsWith('/') ? ownerPrefix : ownerPrefix + '/'
    const db = useDatabase()
    if (!db?.isOpen) {
        // Fallback for test paths that drive sweepDeleted without the
        // database substrate up — operate against the JS catalog stub
        // the unit-test plugin harness installs.
        let count = 0
        for (const e of await findEntities({ collection })) {
            if (scanned.has(e.id)) continue
            if (!e.uri || !String(e.uri).startsWith(ownerLike)) continue
            await onDelete(e)
            count++
        }
        return count
    }

    // Per-process TEMP table — created lazily on first sweep, reused
    // across collections + cycles. DELETE wipes the prior cycle's rows
    // before we re-populate from the current scanned set.
    db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS sweep_scanned_ids (id TEXT PRIMARY KEY);
        DELETE FROM sweep_scanned_ids;
    `)
    db.transaction(() => {
        const stmt = db.prepare('INSERT INTO sweep_scanned_ids (id) VALUES (?)')
        for (const id of scanned) stmt.run(id)
    })

    // Set difference in SQL — returns only the rows in mikser_entities
    // whose id has no match in sweep_scanned_ids AND whose uri is rooted
    // at ownerPrefix. Foreign-emitter entities (uri NULL/empty, foreign
    // scheme, or rooted elsewhere) are excluded by the LIKE clause.
    const deletedIds = db.prepare(`
        SELECT e.id
        FROM mikser_entities e
        LEFT JOIN sweep_scanned_ids s ON s.id = e.id
        WHERE e.collection = ?
          AND s.id IS NULL
          AND e.uri IS NOT NULL
          AND e.uri != ''
          AND e.uri LIKE ? || '%'
    `).all(collection, ownerLike).map(r => r.id)

    let count = 0
    for (const id of deletedIds) {
        const entity = findById(id)
        if (entity) {
            await onDelete(entity)
            count++
        }
    }
    return count
}

// Summary log line shape — same across all scanning consumers so
// log greppers and integration tests can match on a single pattern.
// `cap` is the capitalised collection name ("Documents", "Layouts").
export function scanSummary({ cap, loaded, emitted = 0, skipped = 0, deleted = 0 }) {
    const parts = [
        `${cap} loaded: ${loaded}`,
        emitted ? `${emitted} emitted`         : null,
        skipped ? `${skipped} unchanged`       : null,
        deleted ? `${deleted} removed`         : null,
        runtime.options.force ? '--force' : null,
        runtime.catalog?.cacheInvalidated ? 'cache-invalidated' : null,
    ].filter(Boolean)
    return parts.join(', ')
}

/**
 * @param {Object} options
 * @param {string} options.collection      catalog collection name (e.g. 'schemas')
 * @param {string} options.type            entity type field
 * @param {string} options.folder          folder name relative to workingFolder
 * @param {string[]} [options.extensions]  file extensions to scan (default ['*'])
 * @param {string[]} [options.ignore]      globby ignore patterns (default [])
 * @param {'loaded'|'import'} [options.phase]  lifecycle phase to scan in;
 *                                          'loaded' (default) for metadata
 *                                          sources, 'import' for content
 *                                          sources that play in the import
 *                                          progress bar
 * @param {boolean} [options.content]      read each file's content into
 *                                          entity.content (default false)
 * @param {string} [options.progress]      progress-tracker label (default
 *                                          derived from collection name)
 * @param {string} [options.idPrefix]      override id prefix (default '/<collection>')
 * @param {(args: {
 *     file: string, name: string, relativePath: string, entity: Object
 * }) => Promise<Object|null>|Object|null} [options.load]
 *     called per file; returned object is merged onto the base entity.
 *     Return null to skip a file.
 */
export function useSource(core, options) {
    const {
        runtime,
        useLogger,
        onLoaded,
        onImport,
        onSync,
        createEntity,
        updateEntity,
        deleteEntity,
        watch,
        trackProgress,
        updateProgress,
    } = core
    const {
        collection,
        type,
        folder,
        extensions = ['*'],
        ignore = [],
        phase = 'loaded',
        content = false,
        progress,
        load = async () => ({}),
        idPrefix,
        // Most content collections keep the extension in `id` (so
        // `/documents/post.md`) but strip it from `name` (`post`).
        // Code-shaped sources (schemas, layouts) typically strip the
        // extension from `id` too. Default = documents style.
        stripExtensionFromId = false,
    } = options

    if (!collection) throw new Error('useSource: collection is required')
    if (!type) throw new Error('useSource: type is required')
    if (!folder) throw new Error('useSource: folder is required')

    let absFolder
    const prefix = idPrefix ?? `/${collection}`
    const cap = collection.replace(/^./, c => c.toUpperCase())
    const progressLabel = progress ?? `${cap} import`
    // A SINGLE extension must not go through brace syntax: `**/*.{css}`
    // matches NOTHING in minimatch/globby — a one-element brace is not
    // expanded — so a source declaring one extension silently imported zero
    // files and reported "Styles loaded: 0" as though the folder were empty.
    // Same shape as the other silent-declaration failures: green build,
    // nothing there.
    const pattern = extensions.includes('*')
        ? '**/*'
        : extensions.length === 1
            ? `**/*.${extensions[0]}`
            : `**/*.{${extensions.join(',')}}`

    // Hot-reload — chokidar dispatches into onSync(collection) when
    // a file inside the folder changes.
    onSync(collection, async ({ action, context }) => {
        const logger = useLogger()
        if (!context?.relativePath) return false

        // DELETE doesn't need to touch the file — we identify the
        // entity by id derived from the path alone. Allows onSync
        // DELETE to work even if onLoaded never set absFolder
        // (which matters for unit tests and edge cases).
        if (action === ACTION.DELETE) {
            const name = nameFromRelativePath(context.relativePath)
            const id = stripExtensionFromId
                ? `${prefix}/${name}`
                : `${prefix}/${context.relativePath.replace(/\\/g, '/')}`
            try {
                await deleteEntity({ id, type, collection })
                logger.debug('%s removed: %s', collection, name)
            } catch (err) {
                logger.warn('%s remove failed for %s: %s', collection, name, err.message)
            }
            return true
        }

        // CREATE / UPDATE need absFolder + the file content.
        const folderAbs = absFolder ?? runtime.options[`${collection}Folder`]
        const file = path.join(folderAbs, context.relativePath)
        await registerFile(file, { logger, action })
        return true
    })

    // Setup runs in onLoaded — folder resolution, mkdir, chokidar
    // wiring. The actual file scan happens later in `phase` (below).
    onLoaded(async () => {
        const logger = useLogger()

        // Plugin factories run during the onLoad phase, so by the time
        // useSource is called the onInitialize / onInitialized phases
        // have already passed. We do folder resolution here — by which
        // point engine has set workingFolder and journal + catalog
        // have initialized.
        absFolder = path.isAbsolute(folder)
            ? folder
            : path.join(runtime.options.workingFolder, folder)
        runtime.options[`${collection}Folder`] = absFolder
        // The authoritative set of folders whose files become entities.
        //
        // `<collection>Folder` above is the per-collection accessor and reads
        // like one; this is the LIST, which is a different question and the
        // one anything asking "could a file here be tracked?" needs. Deriving
        // it by scanning options for a `*Folder` suffix would sweep up
        // workingFolder, runtimeFolder and outputFolder, and hand-listing the
        // content ones misses every collection a project registers itself —
        // which is exactly how the file helpers came to warn 63 times a build
        // about files they were tracking correctly.
        runtime.options.sourceFolders ??= {}
        runtime.options.sourceFolders[collection] = absFolder
        logger.debug('%s folder: %s', cap, absFolder)

        await mkdir(absFolder, { recursive: true })
        watch(collection, absFolder)
    })

    // Scan + register. 'loaded' for metadata sources (runs right after
    // the setup hook above, in the same hook chain). 'import' for
    // content sources, so they show up under the import progress bar
    // with the other content collections.
    //
    // The scan also handles two cache concerns:
    //   - Checksum gate: if the catalog already has this entity with
    //     the same file checksum, skip emitting a CREATE — the journal
    //     stays accurate (mutations = actual changes) and the
    //     downstream plugin chain (front-matter, yaml, layouts, refs)
    //     does no per-entity work for unchanged files.
    //   - Delete sweep: any catalog entity for this collection whose
    //     file is no longer on disk gets a DELETE — catches deletions
    //     that happened while mikser was off (chokidar's 'unlink'
    //     covers watch-mode, this covers the gap).
    //
    // Both are bypassed by --force. The gate is also bypassed when
    // catalog.cacheInvalidated is set (engine version changed; plugin
    // chain may have evolved).
    const scanHook = phase === 'import' ? onImport : onLoaded
    scanHook(async () => {
        if (!absFolder) return // setup didn't run (shouldn't happen)
        const logger = useLogger()
        // --resume: the journal has unfinished entries from a prior run
        // and we're picking up where it died. Skip the filesystem scan
        // entirely — re-globbing 1M paths is the single biggest startup
        // cost at scale, and any disk changes during downtime are
        // explicitly out of scope for resume (use a plain restart to
        // catch them). Watcher wiring already happened in the setup
        // hook, so post-resume changes still flow through chokidar.
        if (runtime.options.resume) {
            logger.info('%s scan skipped (--resume)', cap)
            return
        }
        const scanned = new Set()
        const stats = { loaded: 0, skipped: 0, emitted: 0, deleted: 0 }
        const files = await globby(pattern, {
            cwd: absFolder,
            absolute: true,
            onlyFiles: true,
            // OS and file-manager litter first, so a plugin's own `ignore`
            // adds to it rather than having to restate it. globby's
            // dot: false default already hid the macOS ones; Thumbs.db and
            // desktop.ini are not dotfiles and were being scanned.
            ignore: [...junkIgnore(), ...ignore],
        })
        if (phase === 'import') trackProgress(progressLabel, files.length)
        const scanStats = { emitted: 0, skipped: 0, deleted: 0 }
        // Bulk-prefetch the catalog's existing (id → checksum) map for
        // this collection once at scan start. The gate reads from it
        // per-file instead of doing per-file SQL lookups. ~14× faster
        // at 14k entities (column projection vs full-entity JSON.parse).
        const priorChecksums = checksumsByCollection(collection)
        // Parallel register — file read + checksum is I/O-bound. Set
        // additions, scanStats increments, and journal addEntry calls
        // are all single-threaded-JS-atomic so no locking required;
        // better-sqlite3 serializes concurrent INSERTs at the writer
        // and INSERTs are ~10μs vs ~ms-per-file-read, so the journal
        // is never the bottleneck.
        await pMap(files, async (file) => {
            await registerFile(file, { logger, scanned, stats: scanStats, priorChecksums })
            if (phase === 'import') updateProgress()
        }, { concurrency: SCAN_CONCURRENCY })

        scanStats.deleted = await sweepDeleted(collection, scanned, async (e) => {
            // Pass the full entity (e is hydrated from catalog by
            // sweepDeleted) so the manifest's query-affected dispatch
            // can sift-match aggregate-layout filters against the
            // actual fields (format, meta.layout, etc.). Minimal
            // {id,type,collection} would miss those filters.
            await deleteEntity(e)
            logger.debug('%s removed (file gone): %s', collection, e.name)
        }, absFolder)
        // ownerPrefix: absFolder. The sweep stays inside this source's
        // own filesystem root, so foreign-emitter entities in the same
        // collection (CSV rows, gdrive docs, API-injected entries) are
        // left alone instead of getting cross-trashed every cycle.

        logger.info(scanSummary({ cap, loaded: files.length, ...scanStats }))
    })

    async function registerFile(file, { logger, action = ACTION.CREATE, scanned, priorChecksums } = {}) {
        // stats — when called from the scanHook the outer scan provides
        // a Map to accumulate counts. For onSync (chokidar single-file
        // events) the counter is absent and per-file tally is not
        // meaningful.
        const stats = arguments[1]?.stats
        const reload = action !== ACTION.CREATE
        const relativePath = path.relative(absFolder, file)
        const name = nameFromRelativePath(relativePath)
        const id = stripExtensionFromId
            ? `${prefix}/${name}`
            : `${prefix}/${relativePath.replace(/\\/g, '/')}`
        scanned?.add(id)

        // When this source stores content, read the file ONCE and let both
        // the checksum and the stored body come from the same bytes. The
        // previous shape hashed the file in gateChecksum and then read it
        // again below — two reads, and a torn write between them persisted
        // an empty body next to a valid checksum, permanently.
        //
        // No extra cost: the gate already read the whole file to hash it.
        // Only for `content` sources; large media goes through files.js,
        // which stores no body and must not be slurped into memory.
        let bytes
        if (content) {
            try {
                bytes = await readFile(file)
            } catch (err) {
                logger.warn('%s read failed for %s: %s', collection, name, err.message)
                return
            }
        }

        const chksum = await gateChecksum(file, id, { reload, priorChecksums, bytes })
        if (chksum === null) {
            if (stats) stats.skipped++
            // Never becomes a render task, so it would otherwise be invisible
            // in the --json report. Counted, not listed.
            reportGated()
            return
        }
        // Past the gate means the bytes are new or different — the complement
        // of reportGated, so between them every file looked at is accounted
        // for and "why did this build do anything" has an answer.
        reportChanged(id)

        const base = {
            id,
            name,
            collection,
            type,
            format: path.extname(file).slice(1),
            uri: file,
            stamp: Date.now(),
            checksum: chksum,
        }
        if (content) {
            // Decoded from the bytes the checksum was taken over — not
            // re-read. See the gate above.
            base.content = bytes.toString('utf8')
        }
        try {
            const extra = await load({ file, name, relativePath, entity: base })
            if (extra === null) {
                logger.trace('%s skipped (load returned null): %s', collection, name)
                return
            }
            const entity = mergeEntity(base, extra)
            // Pick CREATE vs UPDATE based on the action — initial scans
            // and file-add events go through createEntity; reloads go
            // through updateEntity. The catalog upserts in both
            // directions, so the choice is mainly semantic.
            const write = action === ACTION.UPDATE ? updateEntity : createEntity
            await write(entity)
            if (stats) stats.emitted++
            if (phase !== 'import' || reload) {
                logger.debug('%s %s: %s', cap, reload ? 'reloaded' : 'loaded', name)
            }
        } catch (err) {
            logger.error('%s load failed for %s: %s', collection, name, err.message)
        }
    }
}

function nameFromRelativePath(relativePath) {
    const ext = path.extname(relativePath)
    return relativePath.slice(0, relativePath.length - ext.length).replace(/\\/g, '/')
}

// Deep-merge entity additions onto the base. Plain-object values are
// merged; arrays and primitives are replaced. Good enough for the
// common "set meta + maybe override format/uri" pattern.
function mergeEntity(base, extra) {
    const out = { ...base }
    for (const [k, v] of Object.entries(extra ?? {})) {
        if (
            v && typeof v === 'object' && !Array.isArray(v)
            && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
        ) {
            out[k] = { ...base[k], ...v }
        } else {
            out[k] = v
        }
    }
    return out
}
