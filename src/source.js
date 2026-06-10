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
import runtime from './runtime.js'
import { ACTION } from './constants.js'
import { checksum as fileChecksum } from './utils.js'
import { findById, findEntities, checksumsByCollection } from './catalog.js'

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
export async function gateChecksum(file, id, { reload = false, priorChecksums } = {}) {
    const canGate = !reload
        && !runtime.options.force
        && !runtime.catalog?.cacheInvalidated
    if (canGate) {
        const priorChecksum = priorChecksums
            ? priorChecksums.get(id)
            : findById(id)?.checksum
        if (priorChecksum) {
            const current = await fileChecksum(file)
            if (priorChecksum === current) return null
            return current
        }
    }
    return await fileChecksum(file)
}

// Delete sweep. After a scan, walk every catalog entity in
// `collection`; for any whose id wasn't seen in the scan, emit
// DELETE. `onDelete(entity)` performs the actual `deleteEntity()`
// call plus any plugin-specific cleanup (state-map removal, etc).
// Bypassed by --force (operator wants a full rebuild; deletes still
// flow naturally on the rebuild).
export async function sweepDeleted(collection, scanned, onDelete) {
    if (runtime.options.force) return 0
    let count = 0
    for (const e of await findEntities({ collection })) {
        if (scanned.has(e.id)) continue
        await onDelete(e)
        count++
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
    const pattern = extensions.includes('*')
        ? '**/*'
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
        const scanned = new Set()
        const stats = { loaded: 0, skipped: 0, emitted: 0, deleted: 0 }
        const files = await globby(pattern, {
            cwd: absFolder,
            absolute: true,
            onlyFiles: true,
            ignore,
        })
        if (phase === 'import') trackProgress(progressLabel, files.length)
        const scanStats = { emitted: 0, skipped: 0, deleted: 0 }
        // Bulk-prefetch the catalog's existing (id → checksum) map for
        // this collection once at scan start. The gate reads from it
        // per-file instead of doing per-file SQL lookups. ~14× faster
        // at 14k entities (column projection vs full-entity JSON.parse).
        const priorChecksums = checksumsByCollection(collection)
        for (const file of files) {
            await registerFile(file, { logger, scanned, stats: scanStats, priorChecksums })
            if (phase === 'import') updateProgress()
        }

        scanStats.deleted = await sweepDeleted(collection, scanned, async (e) => {
            await deleteEntity({ id: e.id, type, collection })
            logger.debug('%s removed (file gone): %s', collection, e.name)
        })

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

        const chksum = await gateChecksum(file, id, { reload, priorChecksums })
        if (chksum === null) {
            if (stats) stats.skipped++
            return
        }

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
            try {
                base.content = await readFile(file, 'utf8')
            } catch (err) {
                logger.warn('%s read failed for %s: %s', collection, name, err.message)
                return
            }
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
