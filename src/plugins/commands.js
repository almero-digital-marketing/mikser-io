import { execaCommand } from 'execa'
import { cliOption } from '../cli.js'
import lineReader from 'line-reader'
import { promisify } from 'util'
import _ from 'lodash'

// The hooks a command can hang off.
//
// ONE flag naming a hook, not fifteen flags named after hooks. The same shape
// as `--tool <name>`: a plugin claims one word for an open-ended registry
// rather than one word per entry. Fifteen would have reserved `--render`,
// `--process`, `--load`, `--import`, `--persist` and `--cancel` at the top
// level for one plugin — words core plausibly wants (a `--render <entity>` is
// not hard to imagine) — and put fifteen near-identical rows in `--help`.
const HOOKS = new Set([
    'load', 'loaded', 'import', 'imported', 'process', 'processed',
    'persist', 'persisted', 'beforeRender', 'render', 'afterRender',
    'cancel', 'canceled', 'finalize', 'finalized',
])

// `load` is declarable in config and unreachable from the CLI: options are
// declared DURING the load phase and the table is not parsed until after it,
// so runtime.options is still empty when onLoad fires.
//
// Named and REFUSED rather than left out of the hook list. Omitting it would
// answer `--command load=...` with "no hook named load", which is untrue —
// there is such a hook, it is simply not one the command line can reach, and a
// wrong reason sends someone looking for a typo. The refusal says what to do
// instead.
const CLI_UNREACHABLE = new Map([
    ['load', 'the option table is parsed after the load phase, so a --command on it could never fire. '
        + 'Declare it in the config instead: commands({ load: ... }).'],
])

// Never expected on a successful build, so their absence is not a finding.
const CONDITIONAL = new Set(['cancel', 'canceled'])

// `hook=command`, split on the FIRST `=` so a command may contain its own.
function parseHookCommand(value) {
    const at = value.indexOf('=')
    if (at < 1) {
        throw new Error(`--command expects <hook>=<command>, got ${JSON.stringify(value)}. `
            + `Hooks: ${[...HOOKS].join(', ')}`)
    }
    const hook = value.slice(0, at).trim()
    const command = value.slice(at + 1).trim()
    if (!HOOKS.has(hook)) {
        throw new Error(`--command: no hook named ${JSON.stringify(hook)}. `
            + `Hooks: ${[...HOOKS].join(', ')}`)
    }
    if (CLI_UNREACHABLE.has(hook)) {
        throw new Error(`--command ${hook}=: ${CLI_UNREACHABLE.get(hook)}`)
    }
    if (!command) throw new Error(`--command ${hook}=: no command given`)
    return { hook, command }
}

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
        //
        // Repeatable, so several hooks can be driven in one invocation. The
        // collector is remembered by cliOption and replayed when an instance
        // re-parses a forwarded client's argv, so the forwarded path sees the
        // same array the local one does.
        cliOption('--command <hook=command>',
            'run a command at a lifecycle hook for this run only, e.g. '
            + '--command finalized="node deploy/publish.mjs". Repeatable. '
            + `Hooks: ${[...HOOKS].join(', ')}`,
            (value, previous = []) => [...previous, parseHookCommand(value)], [])

        // Said once per hook per process, not once per cycle: a watcher would
        // otherwise repeat it on every rebuild.
        const announced = new Set()

        // Which requested hooks actually fired this cycle.
        //
        // `loaded` is the case that matters: it fires for a local build and
        // NOT for one forwarded to a running instance, because that instance
        // loaded at startup and a rebuild does not repeat the load phase. So
        // the same command does different things depending on whether a
        // watcher happens to be up, and until now it did so in silence.
        // Checked generically rather than special-casing that one hook, since
        // the interesting cases are the ones nobody predicted.
        const fired = new Set()

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
            const requested = runtime.options?.command
            const fromCli = (Array.isArray(requested) ? requested : [])
                .filter(entry => entry?.hook === hook)
                .map(entry => entry.command)
            for (const command of fromCli) {
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
                const key = `${hook}:${command}`
                if (!announced.has(key)) {
                    announced.add(key)
                    useLogger()?.warn({ code: 'command-from-cli', hook, command },
                        'Running a command from the command line at the %s hook: %s. This build is a '
                        + 'function of how it was invoked as well as of the repository — the same commit '
                        + 'built without this flag can differ. Commands that write into the output folder '
                        + 'also fail --audit-output, which hashes each file as it is written.',
                        hook, command)
                }
            }
            cmds = [...cmds, ...fromCli]

            for (let command of cmds) {
                await executeCommand(command)
            }
            if (fromCli.length) fired.add(hook)
        }

        // Anything asked for that never ran, said at the end of the cycle.
        function reportUnfired() {
            const requested = runtime.options?.command
            if (!Array.isArray(requested)) return
            const missed = [...new Set(requested.map(entry => entry?.hook))]
                .filter(hook => hook && !fired.has(hook) && !CONDITIONAL.has(hook))
            fired.clear()
            if (!missed.length) return
            useLogger()?.warn({ code: 'command-hook-not-reached', hooks: missed },
                'Asked to run a command at %s, and that hook did not fire this cycle. A build forwarded '
                + 'to a running instance reuses one that loaded at startup, so load-phase hooks belong '
                + 'to the instance rather than to the request. Stop the instance to run the command, or '
                + 'move it to a per-cycle hook.',
                missed.join(', '))
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
        onFinalized(async () => {
            await executeCommands('finalized')
            // Last, so every other hook has had its chance.
            reportUnfired()
        })

        return { executeCommand }
    }
}
