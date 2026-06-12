export function mapper(options = {}) {
    return ({
        onProcess,
        useLogger,
        useJournal,
        matchEntity,
        constants: { OPERATION },
    }) => {
        onProcess(async (signal) => {
            const logger = useLogger()

            for (let { match, map, operations = [OPERATION.CREATE, OPERATION.UPDATE] } of options.mappers || []) {
                for await (let { entity } of useJournal('Mapper', operations, signal)) {
                    if (entity && matchEntity(entity, match)) {
                        logger.trace('Mapper: %s', entity.id)
                        try {
                            await map(entity)
                        } catch (err) {
                            logger.error('Mapper error: %s %s', entity.name || entity.id, err.message)
                        }
                    }
                }
            }
        })
    }
}
