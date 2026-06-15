import { Mutex } from 'await-semaphore'
import { AbortError } from './utils.js'

const runtime = {
    stamp: Date.now(),
    processTime: undefined,
    engine: {},
    options: {
        plugins: []
    },
    config: {},
    journal: [],
    validators: [],
    started: false,
    // Name of the lifecycle phase currently executing — null between
    // phases. Set inside start() / process() / render() etc. before
    // each callHooks(), cleared on completion. Read by mikser-io-mcp's
    // `mikser://lifecycle` resource and surfaced via runtime.engine.logger
    // trace logs.
    phase: null,
    mutex: new Mutex(),
    abortController: undefined,
    hooks: {
        initialize: [],
        initialized: [],
        load: [],
        loaded: [],
        import: [],
        validate: [],
        imported: [],
        process: [],
        processed: [],
        persist: [],
        persisted: [],
        beforeRender: [],
        render: [],
        afterRender: [],
        beforePostprocess: [],
        postprocess: [],
        afterPostprocess: [],
        cancel: [],
        cancelled: [],
        finalize: [],
        finalized: [],
        sync: [],
        completed: [],
    },

    async callHooks(hooks, signal, phaseName) {
        // Lifecycle methods below pass `phaseName` so introspection
        // tools (mikser-io-mcp's mikser://lifecycle resource, debuggers)
        // can see what's running. Direct callers (tests, plugins driving
        // sub-flows) can omit it.
        if (phaseName) this.phase = phaseName
        try {
            for (let hook of hooks) {
                if (signal?.aborted) throw new AbortError()
                await hook(signal)
            }
        } finally {
            if (phaseName) this.phase = null
        }
    },

    addHook(name, hook) {
        if (!this.hooks[name]) throw new Error(`Unknown hook: ${name}`)
        this.hooks[name].push(hook)
        return hook
    },

    removeHook(name, hook) {
        if (!this.hooks[name]) throw new Error(`Unknown hook: ${name}`)
        const idx = this.hooks[name].indexOf(hook)
        if (idx > -1) this.hooks[name].splice(idx, 1)
    },

    async start() {
        await this.callHooks(this.hooks.initialize, undefined, 'initialize')
        await this.callHooks(this.hooks.initialized, undefined, 'initialized')
        await this.callHooks(this.hooks.load, undefined, 'load')
        await this.callHooks(this.hooks.loaded, undefined, 'loaded')

        await this.callHooks(this.hooks.import, undefined, 'import')
        await this.callHooks(this.hooks.imported, undefined, 'imported')

        this.started = true
        await this.process()
    },

    async process() {
        if (this.abortController?.signal.aborted) return
        else if (this.abortController) {
            await this.cancel()
        }
        await this.mutex.use(async () => {
            try {
                this.abortController = new AbortController()
                const { signal } = this.abortController

                await this.callHooks(this.hooks.process, signal, 'process')
                await this.callHooks(this.hooks.processed, signal, 'processed')
                await this.callHooks(this.hooks.persist, signal, 'persist')
                await this.callHooks(this.hooks.persisted, signal, 'persisted')

                await this.render(signal)
            } catch (e) {
                if (e.name !== 'AbortError') throw e
                this.phase = 'cancelled'
                for (let hook of this.hooks.cancelled) await hook()
                this.phase = null
            }
        })
    },

    async render(signal) {
        await this.callHooks(this.hooks.beforeRender, signal, 'beforeRender')
        await this.callHooks(this.hooks.render, signal, 'render')
        await this.callHooks(this.hooks.afterRender, signal, 'afterRender')

        await this.postprocess(signal)
    },

    async postprocess(signal) {
        await this.callHooks(this.hooks.beforePostprocess, signal, 'beforePostprocess')
        await this.callHooks(this.hooks.postprocess, signal, 'postprocess')
        await this.callHooks(this.hooks.afterPostprocess, signal, 'afterPostprocess')

        await this.finalize(signal)
    },

    async cancel() {
        this.abortController?.abort()
        await this.callHooks(this.hooks.cancel, undefined, 'cancel')
    },

    async finalize(signal) {
        await this.callHooks(this.hooks.finalize, signal, 'finalize')
        await this.callHooks(this.hooks.finalized, signal, 'finalized')
    },

    async sync(operation) {
        let synced
        for (let hook of this.hooks.sync) {
            const result = await hook(operation)
            if (result === true) {
                synced = true
            } else if (result === false && !synced) {
                synced = false
            }
        }
        return synced === undefined || synced
    },

    async validate(entry) {
        for (let hook of this.validators) {
            // Only an explicit `false` rejects the entry. A validator
            // that returns undefined is abstaining — it doesn't care
            // about this operation — and abstain means pass. The old
            // truthiness check (`if (!await hook(entry))`) treated
            // undefined as rejection, so any validator scoped to a
            // subset of operations (e.g. onValidate([CREATE, UPDATE]))
            // silently dropped every entry it never opted into —
            // notably DELETEs, which then never propagated.
            if (await hook(entry) === false) return false
        }
        return true
    },

    async complete(entry) {
        let success = true
        for (let hook of this.hooks.completed) {
            if (await hook(entry) === false) success = false
        }
        entry.success = success
    }
}

export default runtime
