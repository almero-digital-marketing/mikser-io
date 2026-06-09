import handlebars from 'handlebars'
import helpers from '@budibase/handlebars-helpers'
import dayjs from 'dayjs'

// Walk a compiled Handlebars program for partial-reference nodes and
// yield each partial name. Handlebars' AST has two relevant node types:
// `PartialStatement` (e.g. `{{> header}}`) and `PartialBlockStatement`
// (e.g. `{{#> wrapper}}…{{/wrapper}}`). We also recurse into block
// statements so partials inside `{{#each}}` / `{{#if}}` get reported.
//
// Dynamic partial names (e.g. `{{> (lookup type)}}`) where the AST node
// is a SubExpression are skipped — we can't resolve them statically.
// Coarser invalidation is the price; correctness still holds because
// any change to a possible target entity will mutate refs and force
// the consumer to re-render anyway.
function* walkPartials(node) {
    if (!node || typeof node !== 'object') return
    switch (node.type) {
        case 'PartialStatement':
        case 'PartialBlockStatement':
            if (node.name?.type === 'PathExpression') {
                yield node.name.original
            }
            if (node.program) yield* walkPartials(node.program)
            if (node.inverse) yield* walkPartials(node.inverse)
            break
        case 'Program':
            for (const child of node.body ?? []) yield* walkPartials(child)
            break
        case 'BlockStatement':
            if (node.program) yield* walkPartials(node.program)
            if (node.inverse) yield* walkPartials(node.inverse)
            break
    }
}

export function load({ config, runtime, state }) {
    handlebars.registerHelper(helpers(config?.helpers || [
        'array',
        'collection',
        'object',
        'comparison',
        'match',
        'math',
        'number',
        'regex',
        'string',
        'url'
    ]))
    // Partials are layouts whose name starts with `partials/`. The
    // layouts plugin populates `runtime.state.layouts.layouts` as a
    // name → layout-entity map at sync time, and that map is passed
    // through as `state.layouts.layouts` to renderer plugins. Same
    // source of truth: the in-memory layouts index.
    //
    // Also build `runtime.hbsPartialIds` so the render path can resolve
    // `partialName → entityId` cheaply when reporting partial-edge deps
    // to the manifest via the track API.
    runtime.hbsPartialIds = {}
    const layouts = state?.layouts?.layouts ?? {}
    for (let partial in layouts) {
        if (layouts[partial].template == 'hbs' && partial.indexOf('partials') == 0) {
            handlebars.registerPartial(partial, layouts[partial].content ?? '')
            runtime.hbsPartialIds[partial] = layouts[partial].id
        }
    }
    handlebars.registerHelper('date', (date, format) => {
        if (!date) return ''
        if (typeof format !== 'string') format = 'YYYY-MM-DD'
        return dayjs(date).format(format)
    })

    handlebars.registerHelper('url', function(obj, options) {
        // Called as {{url}} with no args — obj is the Handlebars options object,
        // so read url from the current context (this)
        if (!options) return this?.url ?? ''
        if (!obj) return ''
        if (typeof obj === 'string') return obj
        return obj.url ?? ''
    })

    runtime.hbs = (source, sandbox) => {
        const template = handlebars.compile(source)
        return template(sandbox)
    }
}

export async function render({ entity, runtime, track }) {
    const source = entity.layout.content ?? ''
    const sandbox = {}
    for (let helper in runtime) {
        if (typeof (runtime[helper]) == 'function') {
            handlebars.registerHelper(helper, runtime[helper])
        } else {
            sandbox[helper] = runtime[helper]
        }
    }
    // Report partial edges to the engine BEFORE running the template,
    // so a runtime error inside a partial doesn't lose the dep info.
    // Parse runs once cheap; compile happens again inside runtime.hbs.
    if (track && runtime.hbsPartialIds) {
        try {
            const ast = handlebars.parse(source)
            const seen = new Set()
            for (const name of walkPartials(ast)) {
                if (seen.has(name)) continue
                seen.add(name)
                const id = runtime.hbsPartialIds[name]
                if (id) track.partial(id)
            }
        } catch { /* parse errors surface in the render call below */ }
    }
    try {
        return runtime.hbs(source, sandbox)
    } catch (err) {
        // Handlebars compile errors expose `.lineNumber`/`.column`; runtime
        // errors (missing helper, etc.) don't, but we still know the layout.
        // Parse errors put the line in the message as "Parse error on line N".
        if (err.lineNumber != null && err.line == null) err.line = err.lineNumber
        if (err.line == null && typeof err.message === 'string') {
            const m = err.message.match(/on line (\d+)/i)
            if (m) err.line = Number(m[1])
        }
        err.layoutUri = entity.layout.uri
        throw err
    }
}