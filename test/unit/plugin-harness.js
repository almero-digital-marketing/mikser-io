// A minimal in-memory harness for testing core plugins.
//
// Real plugins call lifecycle registrations (onLoaded, onProcess, onSync, ...)
// during their factory invocation; the engine later drives those callbacks. In
// tests we substitute every API surface with a recorder, then drive the
// callbacks manually with controlled inputs.

import _ from 'lodash'
import realRuntime from '../../src/runtime.js'
import { matchEntity, normalize, changeExtension, getFormatInfo, checksum, AbortError } from '../../src/utils.js'

const OPERATION = {
    CREATE: 'create',
    UPDATE: 'update',
    DELETE: 'delete',
    RENDER: 'render',
    POSTPROCESS: 'postprocess',
}
const ACTION = {
    CREATE: 'create',
    UPDATE: 'update',
    DELETE: 'delete',
    TRIGGER: 'trigger',
}
const TASKS = { QUEUE: 'queue', WORKER: 'worker', POOL: 'pool' }

export function createHarness({
    config = {},
    options = {},
    state = {},
    entities = [],
    journal = [],
} = {}) {
    const hookNames = [
        'load', 'loaded', 'import', 'imported',
        'process', 'processed', 'persist', 'persisted',
        'beforeRender', 'render', 'afterRender',
        'beforePostprocess', 'postprocess', 'afterPostprocess',
        'finalize', 'finalized', 'cancel', 'cancelled',
        'complete', 'validate',
    ]
    const hooks = Object.fromEntries(hookNames.map(n => [n, []]))
    const sync = new Map()
    const watchers = []
    const renderTasks = []
    const postprocessTasks = []
    const progress = []
    const logs = []
    const mklog = (level) => (...args) => logs.push({ level, args })
    const logger = {
        info: mklog('info'),
        warn: mklog('warn'),
        error: mklog('error'),
        debug: mklog('debug'),
        trace: mklog('trace'),
        notice: mklog('notice'),
    }

    let nextId = 1
    const journalEntries = journal.map(e => ({ id: nextId++, output: null, context: {}, options: {}, ...e }))

    function addEntry({ entity, operation, context = {}, options = {} }) {
        journalEntries.push({ id: nextId++, entity, operation, context, options, output: null })
    }

    // Stub `runtime.catalog` so catalog.js's module-level findEntity /
    // findEntities (and the queryEntities / readEntity / expandAndProject
    // ops built on them) read from the harness's in-memory `entities`
    // array. Real catalog.js's onInitialized sets up an identical shape
    // — a lowdb instance with .data.entities and a `_.chain(catalog).get('data')`
    // chain — but writes/persists to disk; the stub skips persistence
    // and just wraps the local array. Pushes/mutations to `entities`
    // are reflected on each .value() call because lodash chains hold
    // references.
    //
    // Set on the runtime SINGLETON imported from src/runtime.js — that's
    // what catalog.js sees. Setting it on the harness-local `runtime`
    // object below wouldn't help because plugin code imports the
    // singleton directly. Each createHarness() call overwrites the
    // singleton's `.catalog`, which is fine because tests don't run in
    // parallel within a file.
    const catalogStub = {
        data: { entities },
        // No-op write — real catalog persists to disk via lowdb; the
        // harness never wants disk side-effects. catalog.js's
        // onFinalized hook calls runtime.catalog.write(), so any test
        // that drives the full lifecycle would blow up without this.
        write: async () => {},
    }
    catalogStub.chain = _.chain(catalogStub).get('data')
    realRuntime.catalog = catalogStub

    const runtime = {
        options: { workingFolder: '/tmp/test-mikser', plugins: [], ...options },
        config,
        state,
        hooks,
        engine: { logger },
        catalog: catalogStub,
        // Real lifecycle.js attaches these to the runtime via side-effect
        // on import. The harness doesn't load that module, so reproduce
        // them here against the in-memory journal.
        create: async (entity) => addEntry({ operation: OPERATION.CREATE, entity }),
        update: async (entity) => addEntry({ operation: OPERATION.UPDATE, entity }),
        delete: async ({ id, collection, type }) =>
            addEntry({ operation: OPERATION.DELETE, entity: { id, collection, type } }),
    }
    function updateEntry({ id, entity, output }) {
        const entry = journalEntries.find(e => e.id === id)
        if (!entry) return
        if (entity !== undefined) entry.entity = entity
        if (output !== undefined) entry.output = output
    }
    async function* useJournal(name, operations, signal) {
        progress.push({ name, total: journalEntries.length })
        for (const entry of journalEntries) {
            if (operations?.length && !operations.includes(entry.operation)) continue
            if (signal?.aborted) return
            yield entry
        }
    }

    const core = {
        runtime,
        useLogger: () => logger,

        // Lifecycle registrations
        onLoad: (cb) => hooks.load.push(cb),
        onLoaded: (cb) => hooks.loaded.push(cb),
        onImport: (cb) => hooks.import.push(cb),
        onImported: (cb) => hooks.imported.push(cb),
        onProcess: (cb) => hooks.process.push(cb),
        onProcessed: (cb) => hooks.processed.push(cb),
        onPersist: (cb) => hooks.persist.push(cb),
        onPersisted: (cb) => hooks.persisted.push(cb),
        onBeforeRender: (cb) => hooks.beforeRender.push(cb),
        onRender: (cb) => hooks.render.push(cb),
        onAfterRender: (cb) => hooks.afterRender.push(cb),
        onBeforePostprocess: (cb) => hooks.beforePostprocess.push(cb),
        onPostprocess: (cb) => hooks.postprocess.push(cb),
        onAfterPostprocess: (cb) => hooks.afterPostprocess.push(cb),
        onFinalize: (cb) => hooks.finalize.push(cb),
        onFinalized: (cb) => hooks.finalized.push(cb),
        onCancel: (cb) => hooks.cancel.push(cb),
        onCancelled: (cb) => hooks.cancelled.push(cb),
        onComplete: (cb) => hooks.complete.push(cb),
        onSync: (name, cb) => sync.set(name, cb),
        onValidate: (operations, cb) => hooks.validate.push({ operations, cb }),

        // Entity helpers — write directly to the journal
        createEntity: async (entity) => addEntry({ operation: OPERATION.CREATE, entity }),
        updateEntity: async (entity) => addEntry({ operation: OPERATION.UPDATE, entity }),
        deleteEntity: async ({ id, collection, type }) =>
            addEntry({ operation: OPERATION.DELETE, entity: { id, collection, type } }),
        addEntry,
        addEntries: async (entries) => entries.forEach(addEntry),
        updateEntry,
        useJournal,
        findEntity: async (query) => {
            if (!query) return entities[0]
            if (typeof query === 'function') return entities.find(query)
            return entities.find(e => Object.entries(query).every(([k, v]) => e[k] === v))
        },
        findEntities: async (query) => {
            if (!query) return [...entities]
            if (typeof query === 'function') return entities.filter(query)
            return entities.filter(e => Object.entries(query).every(([k, v]) => e[k] === v))
        },

        // Rendering & postprocessing — capture for assertions
        renderEntities: async (tasks) => renderTasks.push(...tasks),
        postprocessEntities: async (tasks) => postprocessTasks.push(...tasks),
        renderEntity: async () => { },
        postprocessEntity: async () => { },

        // Misc
        watch: (name, folder) => watchers.push({ name, folder }),
        schedule: () => { },
        trackProgress: () => { },
        updateProgress: () => { },
        stopProgress: () => { },

        // Utilities (real implementations)
        matchEntity,
        normalize,
        changeExtension,
        getFormatInfo,
        checksum,
        AbortError,

        constants: { OPERATION, ACTION, TASKS },
    }

    async function runHook(name, ...args) {
        const callbacks = hooks[name] || []
        const results = []
        for (const cb of callbacks) {
            results.push(await cb(...args))
        }
        return results
    }

    async function runSync(name, payload) {
        const handler = sync.get(name)
        if (!handler) return undefined
        return handler(payload)
    }

    return {
        core,
        runtime,
        logger,
        logs,
        sync,
        watchers,
        renderTasks,
        postprocessTasks,
        progress,
        journal: journalEntries,
        hooks,
        runHook,
        runSync,
        addJournalEntry: addEntry,
        constants: { OPERATION, ACTION, TASKS },
    }
}
