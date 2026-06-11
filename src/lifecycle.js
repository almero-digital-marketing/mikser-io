import runtime from './runtime.js'
import { OPERATION } from './constants.js'
import { useLogger } from './engine.js'
import { addEntry, addEntries } from './journal.js'

export async function createEntity(entity) {
    const logger = useLogger()
    entity.stamp = runtime.stamp
    entity.time = Date.now()
    const entry = { operation: OPERATION.CREATE, entity }
    if (await runtime.validate(entry)) {
        logger.debug('Create %s entity: %s', entity.collection, entity.id)
        await addEntry(entry)
    }
}

// deleteEntity accepts either a minimal { id, type, collection }
// payload or a full entity. The full-entity form is preferred when
// the caller has it on hand (source.sweepDeleted does — it just
// findById'd the entity to compute the deletion), because the
// manifest's query-affected dispatch (and any downstream sift-based
// invalidation) can only match against the entity's actual fields.
// A minimal {id,type,collection} still works for backwards
// compatibility but query deps on fields not in that triple
// (format, meta.*, name, etc.) won't fire.
export async function deleteEntity(payload) {
    const logger = useLogger()
    const entity = payload?.id
        ? payload   // accept full entity payload as-is
        : { id: payload?.id, type: payload?.type, collection: payload?.collection }
    const entry = { operation: OPERATION.DELETE, entity }
    if (await runtime.validate(entry)) {
        logger.debug('Delete %s entity: %s %s', entity.collection, entity.type, entity.id)
        await addEntry(entry)
    }
}

export async function updateEntity(entity) {
    const logger = useLogger()
    entity.stamp = runtime.stamp
    entity.time = Date.now()
    const entry = { operation: OPERATION.UPDATE, entity }
    if (await runtime.validate(entry)) {
        logger.debug('Update %s entity: %s', entity.collection, entity.id)
        await addEntry(entry)
    }
}

// Expose the three entity operations as methods on the runtime so library
// code (useRenderer, custom plugins) can call `runtime.update(entity)`
// instead of importing and threading the standalone functions. The
// imports above already pulled the runtime singleton into scope; this is
// just a single assignment per name.
runtime.create = createEntity
runtime.update = updateEntity
runtime.delete = deleteEntity

export async function postprocessEntity(entity, options = {}, context = {}) {
    const logger = useLogger()
    const entry = { operation: OPERATION.POSTPROCESS, entity, options, context }
    logger.debug('Postprocess %s entity: [%s] %s → %s', entity.collection, options.postprocessor, entity.id, entity.destination)
    await addEntry(entry)
}

export async function postprocessEntities(tasks) {
    const logger = useLogger()
    if (!tasks.length) return
    const entries = []
    for (let { entity, options = {}, context = {} } of tasks) {
        const entry = { operation: OPERATION.POSTPROCESS, entity, options, context }
        logger.debug('Postprocess %s entity: [%s] %s → %s', entity.collection, options.postprocessor, entity.id, entity.destination)
        entries.push(entry)
    }
    await addEntries(entries)
}

export async function renderEntities(tasks) {
    const logger = useLogger()
    if (!tasks.length) return
    const entries = []
    for (let { entity, options = {}, context = {} } of tasks) {
        const entry = { operation: OPERATION.RENDER, entity, options, context, }
        if (options.ignore) {
            logger.trace('Render %s entity: [%s] %s → %s %s', entity.collection, options.renderer, entity.id, entity.destination, !options.ignore)
        } else {
            logger.debug('Render %s entity: [%s] %s → %s %s', entity.collection, options.renderer, entity.id, entity.destination, !options.ignore)
        }
        entries.push(entry)
    }
    await addEntries(entries)
}

export async function renderEntity(entity, options = {}, context = {}) {
    const logger = useLogger()
    const entry = { operation: OPERATION.RENDER, entity, options, context, }
    if (options.ignore) {
        logger.trace('Render %s entity: [%s] %s → %s %s', entity.collection, options.renderer, entity.id, entity.destination, !options.ignore)
    } else {
        logger.debug('Render %s entity: [%s] %s → %s %s', entity.collection, options.renderer, entity.id, entity.destination, !options.ignore)
    }
    await addEntry(entry)
}

export async function onInitialize(callback) {
    runtime.hooks.initialize.push(callback)
}

export async function onInitialized(callback) {
    runtime.hooks.initialized.push(callback)
}

export async function onLoad(callback) {
    runtime.hooks.load.push(callback)
}

export async function onLoaded(callback) {
    runtime.hooks.loaded.push(callback)
}

export async function onImport(callback) {
    runtime.hooks.import.push(callback)
}

export async function onImported(callback) {
    runtime.hooks.imported.push(callback)
}

export async function onProcess(callback, once) {
    if (!once) runtime.hooks.process.push(callback)
    else {
        let called = false
        runtime.hooks.process.push((signal) => {
            if (!called) {
                called = true
                callback(signal)
            }
        })
    }
}

export async function onProcessed(callback, once) {
    if (!once) runtime.hooks.processed.push(callback)
    else {
        let called = false
        runtime.hooks.processed.push((signal) => {
            if (!called) {
                called = true
                callback(signal)
            }
        })
    }
}

export async function onPersist(callback, once) {
    if (!once) runtime.hooks.persist.push(callback)
    else {
        let called = false
        runtime.hooks.persist.push((signal) => {
            if (!called) {
                called = true
                callback(signal)
            }
        })
    }
}

export async function onPersisted(callback, once) {
    if (!once) runtime.hooks.persisted.push(callback)
    else {
        let called = false
        runtime.hooks.persisted.push((signal) => {
            if (!called) {
                called = true
                callback(signal)
            }
        })
    }
}

export async function onCancel(callback) {
    runtime.hooks.cancel.push(callback)
}

export async function onCancelled(callback) {
    runtime.hooks.cancelled.push(callback)
}

export async function onBeforeRender(callback, once) {
    if (!once) runtime.hooks.beforeRender.push(callback)
    else {
        let called = false
        runtime.hooks.beforeRender.push((signal) => {
            if (!called) {
                called = true
                callback(signal)
            }
        })
    }
}

export async function onRender(callback, once) {
    if (!once) runtime.hooks.render.push(callback)
    else {
        let called = false
        runtime.hooks.render.push((signal) => {
            if (!called) {
                called = true
                callback(signal)
            }
        })
    }
}

export async function onAfterRender(callback, once) {
    if (!once) runtime.hooks.afterRender.push(callback)
    else {
        let called = false
        runtime.hooks.afterRender.push((signal) => {
            if (!called) {
                called = true
                callback(signal)
            }
        })
    }
}

export async function onBeforePostprocess(callback, once) {
    if (!once) runtime.hooks.beforePostprocess.push(callback)
    else {
        let called = false
        runtime.hooks.beforePostprocess.push((signal) => {
            if (!called) {
                called = true
                callback(signal)
            }
        })
    }
}

export async function onPostprocess(callback, once) {
    if (!once) runtime.hooks.postprocess.push(callback)
    else {
        let called = false
        runtime.hooks.postprocess.push((signal) => {
            if (!called) {
                called = true
                callback(signal)
            }
        })
    }
}

export async function onAfterPostprocess(callback, once) {
    if (!once) runtime.hooks.afterPostprocess.push(callback)
    else {
        let called = false
        runtime.hooks.afterPostprocess.push((signal) => {
            if (!called) {
                called = true
                callback(signal)
            }
        })
    }
}

export async function onFinalize(callback, once) {
    if (!once) runtime.hooks.finalize.push(callback)
    else {
        let called = false
        runtime.hooks.finalize.push((signal) => {
            if (!called) {
                called = true
                callback(signal)
            }
        })
    }
}

export async function onFinalized(callback, once) {
    if (!once) runtime.hooks.finalized.push(callback)
    else {
        let called = false
        runtime.hooks.finalized.push((signal) => {
            if (!called) {
                called = true
                callback(signal)
            }
        })
    }
}

export function onSync(name, callback) {
    runtime.hooks.sync.push(async (operation) => {
        if (operation.name == name) {
            return await callback(operation)
        }
    })
}

export function onValidate(operations, callback) {
    const logger = useLogger()
    runtime.validators.push(async (entry) => {
        if (operations.indexOf(entry.operation) != -1) {
            try {
                const message = await callback(entry)
                if (message) {
                    logger.warn('Validation problem: [%s] %s %s', entry.operation, entry.entity.name, message)
                }
                return true
            } catch (err) {
                logger.error('Validation error: [%s] %s %s', entry.operation, entry.entity.name, err.message)
                return false
            }
        }
    })
}

export function onComplete(callback) {
    runtime.hooks.completed.push(callback)
}