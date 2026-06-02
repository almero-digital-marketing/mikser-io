// useSource — codifies the "folder of files becomes entities" pattern
// that documents, layouts, schemas, files, resources, and assets all
// implement variations of.
//
// Usage from a plugin factory:
//
//   useSource({
//       collection: 'schemas',
//       type:       'schema',
//       folder:     'schemas',                  // relative to workingFolder
//       extensions: ['js', 'mjs', 'cjs'],       // default ['js']
//       load: async ({ file, name, entity }) => {
//           // return entity fields to merge in; throw or return null
//           // to skip this file. The base entity (id, name, collection,
//           // type, format, uri, stamp) is populated for you.
//           const mod = await import(pathToFileURL(file))
//           return { meta: { description: mod.default.description } }
//       },
//   })
//
// Responsibilities the helper handles:
//   - Resolve `folder` relative to runtime.options.workingFolder
//   - Glob-scan for matching files in onLoaded
//   - Build the base entity (id, name, format, uri, stamp) for each
//   - Call your load() to merge in domain-specific fields
//   - runtime.update each entity into the catalog (upsert semantics)
//   - Hot-reload on file change via the runtime watcher (onSync)
//
// What you do NOT handle in your plugin:
//   - Hook ordering
//   - createEntity vs updateEntity
//   - Folder path resolution
//   - The journal/catalog interaction
//   - chokidar wiring
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { globby } from 'globby'
import runtime from './runtime.js'
import { useLogger } from './engine.js'
import { onLoaded, onSync } from './lifecycle.js'
import { findEntity } from './catalog.js'
import { OPERATION, ACTION } from './constants.js'

export function useSource(options) {
    const {
        collection,
        type,
        folder,
        extensions = ['js'],
        load = async () => ({}),
        idPrefix,
    } = options

    if (!collection) throw new Error('useSource: collection is required')
    if (!type) throw new Error('useSource: type is required')
    if (!folder) throw new Error('useSource: folder is required')

    let absFolder
    const prefix = idPrefix ?? `/${collection}`

    onLoaded(async () => {
        const logger = useLogger()
        const cap = collection.replace(/^./, c => c.toUpperCase())

        // Plugin factories run in the onLoad phase, so by the time
        // useSource is called the onInitialize / onInitialized phases
        // have already passed. We do folder resolution + scanning here
        // in onLoaded — by which point engine has set workingFolder
        // and journal + catalog have initialized, so runtime.update
        // is safe.
        absFolder = path.isAbsolute(folder)
            ? folder
            : path.join(runtime.options.workingFolder, folder)
        // Stash on runtime.options under a conventional key so other
        // plugins (or watch wiring) can resolve the folder by name.
        runtime.options[`${collection}Folder`] = absFolder
        logger.info('%s folder: %s', cap, absFolder)

        const pattern = `**/*.{${extensions.join(',')}}`
        const files = await globby(pattern, { cwd: absFolder, absolute: true, onlyFiles: true })
        for (const file of files) {
            await registerFile(file, { logger })
        }
        logger.info('%s loaded: %d', cap, files.length)
    })

    // Hot reload — chokidar dispatches into onSync(collection) when
    // a file inside collection's folder changes.
    onSync(collection, async ({ action, context }) => {
        const logger = useLogger()
        if (!context?.relativePath) return false
        const file = path.join(absFolder, context.relativePath)
        if (action === ACTION.DELETE) {
            const name = nameFromRelativePath(context.relativePath)
            try {
                await runtime.delete?.({ id: `${prefix}/${name}`, type, collection })
                logger.info('%s removed: %s', collection, name)
            } catch (err) {
                logger.warn('%s remove failed for %s: %s', collection, name, err.message)
            }
            return true
        }
        await registerFile(file, { logger, reload: true })
        return true
    })

    async function registerFile(file, { logger, reload = false } = {}) {
        const relativePath = path.relative(absFolder, file)
        const name = nameFromRelativePath(relativePath)
        const id = `${prefix}/${name}`
        const base = {
            id,
            name,
            collection,
            type,
            format: path.extname(file).slice(1),
            uri: file,
            stamp: Date.now(),
        }
        try {
            const extra = await load({ file, name, relativePath, entity: base })
            if (extra === null) {
                logger.trace('%s skipped (load returned null): %s', collection, name)
                return
            }
            const entity = mergeEntity(base, extra)
            // Upsert via runtime.update — catalog treats UPDATE as
            // CREATE when the id doesn't yet exist (see catalog.js).
            await runtime.update?.(entity)
            logger.info('%s %s: %s', collection.replace(/^./, c => c.toUpperCase()), reload ? 'reloaded' : 'loaded', name)
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
