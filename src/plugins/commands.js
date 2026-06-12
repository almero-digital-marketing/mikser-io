import { execaCommand } from 'execa'
import lineReader from 'line-reader'
import { promisify } from 'util'
import _ from 'lodash'

export function commands(options = {}) {
    return ({
        runtime,
        useLogger,
        onLoad,
        onLoaded,
        onImport,
        onImported,
        onProcess,
        onProcessed,
        onPersist,
        onPersisted,
        onCancel,
        onCancelled,
        onBeforeRender,
        onRender,
        onAfterRender,
        onFinalize,
        onFinalized,
    }) => {
        const eachLine = promisify(lineReader.eachLine)
        const running = {}

        async function executeCommand(command) {
            const logger = useLogger()
            if (_.endsWith(command, '&')) {
                command = command.slice(0, -1)
                if (!running[command]) {
                    logger.info('Command: %s', command, runtime.options.wokrkingFolder)
                    const subprocess = execaCommand(command, { cwd: runtime.options.wokrkingFolder, all: true })
                    eachLine(subprocess.all, line => logger.info(line))
                    running[command] = subprocess
                        .then(() => delete running[command])
                        .catch(err => logger.error(err, 'Command error'))
                }
            } else {
                logger.info('Command: %s', command, runtime.options.wokrkingFolder)
                const subprocess = execaCommand(command, { cwd: runtime.options.wokrkingFolder, all: true })
                await eachLine(subprocess.all, line => logger.debug(line))
                await subprocess
            }
        }

        async function executeCommands(hook) {
            let cmds = options[hook] || []
            if (typeof cmds == 'function') cmds = await cmds()
            if (typeof cmds == 'string') cmds = [cmds]

            for (let command of cmds) {
                await executeCommand(command)
            }
        }

        onLoad(async () => await executeCommands('load'))
        onLoaded(async () => await executeCommands('loaded'))
        onImport(async () => await executeCommands('import'))
        onImported(async () => await executeCommands('imported'))
        onProcess(async () => await executeCommands('process'))
        onProcessed(async () => await executeCommands('processed'))
        onPersist(async () => await executeCommands('persist'))
        onPersisted(async () => await executeCommands('persisted'))
        onBeforeRender(async () => await executeCommands('beforeRender'))
        onRender(async () => await executeCommands('render'))
        onAfterRender(async () => await executeCommands('afterRender'))
        onCancel(async () => await executeCommands('cancel'))
        onCancelled(async () => await executeCommands('canceled'))
        onFinalize(async () => await executeCommands('finalize'))
        onFinalized(async () => await executeCommands('finalized'))

        return { executeCommand }
    }
}
