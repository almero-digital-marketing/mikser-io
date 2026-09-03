// What one plugin offers another, without either importing the other.
//
// Plugins reached into each other through `runtime.options`:
//
//       runtime.options.layouts.inspect      read by core
//       runtime.options.schemas.lookup       read by forms, layouts, ocr
//       runtime.options.preview.get          read by core, layouts, mcp
//       runtime.options.roles                read by mcp
//
// It worked, and it was wrong in a specific way: mikser-io-mcp and
// mikser-io-layouts were coupled through a shared mutable object neither of
// them owns. Nothing declared the relationship, so nothing could check it —
// a consumer's `if (!runtime.options.layouts) return` reads as a null check
// but is really an is-that-plugin-installed check wearing a disguise.
//
// It also cost the two best names. Commander derives an option's property
// from its long flag, so `--layouts <folder>` writes runtime.options.layouts
// — on top of the inspect API, after the load phase, with the failure
// surfacing three plugins away.
//
// This covers ONE direction: one plugin provides, others consume. The other
// direction — many plugins adding to a surface one plugin serves — already
// has a home for each surface it applies to: tools.js, routes.js, roles.js
// and cli.js. A generic contribution registry would be a fifth way to do
// what those four already do.
//
// So: core holds the registry, and neither side names the other.

const services = new Map()        // name -> { api, plugin }

// Publish an API under a name other plugins can ask for.
//
//   provideService('layouts', { inspect }, { plugin: 'mikser-io-layouts' })
//
// Call at factory-eval time, before any hook runs, so that a consumer's
// onLoaded can already see it. Same rule as cliOption: declare during
// construction, read during a hook.
export function provideService(name, api, { plugin } = {}) {
    if (!name || !api) return
    const existing = services.get(name)
    if (existing) {
        // Two providers for one name is a configuration mistake, not a
        // precedence question. Last-write-wins would hand consumers whichever
        // plugin happened to be constructed later — the exact order
        // dependence this registry exists to remove. Thrown rather than
        // logged: this runs at factory-eval time, where plugins.js already
        // catches, names the plugin and carries on with the rest.
        throw new Error(
            `Service "${name}" is already provided by ${existing.plugin ?? 'another plugin'}` +
            `${plugin ? `; ${plugin} tried to provide it too` : ''}. Only one plugin may provide a service.`)
    }
    services.set(name, { api, plugin })
}

// Ask for a service. Returns undefined when nothing provides it, so a
// consumer degrades on purpose:
//
//   const layouts = useService('layouts')
//   if (!layouts) return        // layouts plugin isn't installed
//
// This replaces `if (!runtime.options.mcp) return`, which read as a null
// check but was really an is-that-plugin-loaded check wearing a disguise.
export function useService(name) {
    return services.get(name)?.api
}

// Ask for a service the caller cannot work without. Throws naming the
// package that provides it, because "cannot read properties of undefined"
// does not tell anyone which npm install they are missing.
export function requireService(name, { from } = {}) {
    const found = services.get(name)
    if (found) return found.api
    throw new Error(
        `No plugin provides the "${name}" service` +
        (from ? `. Install ${from} and add it to the plugins array.` : '.'))
}

// Drop everything. The registries are module state, which outlives a single
// run inside one process — tests, and the watcher's repeated config reloads.
export function resetServices() {
    services.clear()
}

// What is registered right now. For --explain and the MCP inventory tool:
// "which plugin provides what" is a question people ask.
export function serviceInventory() {
    return [...services].map(([name, { plugin }]) => ({ name, plugin }))
}
