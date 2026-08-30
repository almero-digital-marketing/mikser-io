export { default as runtime } from './src/runtime.js'
export * as constants from './src/constants.js'
export * from './src/utils.js'
export * from './src/auth.js'
export * from './src/roles.js'
export * from './src/inventory.js'
export * from './src/report.js'
// The diagnostics behind --explain. Exported so a transport — the MCP tool
// surface, the api plugin's routes — can serve the same structured report the
// CLI formats, rather than each one reimplementing the question.
export * from './src/explain.js'
export * from './src/lifecycle.js'
export * from './src/database/index.js'
export * from './src/journal.js'
export * from './src/catalog.js'
export * from './src/search.js'
export * from './src/write.js'
export * from './src/changeset.js'
export * from './src/refs.js'
export * from './src/manifest.js'
export * from './src/provenance.js'
export * from './src/tools.js'
export * from './src/track.js'
export * from './src/subscriptions.js'
export * from './src/config.js'
export * from './src/plugins.js'
export * from './src/manager.js'
export * from './src/logger.js'
export * from './src/engine.js'
export * from './src/render.js'
export * from './src/source.js'
export * from './src/routes.js'

// Built-in plugin factories. Each takes options and returns the
// (core) => void closure the engine calls at onLoad time. See ADR-0010
// for the v9 plugin shape.
export { api }           from './src/plugins/api.js'
export { assets }        from './src/plugins/assets.js'
export { sources }       from './src/plugins/sources.js'
export { commands }      from './src/plugins/commands.js'
export { data }          from './src/plugins/data.js'
export { documents }     from './src/plugins/documents.js'
export { files }         from './src/plugins/files.js'
export { frontMatter }   from './src/plugins/front-matter.js'
export { json }          from './src/plugins/json.js'
// layouts moved to sibling: import from 'mikser-io-layouts'
export { mapper }        from './src/plugins/mapper.js'
export { observer }      from './src/plugins/observer.js'
export { preview }       from './src/plugins/preview.js'
export { resources }     from './src/plugins/resources.js'
export { shares }        from './src/plugins/shares.js'
export { validator }     from './src/plugins/validator.js'
export { yaml }          from './src/plugins/yaml.js'

// Built-in renderers. v9 factory shape returns the descriptor that the
// loader stores in `runtime.renderers`; the same module also still
// exports `load`/`render` at the top level so Piscina worker dispatch
// can resolve via dynamic import. ADR-0010.
// Renderers — these have a render() and turn an entity into a file.
export { renderHbs }    from './src/plugins/render/hbs.js'
export { renderPreset } from './src/plugins/render/preset.js'

// Template helpers — these only install functions on `runtime` for templates
// to call. They render nothing, and the names say so: two of the six
// factories in this folder are renderers and four are not, so each is named
// after the job it does rather than the object it concerns. Naming them all
// `render*` invites adding renderPreset() expecting a helper and watching
// every page render throw. There are no aliases for the older names.
export { assetUrlHelper }    from './src/plugins/render/asset.js'
export { hrefUrlHelpers }    from './src/plugins/render/href.js'
export { resourceUrlHelper } from './src/plugins/render/resource.js'
export { fileHelpers }       from './src/plugins/render/file.js'

