import path from 'path'
import { hash } from 'hasha'
import _ from 'lodash'

export function observer(options = {}) {
    return ({
        runtime,
        useLogger,
        onImport,
        onLoaded,
        onSync,
        createEntity,
        updateEntity,
        deleteEntity,
        findEntity,
        findEntities,
        schedule,
        normalize,
        trackProgress,
        updateProgress,
    }) => {
    const format = 'observer'

    async function syncEntities(observerName) {
        const logger = useLogger()
        const syncTime = Date.now()
        const {
            collection = observerName,
            type = 'document',
            readMany,
            uri = ''
        } = options[observerName]

        let synced = 0
        let removed = 0
        try {
            const recent = new Set()
            const entities = await readMany(runtime)
            trackProgress(`Observer sync ${observerName}`, entities.length)
            for (let meta of entities) {
                if (collection && type && meta.id) {
                    const name = path.join(collection, meta.name || meta.id.toString())
                    const id = path.join('/observer', collection, meta.id.toString())
                    if (recent.has(id)) {
                        logger.error(meta, 'Duplicate entity found: %s', id)
                        continue
                    }
                    recent.add(id)
                    const entity = normalize({
                        id,
                        uri: `${uri}/${meta.id}`,
                        name,
                        collection,
                        type,
                        format,
                        meta
                    })

                    entity.checksum = await hash(JSON.stringify(entity.meta), { algorithm: 'md5' })
                    const current = await findEntity({ id })
                    if (current) {
                        if (entity.checksum != current.checksum) {
                            await updateEntity(entity)
                            synced++
                        }
                    } else {
                        await createEntity(entity)
                        synced++
                    }
                }
                updateProgress()
            }

            const entitiesToRemove = await findEntities({
                type,
                format,
                collection,
                time:  { $lt: syncTime },
                id:    { $nin: [...recent] },
            })
            if (entitiesToRemove.length) trackProgress(`Observer remove ${observerName}`, entitiesToRemove.length)
            for (let entity of entitiesToRemove) {
                deleteEntity(entity)
                removed++
                updateProgress()
            }
            if (synced || removed) {
                logger.debug('Syncing api [%s] synced: %d, removed: %d', collection, synced, removed)
            }
        } catch (err) {
            logger.error('Observer sync [%s] error: %s', collection, err.message)
        }
        return synced > 0 || removed > 0
    }

    async function syncEntity(observerName, apiId) {
        const logger = useLogger()
        const {
            collection = observerName,
            type = 'document',
            readOne,
            uri = ''
        } = options[observerName]

        try {
            const id = path.join('/observer', collection, apiId.toString())
            const current = await findEntity({ id })
            const meta = await readOne(apiId, runtime)
            if (meta?.id) {
                const name = path.join(collection, meta.name || meta.id.toString())
                const entity = normalize({
                    id,
                    uri: `${uri}/${meta.id}`,
                    name,
                    collection,
                    type,
                    format,
                    meta
                })
                entity.checksum = await hash(JSON.stringify(entity.meta), { algorithm: 'md5' })
                if (current) {
                    if (entity.checksum != current.checksum) {
                        logger.debug('Observer update: %s', id)
                        await updateEntity(entity)
                    }
                } else {
                    logger.debug('Observer create: %s', id)
                    await createEntity(entity)
                }
            } else {
                if (current) {
                    logger.debug('Observer delete: %s', id)
                    await deleteEntity(entity)
                }
            }
        } catch (err) {
            logger.error('Observer sync entity [%s] error: %s', collection, err.message)
        }
    }

    onLoaded(async () => {
        const logger = useLogger()
        for (let observerName in options || {}) {
            const { cron } = options[observerName]
            if (cron) {
                logger.info('Schedule observer: [%s] %s', observerName, cron)
                schedule(observerName, cron)
            }

            onSync(observerName, async ({ context }) => {
                if (context?.id) {
                    return syncEntity(observerName, context.id)
                } else {
                    return syncEntities(observerName)
                }
            })

            const { origin } = new URL(options[observerName].uri)
            onSync(origin, async ({ context }) => {
                if (context.uri) {
                    logger.debug('Syncing observer: [%s] %s', observerName, context.uri)
                    return syncEntities(observerName)
                }
            })
        }
    })

    onImport(async () => {
        for (let observerName in options || {}) {
            await syncEntities(observerName)
        }
    })

        return {
            format,
        }
    }
}