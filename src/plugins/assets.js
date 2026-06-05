import path from 'node:path'
import { mkdir, writeFile, unlink, rm, readFile, symlink, } from 'fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { globby } from 'globby'
import _ from 'lodash'
import map from 'p-map'

// Normalize a `runtime.config.assets.presets[name]` value to a consistent
// { matches, options } shape so callers don't have to inspect which form
// the config used.
//
// Two formats supported, detected from the value shape:
//
//   // 1. Existing — string or array of match patterns:
//   presets: {
//       'thumbnail': '@/images/*',
//       'small-image': ['/files/images/*.jpg', '/resources/**/*.jpg'],
//   }
//
//   // 2. New — object with `match` and per-preset `options`:
//   presets: {
//       'medium-image': {
//           match: '/files/images/*.jpg',
//           options: { width: 800, height: 600, quality: 80 },
//       },
//   }
//
// Options merge over the preset module's own `options` export at render
// time — module-side defaults, config-side overrides.
//
// Caveat: changing config-side options does NOT automatically invalidate
// already-rendered assets on disk. Bump the preset's `revision` export
// to force a re-render, or run `mikser --clear` to start fresh.
export function normalizePresetConfig(value) {
    if (value == null) return { matches: [], options: {} }
    if (typeof value === 'string') return { matches: [value], options: {} }
    if (Array.isArray(value))      return { matches: value, options: {} }
    if (typeof value === 'object' && ('match' in value || 'options' in value)) {
        const m = value.match
        return {
            matches: Array.isArray(m) ? m : (m == null ? [] : [m]),
            options: value.options ?? {},
        }
    }
    // Fallback — treat the value itself as a single match pattern
    // (object literal with a custom matcher, or a function).
    return { matches: [value], options: {} }
}

export default ({
    runtime,
    onLoaded,
    useLogger,
    onImport,
    watch,
    onProcessed,
    onBeforeRender,
    useJournal,
    createEntity,
    updateEntity,
    deleteEntity,
    renderEntities,
    onComplete,
    onSync,
    onFinalize,
    findEntity,
    matchEntity,
    changeExtension,
    constants: { ACTION, OPERATION },
}) => {
    const collection = 'presets'
    const type = 'preset'
    const checksumMap = new Set()

    async function getEntityPresets(entity) {
        const entityPresets = []
        for (let preset in (runtime.config.assets?.presets || {})) {
            const { matches } = normalizePresetConfig(runtime.config.assets.presets[preset])
            for (let match of matches) {
                if (matchEntity(entity, match)) {
                    entityPresets.push(preset)
                }
            }
        }
        return entityPresets
    }

    // Resolve a preset name to an importable module location. Local
    // files in presetsFolder win; names with no local file fall back to
    // an npm package named `mikser-io-preset-<name>`, resolved from the
    // project's node_modules. Mirrors how postprocess.js resolves
    // post-* plugins — local override first, then the npm convention.
    // Returns { uri, watchable } or null when neither exists.
    //
    // `watchable` distinguishes the two lifetimes: local presets are
    // re-imported (cache-busted) on every load so watch-mode edits take
    // effect; npm presets are versioned by their package, imported once.
    function resolvePreset(name) {
        const local = path.join(runtime.options.presetsFolder, `${name}.js`)
        if (existsSync(local)) {
            return { uri: local, watchable: true }
        }
        try {
            const require = createRequire(path.join(runtime.options.workingFolder, 'package.json'))
            const uri = require.resolve(`mikser-io-preset-${name}`)
            return { uri, watchable: false }
        } catch {
            return null
        }
    }

    // Import a preset module and build its catalog entity. One place for
    // the (revision, format, options) export contract so onImport and
    // onSync stay in sync. Cache-busts local presets so watch-mode edits
    // reload; npm presets import once (their version is the cache key).
    async function buildPreset({ name, uri, watchable }) {
        const cacheBust = watchable ? `?stamp=${Date.now()}` : ''
        const { revision = 1, format, options } = await import(`${uri}${cacheBust}`)
        return {
            id: `/presets/${name}`,
            collection,
            type,
            uri,
            name,
            source: uri,
            format,
            checksum: revision,
            options,
        }
    }

    async function getRevisions(entity) {
        let revisions = await globby(`${entity.destination.replaceAll('(', '\\(').replaceAll(')', '\\)')}.*.md5`, {
            cwd: path.join(runtime.options.assetsFolder, entity.preset.name),
            expandDirectories: false,
            onlyFiles: true
        })
        return revisions
    }

    async function isPresetRendered(entity) {
        let result = false
        let revisions = []
        const assetChecksum = `${entity.destination}.${entity.preset.checksum}.md5`
        if (checksumMap.has(assetChecksum)) {
            revisions.push(assetChecksum)
        } else {
            revisions = await getRevisions(entity)
        }

        for (let revision of revisions) {
            const [assetsRevision] = revision.split('.').slice(-2, -1)
            if (entity.preset.checksum <= Number.parseInt(assetsRevision)) {
                if (entity.preset.options?.checksum === false) {
                    result = true
                    break
                }

                let checksum = await readFile(revision, 'utf8')
                result ||= checksum == entity.checksum
                if (result) break
            }
        }
        return result
    }

    async function renderPresets(entities) {
        const { presets, assetsMap } = runtime.state.assets

        const tasks = []
        for (let entityToRender of entities) {
            for (let entityPreset of assetsMap[entityToRender.id] || []) {
                const entity = _.cloneDeep(entityToRender)
                entity.preset = presets[entityPreset]
                // Per-preset config options override the preset module's
                // defaults. Looked up at render time so config edits are
                // picked up on the next cycle without rebuilding the
                // preset entity from its module.
                const { options: configOptions } = normalizePresetConfig(
                    runtime.config.assets?.presets?.[entityPreset]
                )
                let destination = entity.name
                if (entity.preset.format) {
                    destination = changeExtension(destination, entity.preset.format)
                }
                entity.destination = path.join(runtime.options.assetsFolder, entityPreset, destination)
                const ignore = await isPresetRendered(entity)
                tasks.push({
                    entity,
                    options: {
                        ...entity.preset.options,    // module defaults
                        ...configOptions,             // config overrides
                        renderer: 'preset',
                        ignore
                    }
                })
            }
        }
        await renderEntities(tasks)

    }

    onLoaded(async () => {
        const logger = useLogger()

        const assetsName = runtime.config.assets?.assetsFolder || 'assets'
        runtime.state.assets = {
            presets: {},
            assetsMap: {},
            assetsFolder: runtime.config.assets?.outputFolder
                ? path.join(runtime.config.assets.outputFolder, assetsName)
                : assetsName,
        }

        runtime.options.presets = runtime.config.presets?.presetsFolder || collection
        runtime.options.presetsFolder = path.join(runtime.options.workingFolder, runtime.options.presets)
        logger.debug('Presets folder: %s', runtime.options.presetsFolder)
        await mkdir(runtime.options.presetsFolder, { recursive: true })

        runtime.options.assets = runtime.config.assets?.assetsFolder || 'assets'
        runtime.options.assetsFolder = path.join(runtime.options.workingFolder, runtime.options.assets)
        logger.debug('Assets folder: %s', runtime.options.assetsFolder)
        await mkdir(runtime.options.assetsFolder, { recursive: true })

        let link = path.join(runtime.options.outputFolder, runtime.options.assets)
        if (runtime.config.assets?.outputFolder) link = path.join(runtime.options.outputFolder, runtime.config.assets?.outputFolder, runtime.options.assets)
        try {
            await mkdir(path.dirname(link), { recursive: true })
            await symlink(path.resolve(runtime.options.assetsFolder), link, 'dir')
        } catch (err) {
            if (err.code != 'EEXIST')
                throw err
        }

        watch(collection, runtime.options.presetsFolder)
    })

    onSync(collection, async ({ action, context }) => {
        if (!context.relativePath) return false
        const { relativePath } = context

        const logger = useLogger()
        const { presets } = runtime.state.assets

        // Watch only fires for files in presetsFolder, so these are
        // always local presets — watchable: true.
        const name = relativePath.replace(path.extname(relativePath), '')
        const uri = path.join(runtime.options.presetsFolder, relativePath)

        let synced = true
        switch (action) {
            case ACTION.CREATE:
                try {
                    const preset = await buildPreset({ name, uri, watchable: true })
                    presets[name] = preset
                    await createEntity(preset)
                } catch (err) {
                    synced = false
                    logger.error('Preset loading error: %s %s', uri, err.message)
                }
                break
            case ACTION.UPDATE:
                try {
                    const preset = await buildPreset({ name, uri, watchable: true })
                    // Was `!preset[name]` — a typo for `!presets[name]`
                    // that made every UPDATE take the create branch
                    // (preset[name] is always undefined). Fixed: only
                    // re-emit when the revision actually changed.
                    if (!presets[name]) {
                        presets[name] = preset
                        await createEntity(preset)
                    } else if (presets[name].checksum != preset.checksum) {
                        presets[name] = preset
                        await updateEntity(preset)
                    } else {
                        synced = false
                    }
                } catch (err) {
                    synced = false
                    logger.error('Preset loading error: %s %s', uri, err.message)
                }
                break
            case ACTION.DELETE:
                delete presets[name]
                await deleteEntity({
                    id: path.join('/presets', relativePath),
                    collection,
                    type,
                })
                break
        }
        return synced
    })

    onImport(async () => {
        const logger = useLogger()
        const { presets } = runtime.state.assets

        // Local presets: scan the presets folder. Loads every *.js
        // there, keyed by filename. Local always wins.
        const paths = await globby('*.js', { cwd: runtime.options.presetsFolder })
        for (let relativePath of paths) {
            const name = relativePath.replace(path.extname(relativePath), '')
            const uri = path.join(runtime.options.presetsFolder, relativePath)
            try {
                const preset = await buildPreset({ name, uri, watchable: true })
                await createEntity(preset)
                presets[name] = preset
            } catch (err) {
                logger.error(err, 'Preset loading error: %s', uri)
            }
        }

        // npm presets: any preset name referenced in config that no
        // local file already provided resolves to an npm package
        // `mikser-io-preset-<name>`. Config is the source of truth for
        // which presets a project uses; this fills the names a folder
        // scan can't (the code lives in node_modules, not presets/).
        for (const name of Object.keys(runtime.config.assets?.presets || {})) {
            if (presets[name]) continue   // a local file already loaded it
            const resolved = resolvePreset(name)
            if (!resolved) {
                logger.error(
                    'Preset not found: %s (no presets/%s.js, no npm package mikser-io-preset-%s)',
                    name, name, name,
                )
                continue
            }
            try {
                const preset = await buildPreset({ name, uri: resolved.uri, watchable: resolved.watchable })
                await createEntity(preset)
                presets[name] = preset
                logger.debug('Preset loaded from npm: mikser-io-preset-%s', name)
            } catch (err) {
                logger.error(err, 'Preset loading error (npm): mikser-io-preset-%s', name)
            }
        }
    })

    onProcessed(async (signal) => {
        const logger = useLogger()
        const { assetsMap } = runtime.state.assets

        for await (let { entity, operation } of useJournal('Assets processing', [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE], signal)) {
            if (entity.collection != collection) {
                switch (operation) {
                    case OPERATION.CREATE:
                    case OPERATION.UPDATE:
                        const entityPresets = await getEntityPresets(entity)
                        if (entityPresets.length) {
                            logger.debug('Presets matched for: %s %s', entity.collection, entity.id, entityPresets.length)
                            assetsMap[entity.id] = entityPresets
                        }
                        break
                    case OPERATION.DELETE:
                        delete assetsMap[entity.id]
                        break
                }
            }
        }
    })

    onBeforeRender(async signal => {
        const { assetsMap } = runtime.state.assets

        checksumMap.clear()
        const checksumFiles = await globby('**/*.md5', { cwd: runtime.options.assetsFolder })
        for (let checksumFile of checksumFiles) {
            checksumMap.add(path.join(runtime.options.assetsFolder, checksumFile))
        }

        const entitiesToRender = new Map()
        await map(useJournal('Assets provision', [OPERATION.CREATE, OPERATION.UPDATE], signal), async ({ entity }) => {
            if (entity.collection == collection) {
                for (let entityId in assetsMap) {
                    if (assetsMap[entityId].find(preset => preset == entity.name)) {
                        const entityToRender = await findEntity({
                            id: entityId
                        })
                        if (!entitiesToRender.has(entityToRender.id)) {
                            entitiesToRender.set(entityToRender.id, entityToRender)
                        }
                    }
                }
            } else {
                if (assetsMap[entity.id] && !entitiesToRender.has(entity.id)) {
                    entitiesToRender.set(entity.id, entity)
                }
            }
        }, { concurrency: 10, signal })

        await renderPresets(entitiesToRender.values())
    })

    onComplete(async ({ entity, options }) => {
        const logger = useLogger()
        if (entity.preset && !options?.ignore) {
            await mkdir(path.dirname(entity.destination), { recursive: true })
            const assetChecksum = `${entity.destination}.${entity.preset.checksum}.md5`
            await writeFile(assetChecksum, entity.checksum, 'utf8')
            logger.debug('Asset render finished: [%s] %s', assetChecksum, entity.destination.replace(runtime.options.workingFolder, ''))
        }
    })

    onFinalize(async () => {
        const logger = useLogger()
        const { presets } = runtime.state.assets

        let revisions = await globby('**/*.md5', { cwd: runtime.options.assetsFolder })
        for (let revision of revisions) {
            const [preset] = revision.split(path.sep)
            const [assetsRevision] = revision.split('.').slice(-2, -1)

            if (!presets[preset]) {
                const assetsPresetFolder = path.join(runtime.options.assetsFolder, preset)
                const assetsPresetRemoved = false
                try {
                    await rm(assetsPresetFolder, { recursive: true, force: true })
                    assetsPresetRemoved = true
                } catch { }
                if (assetsPresetRemoved) {
                    logger.debug('Assets preset removed: %s', assetsPresetFolder)
                }
            } else {
                if (Number.parseInt(assetsRevision) < presets[preset].checksum) {
                    await unlink(path.join(runtime.options.assetsFolder, revision))
                }
            }
        }
    })

    return {
        collection,
        type
    }
}
