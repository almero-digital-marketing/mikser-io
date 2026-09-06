import fm from 'front-matter'

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
                if (entity.content && fm.test(entity.content)) {
                    const info = fm(entity.content)
                    if (info.attributes) {
                        entity.meta = Object.assign(entity.meta || {}, info.attributes)
                        entity.content = info.body
                        logger.trace('Front matter %s: %s', entity.collection, entity.id)
                    }
                }
            }
        })

        // Names this package to the runtime's loaded-plugin record — see
        // plugins.js. A plugin that declares nothing still reports as loaded,
        // but as `package: null`.
        return { module: import.meta.url }
    }
}
