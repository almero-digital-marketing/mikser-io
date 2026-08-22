import runtime from './runtime.js'
import { useLogger } from './engine.js'
import { onLoad } from './lifecycle.js'
import { checksum } from './utils.js'
import path from 'node:path'
import { existsSync } from 'node:fs'

onLoad(async () => {
    const logger = useLogger()
    const configFile = path.resolve(runtime.options.config)
    logger.info('Config: %s', configFile)

    // Stamp the config so a change to it can invalidate the derived cache.
    //
    // Without this, editing mikser.config.js invalidated NOTHING: flipping
    // an option that changes every page's destination reported "36 unchanged"
    // and left the previous output in place. The config was genuinely read —
    // --force applied it immediately — it simply took part in no
    // invalidation, so the only symptom was output that did not match the
    // config, with nothing saying so.
    //
    // The file's bytes only. A config that imports other modules will not
    // notice a change in those, which is a real limit worth knowing rather
    // than a reason to hash the whole module graph.
    try {
        runtime.options.configChecksum = await checksum(configFile)
    } catch {
        // No config file is a legitimate state (defaults all the way down);
        // absent stamp means "nothing to compare", not "changed".
        runtime.options.configChecksum = null
    }

    // Absence is decided by looking for the file, NOT by catching
    // ERR_MODULE_NOT_FOUND from the import.
    //
    // Node raises that same code for "the config file is missing" and for
    // "the config file exists and something IT imports is missing" — a
    // mistyped package name, a renamed local module, a dependency that was
    // never installed. Catching the code cannot tell them apart, and a
    // config with one bad import then loads as `{}`: the build reports "No
    // plugins loaded" and exits 0, a green build with an empty output
    // folder, one line below having printed the config's path.
    //
    // Every other config failure is loud — a syntax error and a throw
    // during evaluation both exit 1. Module resolution is the only one that
    // needs this to stay in line with them.
    if (!existsSync(configFile)) {
        logger.debug('No config file at %s — using defaults', configFile)
    } else {
        // No catch: any failure loading a config that EXISTS is fatal.
        const config = await import(configFile)
        if (typeof config.default == 'function') {
            runtime.config = await config.default(runtime)
        } else if (typeof config.default == 'object') {
            runtime.config = config.default
        }
    }

    // v8 used to walk `runtime.config.plugins` looking for matching
    // `config/<plugin>.config.js` files to merge into `runtime.config`,
    // because plugin entries were strings (names). v9 entries are factory
    // call results (closures or descriptors), and plugin options arrive
    // as factory args — see ADR-0010 — so per-plugin auxiliary config
    // files have nothing to bind to. The loader was removed when the
    // plugins list stopped carrying names.
})
