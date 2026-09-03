import path from 'path'
import { cliOption } from '../cli.js'
import { mkdir, writeFile, unlink, open } from 'fs/promises'
import _ from 'lodash'
import sift from 'sift'

export function data(options = {}) {
    return ({
        onLoaded,
        useLogger,
        runtime,
        useJournal,
        normalize,
        findEntities,
        iterateEntities,
        onAfterRender,
        onFinalize,
        onBeforeRender,
        constants: { OPERATION },
    }) => {
    // The folder this plugin owns, on the command line.
    //
    // Config-only until 9.100.0, because a plugin could not declare an option
    // — so overriding it for one run meant editing the config, which is the
    // file whose checksum decides whether the catalog is still valid. A flag
    // is the difference between trying something once and invalidating
    // everything.
    //
    // CLI beats config beats default. `??` rather than `||` below: an option
    // commander did not see is undefined, and an intentional empty string is a
    // different answer than "not given".
    cliOption('--data <folder>',
        'folder for emitted data files, relative to the OUTPUT folder (default: data)')

    onLoaded(async () => {
        const logger = useLogger()
        runtime.options.data = runtime.options.data ?? options.dataFolder ?? 'data'
        runtime.options.dataFolder = path.join(runtime.options.outputFolder, runtime.options.data)

        logger.debug('Data folder: %s', runtime.options.dataFolder)
        await mkdir(runtime.options.dataFolder, { recursive: true })
    })

    onBeforeRender(async () => {
        const logger = useLogger()

        let entitiesConfig = options.entities
        if (entitiesConfig === undefined) {
            entitiesConfig = {
                document: {
                    query: { type: 'document' },
                },
            }
        }
        for (let entitiesName in entitiesConfig) {
            // Per-config namespacing token. When set, this entity-writer's
            // files land under <dataFolder>/<token>/ instead of straight
            // in <dataFolder>. Each named entity config can declare its
            // own token, so they can target different namespaces (useful
            // for multi-tenant exports into shared storage).
            const token = entitiesConfig[entitiesName].token
            const targetFolder = token
                ? path.join(runtime.options.dataFolder, token)
                : runtime.options.dataFolder
            const {
                query,
                map: mapEntity = entity => entity,
                pick,
                save: saveEntity = async entity => {
                    if (!entity.name) {
                        logger.warn('Entity name is missing: %o', entity)
                        return
                    }
                    const dump = JSON.stringify(normalize(entity))
                    const entityFile = path.join(targetFolder, `${entity.name}.${entitiesName}.json`)
                    await mkdir(path.dirname(entityFile), { recursive: true })
                    await writeFile(entityFile, dump, 'utf8')
                },
                delete: deleteEntity = async entity => {
                    const entityFile = path.join(targetFolder, `${entity.name}.json`)
                    await unlink(entityFile)
                }
            } = entitiesConfig[entitiesName]

            // `query` is a sift filter object; compiled once per
            // entitiesName, then tested per journal entry.
            const matchEntity = sift(query)
            for await (let { operation, entity } of useJournal('Data entities', [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE])) {
                if (matchEntity(entity)) {
                    switch (operation) {
                        case OPERATION.CREATE:
                        case OPERATION.UPDATE:
                            logger.debug('Data export entity %s %s: %s', entity.collection, operation, entity.id)
                            // mapEntity is user-supplied — sometimes a pure
                            // transform-for-export (returns a derived shape),
                            // sometimes a mutation hook (enriches entity.meta
                            // with computed fields). Both shapes work: the
                            // pure transform's return goes to saveEntity; an
                            // in-place mutation is auto-persisted by the
                            // useJournal generator when this for-body
                            // completes, so downstream phases see the change.
                            await saveEntity({
                                refId: ('/' + entity.name.replaceAll('\\', '/')).replace(/\/index$/g, '/'),
                                name: entity.name,
                                date: new Date(entity.time),
                                data: _.pick(await mapEntity(entity), pick || ['collection', 'format', 'type', 'destination', 'stamp', 'meta', 'id',])
                            })
                            break
                        case OPERATION.DELETE:
                            await deleteEntity(entity)
                            break
                    }
                }
            }
        }
    })

    onAfterRender(async () => {
        const logger = useLogger()

        let contextConfig = options.context
        if (contextConfig === undefined) {
            contextConfig = {
                context: {
                    query: { type: 'document' },
                },
            }
        }
        for (let contextName in contextConfig) {
            // Per-config namespacing token — see the entities loop above.
            const token = contextConfig[contextName].token
            const targetFolder = token
                ? path.join(runtime.options.dataFolder, token)
                : runtime.options.dataFolder
            const {
                query,
                map: mapEntityContext = (entity, context) => context,
                pick,
                save: saveConext = async (entity, context) => {
                    if (context?.data) {
                        const entityName = entity.name
                        const contextFile = path.join(targetFolder, `${entityName}.${contextName}.json`)
                        await mkdir(path.dirname(contextFile), { recursive: true })
                        await writeFile(contextFile, JSON.stringify(context), 'utf8')
                    }
                }
            } = contextConfig[contextName]

            const matchEntity = sift(query)
            for await (let { entity, context } of useJournal('Data context', [OPERATION.RENDER])) {
                if (matchEntity(entity)) {
                    logger.debug('Data export context: %s', entity.name)
                    await saveConext(entity, _.pick(await mapEntityContext(entity, context), pick || ['data']))
                }
            }
        }
    })

    onFinalize(async () => {
        const logger = useLogger()
        for (let catalogName in options.catalog || {}) {
            // Per-config namespacing token — see the entities loop above.
            const token = options.catalog[catalogName].token
            const targetFolder = token
                ? path.join(runtime.options.dataFolder, token)
                : runtime.options.dataFolder
            const cfg = options.catalog[catalogName]
            const catalogFilter = cfg.query ?? { type: 'document' }
            const mapEntity = cfg.map ?? (entity => entity)
            const pick = cfg.pick
            const saveEntities = cfg.save
            const pickKeys = pick || ['collection', 'format', 'type', 'destination', 'stamp', 'meta', 'id']

            async function transform(entity) {
                return {
                    refId: ('/' + entity.name.replaceAll('\\', '/')).replace(/\/index$/g, '/'),
                    name: entity.name,
                    date: new Date(entity.time),
                    data: _.pick(await mapEntity(entity), pickKeys),
                }
            }

            if (saveEntities) {
                // User-provided save() takes an array — preserve the
                // contract by materializing. Operators who override this
                // have signed up for the memory cost.
                const entities = await findEntities(catalogFilter)
                const transformed = []
                for (const entity of entities) {
                    transformed.push(await transform(entity))
                }
                await saveEntities(transformed)
            } else {
                // Default path — stream to a JSON array file without
                // ever holding the full set in heap. iterateEntities
                // chunks at the catalog layer; we hand-roll the JSON
                // array framing so transformed rows go to disk as they
                // come, bounded peak ≈ one entity at a time.
                const entitiesFile = path.join(targetFolder, `${catalogName}.json`)
                await mkdir(path.dirname(entitiesFile), { recursive: true })
                const fh = await open(entitiesFile, 'w')
                try {
                    await fh.write('[')
                    let count = 0
                    for await (const entity of iterateEntities(catalogFilter)) {
                        const row = await transform(entity)
                        if (count > 0) await fh.write(',')
                        await fh.write(JSON.stringify(row))
                        count++
                    }
                    await fh.write(']')
                    logger.debug('Data export catalog %s %s: %s', catalogName, count, entitiesFile)
                } finally {
                    await fh.close()
                }
            }
        }
    })
    }
}