import path from 'path'
import { hash } from 'hasha'
import _ from 'lodash'

// Where the record came from, when that is knowable.
//
// `uri` is optional: an observer reading from an SDK, a local queue or
// anything without an addressable endpoint has nothing meaningful to put here.
// The empty string is the established shape for a synthetic entity whose meta
// IS its content — the same one csv row entities use — and the source sweep
// scopes on it, so inventing a path like `/7` would be worse than saying
// nothing.
function entityUri(base, id) {
    return base ? `${base}/${id}` : ''
}

// The origin to register a webhook sync under, or null if there is none.
//
// This used to be `new URL(options[name].uri).origin` inline, which made `uri`
// silently mandatory: leaving it out threw ERR_INVALID_URL out of onLoaded and
// took the whole build down at startup, with nothing in the message naming the
// observer or the option responsible. An absent uri is a legitimate config; a
// malformed one is a mistake, and only the second deserves to stop anything.
function originOf(uri, observerName, logger) {
    if (!uri) return null
    try {
        return new URL(uri).origin
    } catch {
        logger?.warn?.({ code: 'observer-bad-uri' },
            'Observer [%s] has uri: %j, which is not an absolute URL — so no webhook can be routed to it by '
            + 'origin. Give it a full URL like https://api.example.com/things, or drop the option if this '
            + 'observer is not reachable over HTTP.', observerName, uri)
        return null
    }
}

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
                        uri: entityUri(uri, meta.id),
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
                updateProgress(meta.id)
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
                updateProgress(entity.id)
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
                    uri: entityUri(uri, meta.id),
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
                    // `current`, not `entity` — the latter is built inside the
                    // branch above and is not in scope here, so this threw
                    // ReferenceError into the surrounding catch and became one
                    // log line. A record deleted upstream stayed in the
                    // catalog and went on rendering.
                    await deleteEntity(current)
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

            const origin = originOf(options[observerName].uri, observerName, logger)
            if (origin) {
                onSync(origin, async ({ context }) => {
                    if (context.uri) {
                        logger.debug('Syncing observer: [%s] %s', observerName, context.uri)
                        return syncEntities(observerName)
                    }
                })
            }
        }
    })

    onImport(async () => {
        for (let observerName in options || {}) {
            await syncEntities(observerName)
        }
    })

        return {
            format,
            module: import.meta.url,
        }
    }
}