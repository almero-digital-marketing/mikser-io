

export class AbortError extends Error {
    constructor(message) {
        super();
        this.name = 'AbortError';
        this.message = message;
    }
}

// Flatten template-helper args into a single human-readable message.
// Handlebars helpers receive a trailing options object (it has a `.hash`
// property) which we drop. Liquid filters and Eta calls don't.
export function formatLogArgs(args) {
    if (args.length && typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null && 'hash' in args[args.length - 1]) {
        args = args.slice(0, -1)
    }
    return args
        .map(arg => {
            if (arg == null) return String(arg)
            if (typeof arg === 'object') {
                try { return JSON.stringify(arg) } catch { return String(arg) }
            }
            return String(arg)
        })
        .join(' ')
}

// Build a compact "[layouts/foo.hbs:12:4]" suffix from whatever the
// underlying template engine attached to its thrown error. Renderer
// plugins are expected to set `err.layoutUri` (and optionally `err.line` /
// `err.column`) before rethrowing.
export function formatErrorContext(entity, err, options) {
    const layoutUri = err?.layoutUri || entity?.layout?.uri || entity?.layout?.id
    if (!layoutUri) return ''
    const workingFolder = options?.workingFolder
    const rel = workingFolder && layoutUri.startsWith(workingFolder + '/')
        ? layoutUri.slice(workingFolder.length + 1)
        : layoutUri
    const line = err?.line ?? err?.lineNumber
    const column = err?.column ?? err?.col
    let pos = ''
    if (line) pos = `:${line}${column ? ':' + column : ''}`
    return ` [${rel}${pos}]`
}
