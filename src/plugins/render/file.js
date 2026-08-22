import { readFileSync } from 'node:fs'
import { globby } from 'globby'

export function load({ runtime }) {
    runtime.readFile = (file) => {
        const relativePath = file.name || file
        return readFileSync(relativePath, { encoding: 'utf8' })
    }
    runtime.jsonFile = (file) => {
        const relativePath = file.name || file
        return JSON.parse(readFileSync(relativePath, { encoding: 'utf8' }))
    }
    runtime.glob = (pattern, options = {}) => {
        return globby.sync(pattern, options)
    }

    // Stringify an arbitrary value as a JSON literal. Use with the
    // triple-stash form ({{{json …}}}) when embedding inside a
    // <script> block or HTML attribute — Handlebars's HTML-escape
    // would otherwise turn quotes into &quot; and break the literal.
    //
    //   <script>const id = {{{json document.id}}};</script>
    //
    // No SafeString wrap on purpose — that would silently make
    // double-stash also output raw, which is the foot-gun when the
    // template author thought they were getting escaping.
    runtime.json = (value) => JSON.stringify(value)

    // Build an array from positional args. Lets a template construct
    // an empty array ({{array}}) or a literal list ({{array 1 2 3}})
    // without a custom helper. Handy as the fallback value in
    // expressions like (default document.meta.tags (array)).
    //
    // Handlebars passes a trailing `options` object to every helper
    // call; we strip it so the array doesn't end up with a stray
    // hash/data/fn object as its last element.
    runtime.array = (...args) => {
        if (args.length && typeof args[args.length - 1] === 'object'
            && args[args.length - 1] !== null
            && 'hash' in args[args.length - 1]) {
            args = args.slice(0, -1)
        }
        return args
    }
}

export function fileHelpers(options = {}) {
    return { name: options.name ?? 'file', options, load }
}
