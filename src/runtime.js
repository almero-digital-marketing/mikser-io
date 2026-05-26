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

    async callHooks(hooks, signal) {
        for (let hook of hooks) {
            if (signal?.aborted) throw new AbortError()
            await hook(signal)
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
        await this.callHooks(this.hooks.initialize)
        await this.callHooks(this.hooks.initialized)
        await this.callHooks(this.hooks.load)
        await this.callHooks(this.hooks.loaded)

        await this.callHooks(this.hooks.import)
        await this.callHooks(this.hooks.imported)

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

                await this.callHooks(this.hooks.process, signal)
                await this.callHooks(this.hooks.processed, signal)
                await this.callHooks(this.hooks.persist, signal)
                await this.callHooks(this.hooks.persisted, signal)

                await this.render(signal)
            } catch (e) {
                if (e.name !== 'AbortError') throw e
                for (let hook of this.hooks.cancelled) await hook()
            }
        })
    },

    async render(signal) {
        await this.callHooks(this.hooks.beforeRender, signal)
        await this.callHooks(this.hooks.render, signal)
        await this.callHooks(this.hooks.afterRender, signal)

        await this.postprocess(signal)
    },

    async postprocess(signal) {
        await this.callHooks(this.hooks.beforePostprocess, signal)
        await this.callHooks(this.hooks.postprocess, signal)
        await this.callHooks(this.hooks.afterPostprocess, signal)

        await this.finalize(signal)
    },

    async cancel() {
        this.abortController?.abort()
        await this.callHooks(this.hooks.cancel)
    },

    async finalize(signal) {
        await this.callHooks(this.hooks.finalize, signal)
        await this.callHooks(this.hooks.finalized, signal)
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
            if (!await hook(entry)) return false
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
