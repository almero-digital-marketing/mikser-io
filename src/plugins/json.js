export function json(options = {}) {
    return ({
        onProcess,
        useLogger,
        useJournal,
        constants: { OPERATION },
    }) => {
        onProcess(async () => {
            const logger = useLogger()

            for await (let { entity } of useJournal('Json', [OPERATION.CREATE, OPERATION.UPDATE])) {
                if (entity.content && entity.format == 'json') {
                    entity.meta = Object.assign(entity.meta || {}, JSON.parse(entity.content))
                    delete entity.content
                    logger.trace('Json %s: %s', entity.collection, entity.id)
                }
            }
        })
    }
}
