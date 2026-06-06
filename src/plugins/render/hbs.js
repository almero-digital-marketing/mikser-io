import handlebars from 'handlebars'
import helpers from '@budibase/handlebars-helpers'
import dayjs from 'dayjs'

export function load({ config, runtime, context }) {
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
    for (let partial in context.layouts) {
        if (context.layouts[partial].template == 'hbs' && partial.indexOf('partials') == 0) {
            // Layout bodies live on the entity (populated by the layouts
            // plugin at sync time, then stripped by front-matter at
            // onProcess). One source of truth, no re-read from disk.
            handlebars.registerPartial(partial, context.layouts[partial].content ?? '')
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

export async function render({ entity, runtime }) {
    const source = entity.layout.content ?? ''
    const sandbox = {}
    for (let helper in runtime) {
        if (typeof (runtime[helper]) == 'function') {
            handlebars.registerHelper(helper, runtime[helper])
        } else {
            sandbox[helper] = runtime[helper]
        }
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