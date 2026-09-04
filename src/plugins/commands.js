import { execaCommand } from 'execa'
import { cliOption } from '../cli.js'
import lineReader from 'line-reader'
import { promisify } from 'util'
import _ from 'lodash'

// The lifecycle hook a command can hang off, and the CLI flag that names it.
//
// One flag per hook rather than a single `--on hook=cmd`, because the ask was
// `mikser --finalized "..."` and a flag that reads like the phase is the point.
// The cost is 15 words of top-level CLI namespace claimed by one plugin, and
// they only exist when commands() is in the config — like every plugin option.
const HOOKS = [
    ['load', '--load <command>'], ['loaded', '--loaded <command>'],
    ['import', '--import <command>'], ['imported', '--imported <command>'],
    ['process', '--process <command>'], ['processed', '--processed <command>'],
    ['persist', '--persist <command>'], ['persisted', '--persisted <command>'],
    ['beforeRender', '--before-render <command>'], ['render', '--render <command>'],
    ['afterRender', '--after-render <command>'],
    ['cancel', '--cancel <command>'], ['canceled', '--cancelled <command>'],
    ['finalize', '--finalize <command>'], ['finalized', '--finalized <command>'],
]

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

        // Declared here, in the load phase, and READ in the hook below.
        // Reading at construction is always undefined — the option table is
        // not parsed until after this runs.
        for (const [hook, flags] of HOOKS) {
            cliOption(flags, `run a command at the ${hook} hook, for this run only`)
        }

        // Said once per hook per process, not once per cycle: a watcher would
        // otherwise repeat it on every rebuild.
        const announced = new Set()

        async function executeCommand(command) {
            const logger = useLogger()
            if (_.endsWith(command, '&')) {
                command = command.slice(0, -1)
                if (!running[command]) {
                    logger.info('Command: %s', command, runtime.options.workingFolder)
                    const subprocess = execaCommand(command, { cwd: runtime.options.workingFolder, all: true })
                    eachLine(subprocess.all, line => logger.info(line))
                    running[command] = subprocess
                        .then(() => delete running[command])
                        .catch(err => logger.error(err, 'Command error'))
                }
            } else {
                logger.info('Command: %s', command, runtime.options.workingFolder)
                const subprocess = execaCommand(command, { cwd: runtime.options.workingFolder, all: true })
                await eachLine(subprocess.all, line => logger.debug(line))
                await subprocess
            }
        }

        async function executeCommands(hook) {
            let cmds = options[hook] || []
            if (typeof cmds == 'function') cmds = await cmds()
            if (typeof cmds == 'string') cmds = [cmds]

            // From argv, read HERE rather than merged into `options` at
            // construction — that is the whole rule for plugin CLI options,
            // and it is also what makes a forwarded request overwrite instead
            // of accumulate. The instance applies a client's flags onto
            // runtime.options for one cycle and restores them after, so this
            // reads whatever THIS request asked for. Registering a hook per
            // request would have made two clients' commands add up; there is
            // one hook, registered once, reading a value that changes.
            const fromCli = runtime.options?.[hook]
            if (typeof fromCli === 'string' && fromCli.length) {
                // Under a code, in the report, with the command.
                //
                // A build is otherwise a function of the repository — same
                // commit, same bytes, and --fingerprint can prove it. A
                // command from argv makes it a function of the repo AND how it
                // was invoked, so an agent, a person and CI can run "the same
                // build" and get different output. Warn rather than log:
                // warnings are a view of logger.warn in the report, so a
                // fingerprint taken from this build stays interpretable
                // instead of quietly meaning something else.
                const key = `${hook}:${fromCli}`
                if (!announced.has(key)) {
                    announced.add(key)
                    useLogger()?.warn({ code: 'command-from-cli', hook, command: fromCli },
                        'Running a command from the command line at the %s hook: %s. This build is a '
                        + 'function of how it was invoked as well as of the repository — the same commit '
                        + 'built without this flag can differ. Commands that write into the output folder '
                        + 'also fail --audit-output, which hashes each file as it is written.',
                        hook, fromCli)
                }
                cmds = [...cmds, fromCli]
            }

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
