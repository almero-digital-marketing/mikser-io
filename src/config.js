import runtime from './runtime.js'
import { useLogger } from './engine/index.js'
import { onLoad } from './lifecycle.js'
import { checksum, checksumOf } from './utils.js'
import path from 'node:path'
import nodeModule from 'node:module'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

// Every local module the config actually pulls in, recorded as it loads.
//
// The stamp used to be the entry file's bytes alone, and that is inverted
// against significance the moment a project has more than one config — which
// is as soon as it has a dev one and a prod one. Both import the module that
// decides how the site is built; neither IS that module. So a comment in the
// thin wrapper wiped the catalog, and rewriting the pipeline that processes
// every asset changed nothing and rebuilt nothing, on a green build.
//
// Node's own loader hook rather than parsing import statements. The resolver
// already knows the answer exactly, including transitive imports and dynamic
// ones that actually ran, and a regex over source is the kind of thing that
// silently misses a case — which here means silently not invalidating, the
// exact failure being fixed.
//
// Scoped to files under the config's own directory. `node_modules` is not
// enough of a filter on its own: a workspace symlinks its siblings, so
// `mikser-io` itself resolves to a real path outside node_modules and the
// engine's entire source tree would land in the stamp.
function captureConfigGraph(root) {
    const files = new Set()
    let capturing = false

    // Node 22.15+. Older runtimes keep the previous behaviour rather than a
    // worse guess, and `configCoverage` says which one is in force.
    if (typeof nodeModule.registerHooks !== 'function') {
        return { files, supported: false, start() {}, stop() {} }
    }
    nodeModule.registerHooks({
        load(url, context, next) {
            if (capturing && url.startsWith('file:')) {
                const file = fileURLToPath(url)
                if (!file.includes(`${path.sep}node_modules${path.sep}`)
                    && !path.relative(root, file).startsWith('..')) {
                    files.add(file)
                }
            }
            return next(url, context)
        },
    })
    return {
        files,
        supported: true,
        start() { capturing = true },
        stop() { capturing = false },
    }
}

// One stamp over the whole set, path-qualified and order-independent.
//
// Path as well as content, so moving a module between two files with the same
// bytes still counts as a change.
async function stampGraph(files) {
    const parts = []
    for (const file of [...files].sort()) {
        try {
            parts.push(`${file}:${await checksum(file)}`)
        } catch { /* vanished between load and stat — the next cycle sees it */ }
    }
    return parts.length ? checksumOf(parts.join('\n')) : null
}

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
    // Computed AFTER the import, from what the import actually loaded — see
    // captureConfigGraph. Before it, there is nothing to hash but the entry
    // file, which is the bug.
    const graph = captureConfigGraph(path.dirname(configFile))

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
        // Absent by DEFAULT is a project without a config, which is allowed.
        // Absent after the caller named it is a typo, and continuing on
        // defaults answers a question nobody asked: the build prints the path
        // it did not find, reports "No plugins loaded", writes nothing and
        // exits 0. That is the same green-build-empty-output failure the
        // module-resolution note above exists to prevent, reached by the
        // shorter route of getting the path wrong.
        if (runtime.options.configExplicit) {
            throw new Error(`No config file at ${configFile} — it was named with --config, so this is a wrong `
                + 'path rather than a project without a config. A relative --config resolves against the '
                + `working folder (${runtime.options.workingFolder}), so it does not repeat it.`)
        }
        logger.debug('No config file at %s — using defaults', configFile)
    } else {
        // No catch: any failure loading a config that EXISTS is fatal.
        graph.start()
        try {
            const config = await import(configFile)
            if (typeof config.default == 'function') {
                runtime.config = await config.default(runtime)
            } else if (typeof config.default == 'object') {
                runtime.config = config.default
            }
        } finally {
            graph.stop()
        }
    }

    // The stamp, and what it covers.
    //
    // Coverage is published because "I edited the build and nothing rebuilt"
    // was only answerable by experiment. It is the difference between a limit
    // that is documented and one that is visible at the moment it bites.
    //
    // Absent stamp means "nothing to compare", not "changed" — no config file
    // is a legitimate state, defaults all the way down.
    const covered = [...graph.files]
    runtime.options.configCoverage = {
        files: covered.sort(),
        // False on a runtime without loader hooks, where the stamp is the
        // entry file alone and a change to anything it imports is invisible.
        complete: graph.supported,
    }
    if (covered.length) {
        runtime.options.configChecksum = await stampGraph(covered)
        logger.debug('Config checksum spans %d file(s): %s', covered.length, covered.join(', '))
    } else {
        try {
            runtime.options.configChecksum = existsSync(configFile) ? await checksum(configFile) : null
        } catch {
            runtime.options.configChecksum = null
        }
    }

    // Said once, at the only moment it can be acted on. A project whose build
    // lives in a module the stamp cannot reach gets a rebuild it did not ask
    // for rather than silence it cannot diagnose.
    if (existsSync(configFile) && !graph.supported) {
        logger.warn({ code: 'config-coverage-partial' },
            'This Node build has no module loader hooks, so the config stamp covers %s alone. Editing a module '
            + 'it imports will NOT invalidate anything — run with --force after such a change.', configFile)
    }

    // Nothing else is loaded. There is deliberately no `config/<plugin>
    // .config.js` channel: plugin options arrive as factory arguments
    // (ADR-0010), and an entry in `plugins` is a factory call result — a
    // closure or a descriptor — carrying no name to bind an auxiliary file
    // to. A plugin wanting file-based config reads it itself.
})
