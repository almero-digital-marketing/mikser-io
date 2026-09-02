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
    // Whether the FIRST build cycle has finished — i.e. whether the catalog
    // reflects the sources yet. Not the same question as `started`, which is
    // true from the moment the loaded phase ends, before process() has emitted
    // a single entity.
    //
    // Transports need this. The server binds at the end of the loaded phase, by
    // design, so that every plugin has registered its routes first — which also
    // means requests are accepted while the catalog is still empty. A render
    // arriving then cannot resolve its layout (the layouts registry is filled
    // during process()), and a list returns whatever subset happens to exist,
    // which is worse: it is wrong without being an error.
    //
    // Set once and never cleared. Later cycles rebuild against a catalog that
    // is already populated, so they are serveable; flapping this on every watch
    // rebuild would take the endpoint down for every keystroke.
    ready: false,
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

    // What each phase COST, not only what it did.
    //
    // A build report says what was done and never what it took, so a
    // regression is invisible to the one caller that would catch it. The
    // preset fan-out shipped scanning the whole catalog every cycle and ran
    // for four releases before anyone happened to time a rebuild by hand:
    // output was byte-identical, every check passed, and the build was twice
    // as slow.
    //
    // Recorded here because this is the one place every phase passes through,
    // so nothing has to be instrumented plugin by plugin and no phase can be
    // added later without being counted. The console's progress lines are not
    // this: they are per-collection, rounded to whole seconds — so a phase
    // that doubled from 400ms to 800ms prints "0s" either way — and they are
    // suppressed entirely off a TTY, which is every CI run and every --json
    // invocation, meaning the numbers did not exist where a script could read
    // them.
    //
    // Accumulated per phase rather than assigned, because a phase runs more
    // than once in a watch process and a cycle can re-enter one.
    recordPhase(phaseName, ms) {
        if (!phaseName) return
        this.state ??= {}
        const timings = (this.state.timings ??= {})
        const entry = (timings[phaseName] ??= { ms: 0, calls: 0 })
        entry.ms += ms
        entry.calls++
    },

    async callHooks(hooks, signal, phaseName) {
        // Lifecycle methods below pass `phaseName` so introspection
        // tools (mikser-io-mcp's mikser://lifecycle resource, debuggers)
        // can see what's running. Direct callers (tests, plugins driving
        // sub-flows) can omit it.
        if (phaseName) this.phase = phaseName
        const started = performance.now()
        try {
            for (let hook of hooks) {
                if (signal?.aborted) throw new AbortError()
                await hook(signal)
            }
        } finally {
            // In `finally`, so a phase that threw still reports what it spent
            // before throwing — which is exactly the phase someone is about to
            // go looking at.
            this.recordPhase(phaseName, performance.now() - started)
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
        this.ready = true

        // A one-shot run ends here, and the durable store's connection pool
        // would otherwise keep the process alive with nothing left to do.
        // After every hook from every plugin, so nothing can still need it.
        // A watcher or a server is not a one-shot run and keeps its
        // connection — there is another cycle coming.
        if (!this.options?.watch && !this.options?.server) await this.closeDurable?.()
    },

    // A build on request, from a process that is already running.
    //
    // start() runs the import hooks once and every cycle after that only
    // processes what the watcher reported. A forwarded build has to RESCAN:
    // a client that writes a file and immediately asks can beat the inotify
    // event, and draining the queue would then build without the change that
    // prompted the request. Scanning makes it mean what a one-shot means.
    //
    // The gate makes the rescan cheap — an unchanged file is a checksum
    // comparison, not a re-import.
    async rebuild() {
        // Its own cycle in the report, like any other — otherwise a forwarded
        // build's counts are added to whatever the watcher last did.
        this.resetReport?.()
        await this.callHooks(this.hooks.import, undefined, 'import')
        await this.callHooks(this.hooks.imported, undefined, 'imported')
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
