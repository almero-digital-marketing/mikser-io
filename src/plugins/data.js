import path from 'path'
import { mkdir, writeFile, unlink } from 'fs/promises'
import _ from 'lodash'
import pMap from 'p-map'

export default ({
    onLoaded,
    useLogger,
    runtime,
    useJournal,
    normalize,
    findEntities,
    onAfterRender,
    onFinalize,
    onBeforeRender,
    constants: { OPERATION },
}) => {
    onLoaded(async () => {
        const logger = useLogger()
        runtime.options.data = runtime.config.data?.dataFolder || 'data'
        runtime.options.dataFolder = path.join(runtime.options.outputFolder, runtime.options.data)

        logger.info('Data folder: %s', runtime.options.dataFolder)
        await mkdir(runtime.options.dataFolder, { recursive: true })
    })

    onBeforeRender(async () => {
        const logger = useLogger()

        let entitiesConfig = runtime.config.data?.entities
        if (entitiesConfig === undefined) {
            entitiesConfig = {
                document: {
                    query: entity => entity.type == 'document'
                }
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
                map,
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

            for await (let { operation, entity } of useJournal('Data entities', [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE])) {
                if (query(entity)) {
                    switch (operation) {
                        case OPERATION.CREATE:
                        case OPERATION.UPDATE:
                            logger.debug('Data export entity %s %s: %s', entity.collection, operation, entity.id)
                            await saveEntity(map ? await map(entity) : {
                                refId: ('/' + entity.name.replaceAll('\\', '/')).replace(/\/index$/g, '/'),
                                name: entity.name,
                                date: new Date(entity.time),
                                data: _.pick(entity, pick || ['collection', 'format', 'type', 'destination', 'stamp', 'meta', 'id',])
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

        let contextConfig = runtime.config.data?.context
        if (contextConfig === undefined) {
            contextConfig = {
                context: {
                    query: entity => entity.type == 'document'
                }
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
                map,
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

            for await (let { entity, context } of useJournal('Data context', [OPERATION.RENDER])) {
                if (query(entity)) {
                    logger.debug('Data export context: %s', entity.name)
                    await saveConext(entity, map ? await map(entity, context) : _.pick(context, pick || ['data']))
                }
            }
        }
    })

    onFinalize(async () => {
        const logger = useLogger()
        for (let catalogName in runtime.config.data?.catalog || {}) {
            // Per-config namespacing token — see the entities loop above.
            const token = runtime.config.data?.catalog[catalogName].token
            const targetFolder = token
                ? path.join(runtime.options.dataFolder, token)
                : runtime.options.dataFolder
            const {
                query: queryEntities = entity => entity.type == 'document',
                map,
                pick,
                save: saveEntities = async entities => {
                    const entitiesFile = path.join(targetFolder, `${catalogName}.json`)
                    await mkdir(path.dirname(entitiesFile), { recursive: true })
                    logger.debug('Data export catalog %s %s: %s', catalogName, entities.length, entitiesFile)
                    await writeFile(entitiesFile, JSON.stringify(entities), 'utf8')
                }
            } = runtime.config.data?.catalog[catalogName]
            const entities = await findEntities(queryEntities)
            await saveEntities(await pMap(entities, async entity => map ? await map(entity) : {
                refId: ('/' + entity.name.replaceAll('\\', '/')).replace(/\/index$/g, '/'),
                name: entity.name,
                date: new Date(entity.time),
                data: _.pick(entity, pick || ['collection', 'format', 'type', 'destination', 'stamp', 'meta', 'id',])
            }))
        }
    })
}