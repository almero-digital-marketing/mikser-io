import runtime from './runtime.js'
import { useLogger } from './engine.js'
import { onLoad } from './lifecycle.js'
import path from 'node:path'

onLoad(async () => {
    const logger = useLogger()
    const configFile = path.resolve(runtime.options.config)
    logger.info('Config: %s', configFile)
    try {
        const config = await import(configFile)
        if (typeof config.default == 'function') {
            runtime.config = await config.default(runtime)
        } else if (typeof config.default == 'object') {
            runtime.config = config.default
        }
    } catch (err) {
        if (err.code != 'ERR_MODULE_NOT_FOUND') throw err
    }

    // v8 used to walk `runtime.config.plugins` looking for matching
    // `config/<plugin>.config.js` files to merge into `runtime.config`,
    // because plugin entries were strings (names). v9 entries are factory
    // call results (closures or descriptors), and plugin options arrive
    // as factory args — see ADR-0010 — so per-plugin auxiliary config
    // files have nothing to bind to. The loader was removed when the
    // plugins list stopped carrying names.
})
