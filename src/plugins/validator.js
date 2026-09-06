export function validator(options = {}) {
    return ({
        onLoad,
        onValidate,
        matchEntity,
        constants: { OPERATION },
    }) => {
        onLoad(() => {
            for (let { match, validate, operations = [OPERATION.CREATE, OPERATION.UPDATE] } of options.validators || []) {
                onValidate(operations, async entry => {
                    if (entry.entity?.meta && matchEntity(entry.entity, match)) {
                        return await validate(entry.entity)
                    }
                })
            }
        })

        // Names this package to the runtime's loaded-plugin record — see
        // plugins.js. A plugin that declares nothing still reports as loaded,
        // but as `package: null`.
        return { module: import.meta.url }
    }
}
