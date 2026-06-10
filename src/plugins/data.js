import path from 'path'
import { mkdir, writeFile, unlink, open } from 'fs/promises'
import _ from 'lodash'
import sift from 'sift'

export default ({
    onLoaded,
    useLogger,
    runtime,
    useJournal,
    updateEntry,
    normalize,
    findEntities,
    iterateEntities,
    onAfterRender,
    onFinalize,
    onBeforeRender,
    constants: { OPERATION },
}) => {
    onLoaded(async () => {
        const logger = useLogger()
        runtime.options.data = runtime.config.data?.dataFolder || 'data'
        runtime.options.dataFolder = path.join(runtime.options.outputFolder, runtime.options.data)

        logger.debug('Data folder: %s', runtime.options.dataFolder)
        await mkdir(runtime.options.dataFolder, { recursive: true })
    })

    onBeforeRender(async () => {
        const logger = useLogger()

        let entitiesConfig = runtime.config.data?.entities
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
            for await (let { id, operation, entity } of useJournal('Data entities', [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE])) {
                if (matchEntity(entity)) {
                    switch (operation) {
                        case OPERATION.CREATE:
                        case OPERATION.UPDATE:
                            logger.debug('Data export entity %s %s: %s', entity.collection, operation, entity.id)
                            // mapEntity is a user-defined hook. Many configs use it
                            // as a transform-for-export (return a derived shape)
                            // and the picked result lands in saveEntity below.
                            // Some configs use it as a MUTATION hook — enriching
                            // entity.meta with computed fields, normalizing data,
                            // etc. — and expect downstream phases (layouts
                            // dispatch, render templates) to see the change.
                            //
                            // The post-sqlite journal stores its own JSON copy
                            // per row, so in-place mutations to the yielded
                            // entity don't survive without an explicit
                            // updateEntry call. Calling it unconditionally here
                            // is cheap (one UPDATE per mutated row) and
                            // preserves both contracts: pure transforms see no
                            // change to the row's stored copy; mutating
                            // transforms are persisted.
                            const mapped = await mapEntity(entity)
                            await updateEntry({ id, entity })
                            await saveEntity(({
                                refId: ('/' + entity.name.replaceAll('\\', '/')).replace(/\/index$/g, '/'),
                                name: entity.name,
                                date: new Date(entity.time),
                                data: _.pick(mapped, pick || ['collection', 'format', 'type', 'destination', 'stamp', 'meta', 'id',])
                            }))
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
        for (let catalogName in runtime.config.data?.catalog || {}) {
            // Per-config namespacing token — see the entities loop above.
            const token = runtime.config.data?.catalog[catalogName].token
            const targetFolder = token
                ? path.join(runtime.options.dataFolder, token)
                : runtime.options.dataFolder
            const cfg = runtime.config.data?.catalog[catalogName]
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