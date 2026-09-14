import fm from 'front-matter'

// Read front matter out of a string.
//
// Exported because more than one place needs the answer and a second
// implementation would drift from this one. mikser-io-layouts calls it when
// it has to fall back to a layout as SYNCED — the file before this plugin has
// lifted its attributes out — and handing that raw text to a renderer is a
// bug with two faces: Handlebars emitted the YAML into the page, and LiquidJS
// refuses to parse it at all, failing at the front-matter line and taking the
// layout down with it.
//
// Returns { attributes, body }, or null when there is no front matter or it
// cannot be parsed. Never throws: a malformed block is the author's problem
// to see, not the build's to die on.
export function readFrontMatter(content) {
    if (typeof content !== 'string' || !fm.test(content)) return null
    try {
        const info = fm(content)
        return info?.attributes ? { attributes: info.attributes, body: info.body } : null
    } catch (err) {
        return { error: err.message }
    }
}

export function frontMatter(options = {}) {
    return ({
        onProcess,
        useLogger,
        useJournal,
        constants: { OPERATION },
    }) => {
        onProcess(async () => {
            const logger = useLogger()
            for await (let { entity } of useJournal('Front matter', [OPERATION.CREATE, OPERATION.UPDATE])) {
                const parsed = readFrontMatter(entity.content)
                if (!parsed) continue
                if (parsed.error) {
                    // Was an uncaught throw, which ended the RUN: js-yaml's
                    // exception went up through the journal loop and out of
                    // the process, printing a stack that named js-yaml and
                    // front-matter and not one word about which file. One
                    // mistyped line in one document stopped every other
                    // document from building, and left the author reading a
                    // parser's internals to find out where.
                    logger.warn(
                        { code: 'front-matter-unreadable', id: entity.id, collection: entity.collection },
                        'Front matter in %s could not be parsed, so it is left as written and its attributes '
                        + 'are not available: %s', entity.id, parsed.error)
                    continue
                }
                entity.meta = Object.assign(entity.meta || {}, parsed.attributes)
                entity.content = parsed.body
                logger.trace('Front matter %s: %s', entity.collection, entity.id)
            }
        })

        // Names this package to the runtime's loaded-plugin record — see
        // plugins.js. A plugin that declares nothing still reports as loaded,
        // but as `package: null`.
        return { module: import.meta.url }
    }
}
