import path from 'node:path'
import { mkdir, writeFile, unlink, rm, readFile, symlink, } from 'fs/promises'
import { globby } from 'globby'
import _ from 'lodash'
import map from 'p-map'

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
            const matches = Array.isArray(runtime.config.assets.presets[preset]) ? runtime.config.assets.presets[preset] : [runtime.config.assets.presets[preset]]
            for (let match of matches) {
                if (matchEntity(entity, match)) {
                    entityPresets.push(preset)
                }
            }
        }
        return entityPresets
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
                let destination = entity.name
                if (entity.preset.format) {
                    destination = changeExtension(destination, entity.preset.format)
                }
                entity.destination = path.join(runtime.options.assetsFolder, entityPreset, destination)
                const ignore = await isPresetRendered(entity)
                tasks.push({
                    entity,
                    options: {
                        ...entity.preset.options,
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

        const name = relativePath.replace(path.extname(relativePath), '')
        const uri = path.join(runtime.options.presetsFolder, relativePath)
        const source = uri

        let synced = true
        switch (action) {
            case ACTION.CREATE:
                try {
                    const { revision = 1, format, options } = await import(`${uri}?stamp=${Date.now()}`)
                    const preset = {
                        id: path.join('/presets', relativePath),
                        collection,
                        type,
                        uri,
                        name: relativePath.replace(path.extname(relativePath), ''),
                        source,
                        format,
                        checksum: revision,
                        options
                    }
                    presets[name] = preset
                    await createEntity(preset)
                } catch (err) {
                    synced = false
                    logger.error('Preset loading error: %s %s', uri, err.message)
                }
                break
            case ACTION.UPDATE:
                try {
                    const { revision = 1, format, options } = await import(`${uri}?stamp=${Date.now()}`)
                    const preset = {
                        id: path.join('/presets', relativePath),
                        collection,
                        type,
                        uri,
                        name: relativePath.replace(path.extname(relativePath), ''),
                        checksum: revision,
                        source,
                        format,
                        options
                    }
                    if (!preset[name]) {
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

        const paths = await globby('*.js', { cwd: runtime.options.presetsFolder })
        for (let relativePath of paths) {
            const uri = path.join(runtime.options.presetsFolder, relativePath)
            const source = uri
            try {
                const { revision = 1, format, options } = await import(`${uri}?stamp=${Date.now()}`)
                const name = relativePath.replace(path.extname(relativePath), '')

                const preset = {
                    id: path.join('/presets', relativePath),
                    collection,
                    type,
                    uri,
                    name: relativePath.replace(path.extname(relativePath), ''),
                    source,
                    format,
                    checksum: revision,
                    options,
                    options
                }

                await createEntity(preset)
                presets[name] = preset
            } catch (err) {
                logger.error(err, 'Preset loading error: %s', uri)
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
