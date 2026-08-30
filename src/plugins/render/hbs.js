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

// Static reference scan for `mikser-io-layouts`'s inspect() primitive.
// Walks the Handlebars AST (no regex) and returns the variables / partials
// / iterations / helpers the template source references. Authoring-time
// view of "what could this template reference"; the precise runtime
// answer to "what did it actually touch" lives in mikser-io's manifest.
//
// Returned shape matches the parseReferences contract: optional fields,
// renderer-flavored. Engines that have richer semantics (block helpers,
// helper args) can surface them under additional keys.
export function parseReferences(source) {
    if (typeof source !== 'string' || !source) {
        return { variables: [], partials: [], iterations: [], assigns: [], optional: [], helpers: [] }
    }
    let ast
    try {
        ast = handlebars.parse(source)
    } catch (err) {
        // Author-side parse failure shouldn't kill inspect(). Surface
        // the message and an empty result.
        return { variables: [], partials: [], iterations: [], assigns: [], optional: [], helpers: [], parseError: err.message }
    }

    const variables  = new Set()
    // Keyed by name and merged across call sites, so one partial rendered
    // eight times is one entry holding the union of what it is ever passed.
    const partials   = new Map()
    const iterations = []
    const helpers    = new Set()
    // Keys the template reads only behind a guard, so their absence is
    // tolerated rather than a gap. The same distinction liquid draws: a
    // contract that reports every key as required makes an optional section
    // look like a missing one, and an editor chases a field the page never
    // needed.
    const optional   = new Set()

    // Handlebars has no file-scoped assignment; aliases come from block
    // params (`as |x|`), which are scoped to their block. That scope is known
    // HERE and nowhere downstream, so paths are resolved as they are recorded
    // rather than exported for a caller to guess at.
    const deref = (path, scope) => {
        if (!path) return path
        const [head, ...rest] = String(path).split('.')
        const base = scope[head]
        return base ? [base, ...rest].join('.') : path
    }
    const record = (path, scope, guarded = false) => {
        const resolved = deref(path, scope)
        if (resolved) {
            variables.add(resolved)
            if (guarded) optional.add(resolved)
        }
        return resolved
    }
    // A partial argument's path, or null when it is a literal — a quoted
    // string is a value the caller supplied and depends on nothing.
    const pathOfValue = (v) => (v?.type === 'PathExpression' ? v.original : null)

    // Built-in block helpers that aren't user-defined and shouldn't
    // pollute the helpers set. `each` shows up as an iteration instead.
    const BUILTIN_BLOCKS = new Set(['if', 'unless', 'each', 'with', 'lookup'])

    function visit(node, scope = {}, guarded = false) {
        if (!node || typeof node !== 'object') return
        switch (node.type) {
            case 'Program':
                for (const child of node.body ?? []) visit(child, scope, guarded)
                break
            case 'MustacheStatement':
                // {{path.to.var}} — record the path.
                if (node.path?.type === 'PathExpression' && !BUILTIN_BLOCKS.has(node.path.original)) {
                    record(node.path.original, scope, guarded)
                }
                // {{helper arg1 arg2}} with args → it's a helper call.
                if (node.params?.length && node.path?.original && !BUILTIN_BLOCKS.has(node.path.original)) {
                    helpers.add(node.path.original)
                }
                // Walk param paths too — they're variable refs.
                for (const param of node.params ?? []) {
                    if (param?.type === 'PathExpression') record(param.original, scope, guarded)
                    if (param?.type === 'SubExpression') visit(param, scope, guarded)
                }
                break
            case 'SubExpression':
                if (node.path?.original && !BUILTIN_BLOCKS.has(node.path.original)) {
                    helpers.add(node.path.original)
                }
                for (const param of node.params ?? []) {
                    if (param?.type === 'PathExpression') record(param.original, scope)
                    if (param?.type === 'SubExpression') visit(param, scope)
                }
                break
            case 'BlockStatement': {
                // Block params bind inside the block only, so the child scope
                // is a copy: `{{#each a as |x|}}` must not leak `x` to whatever
                // follows the block.
                const inner = { ...scope }
                const blockParam = node.program?.blockParams?.[0] ?? null
                if (node.path?.original === 'each') {
                    // {{#each posts as |post|}}…{{/each}}
                    const collection = node.params?.[0]?.type === 'PathExpression'
                        ? node.params[0].original
                        : null
                    if (collection) {
                        const resolved = record(collection, scope)
                        iterations.push({ item: blockParam ?? '(each)', collection })
                        // `[]` marks an ELEMENT. Without it `{{#each cases as
                        // |c|}}{{c.specs}}` reports `cases.specs`, a key that
                        // exists on no document — the specs are on each case.
                        if (blockParam) inner[blockParam] = `${resolved}[]`
                    }
                } else if (BUILTIN_BLOCKS.has(node.path?.original)) {
                    // {{#if cond}}/{{#unless cond}}/{{#with x}} — record the
                    // condition path as a variable ref.
                    for (const param of node.params ?? []) {
                        if (param?.type === 'PathExpression') {
                            const resolved = record(param.original, scope)
                            // {{#with data.meta.hero as |hero|}} — the same
                            // aliasing liquid spells `{% assign %}`.
                            if (node.path.original === 'with' && blockParam) inner[blockParam] = resolved
                        }
                        if (param?.type === 'SubExpression') visit(param, scope)
                    }
                } else {
                    // User-defined block helper.
                    if (node.path?.original) helpers.add(node.path.original)
                    for (const param of node.params ?? []) {
                        if (param?.type === 'PathExpression') record(param.original, scope)
                        if (param?.type === 'SubExpression') visit(param, scope)
                    }
                }
                // `if` and `unless` are what make the content inside them
                // optional; `each` and `with` are not — they narrow scope, and
                // a key read inside one is read whenever the block runs at all.
                //
                // The CONDITION itself stays required: `{{#if hero}}` reads
                // `hero` unconditionally to decide, exactly as liquid's `case`
                // subject does.
                const guards = node.path?.original === 'if' || node.path?.original === 'unless'
                if (node.program) visit(node.program, inner, guarded || guards)
                if (node.inverse) visit(node.inverse, scope, guarded || guards)
                break
            }
            case 'PartialStatement':
            case 'PartialBlockStatement': {
                if (node.name?.type === 'PathExpression') {
                    const name = node.name.original
                    // A handlebars partial always renders in the caller's
                    // context, so anything it reads resolves against the scope
                    // at the call site.
                    const entry = partials.get(name) ?? { name, args: {}, aliases: [], inherits: true }
                    // The arguments the partial is called WITH. Dropping these
                    // was the hole: `{{> ui/btn label=r.more}}` makes this
                    // template depend on `r.more`, and a contract built from
                    // one file could not see a key consumed one file down.
                    for (const pair of node.hash?.pairs ?? []) {
                        const path = pathOfValue(pair.value)
                        if (path) entry.args[pair.key] = record(path, scope)
                    }
                    // `{{> ui/btn someContext}}` — a positional context rather
                    // than named arguments. It rebinds the partial's root, so
                    // it is reported as an alias with no name to bind to.
                    for (const param of node.params ?? []) {
                        const path = pathOfValue(param)
                        if (path) entry.aliases.push({ from: record(path, scope), to: null })
                    }
                    partials.set(name, entry)
                }
                if (node.program) visit(node.program, scope)
                if (node.inverse) visit(node.inverse, scope)
                break
            }
        }
    }
    visit(ast)

    return {
        variables:  Array.from(variables).sort(),
        partials:   Array.from(partials.values()).sort((a, b) => a.name.localeCompare(b.name)),
        iterations,
        // Handlebars has no file-scoped assignment; its aliases are block
        // params, already resolved above. Present and empty so every engine
        // returns the same shape and no caller has to branch on the engine.
        assigns:    [],
        // Read only behind `{{#if}}` / `{{#unless}}`, so absence is tolerated.
        optional:   Array.from(optional).sort(),
        helpers:    Array.from(helpers).sort(),
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

// v9 factory shape — returns a renderer descriptor that the v9
// loader (src/plugins.js) registers under `runtime.renderers`. The
// top-level `load`/`render` exports above stay too so render workers
// (Piscina) can still resolve via dynamic import without going
// through the registry. ADR-0010.
export function renderHbs(options = {}) {
    return {
        name: options.name ?? 'hbs',
        options,
        load,
        render,
        parseReferences,
    }
}