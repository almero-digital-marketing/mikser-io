import YAML from 'yaml'

export function yaml(options = {}) {
    return ({
        onProcess,
        useLogger,
        useJournal,
        constants: { OPERATION },
    }) => {
        onProcess(async (signal) => {
            const logger = useLogger()

            for await (let { entity } of useJournal('Yaml', [OPERATION.CREATE, OPERATION.UPDATE], signal)) {
                if (entity.content && (entity.format == 'yml' || entity.format == 'yaml')) {
                    try {
                        entity.meta = Object.assign(entity.meta || {}, YAML.parse(entity.content))
                        delete entity.content
                        logger.trace('Yaml %s: %s', entity.collection, entity.id)
                    } catch (err) {
                        logger.error('Yaml error %s: %s %s', entity.collection, entity.id, err.message)
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
