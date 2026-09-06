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
        const collect = (value, previous = []) => [...previous, parseHookCommand(value)]
        cliOption('--command <hook=command>',
            'run a command at a lifecycle hook for THIS run only, e.g. '
            + '--command finalized="node deploy/publish.mjs". Repeatable. '
            + `Hooks: ${[...HOOKS].join(', ')}`,
            collect, [])
        // Installed on the instance rather than spent on one request.
        //
        // --command alone cannot serve the case it was asked for. A watcher's
        // OWN rebuilds — the ones a file save triggers, which is the whole
        // point of watching — run nothing, so a probe fires only when a build
        // is forwarded by hand. Installing puts it on the instance, where
        // every cycle sees it until it is cleared.
        cliOption('--command-install <hook=command>',
            'install a command on the running instance, so its own rebuilds run it too. '
            + 'Repeatable. Cleared with --command-reset.',
            collect, [])
        cliOption('--command-reset [hook]',
            'clear commands installed with --command-install: all of them, or one hook\'s.')

        // Said once per hook per process, not once per cycle: a watcher would
        // otherwise repeat it on every rebuild.
        const announced = new Set()

        // Commands installed on THIS process by a forwarded --command-install.
        //
        // Lives in the plugin's closure rather than runtime.options because
        // options are swapped per request and restored after — which is
        // exactly right for --command and exactly wrong for something whose
        // point is to outlive the request that set it.
        const installed = new Map()

        // Applied at the top of every hook: idempotent, so it does not matter
        // which hook of the cycle sees the request first, and by the next
        // cycle the request's options are gone while `installed` remains.
        function applyInstallRequest() {
            const reset = runtime.options?.commandReset
            if (reset !== undefined && reset !== false) {
                const cleared = reset === true
                    ? [...installed.keys()]
                    : installed.has(reset) ? [reset] : []
                if (reset === true) installed.clear()
                else installed.delete(reset)
                if (cleared.length) {
                    useLogger()?.info('Cleared installed command(s) at %s', cleared.join(', '))
                }
            }
            const requested = runtime.options?.commandInstall
            if (!Array.isArray(requested) || !requested.length) return
            // An instance is what there is to install ON. A one-shot exits
            // with the process, so installing is the same as --command and
            // saying nothing would let someone believe it persisted.
            if (!runtime.options?.watch && !runtime.options?.server) {
                if (!announced.has('no-instance')) {
                    announced.add('no-instance')
                    useLogger()?.warn({ code: 'command-install-without-instance' },
                        'Nothing to install on — this is a one-shot build, not a watcher, so '
                        + '--command-install ran once and exits with the process, exactly like --command.')
                }
            }
            for (const { hook, command } of requested) {
                const list = installed.get(hook) ?? []
                if (!list.includes(command)) installed.set(hook, [...list, command])
            }
        }

        // NOT registered as a tool, deliberately.
        //
        // Listing what is attached is worth having, and `--tool commands` was
        // the obvious shape — the registry forwards report-only runs to the
        // instance, so it would answer from the process that holds the state.
        // But the registry is mirrored into MCP over HTTP, its endpoint filter
        // defaults to allow-all, and a command string routinely carries a
        // path, a host or a token. That turns "list the hooks" into handing an
        // authenticated web client a map of the build box.
        //
        // There is no per-tool scope to lean on: routes declare reachability
        // (public / token / loopback), tools declare only `mutates`. A
        // `scope: 'admin'` key here would be decorative — nothing enforces it
        // — and a decorative guard is worse than none, because it reads like
        // one.
        //
        // Installing is not the exposure: it needs the unix socket, which is
        // chmod 0600, so anyone who can reach it already runs as this user and
        // could run the command directly. Reading over HTTP is a different
        // boundary, which is why this half is the half that had to go.
        //
        // What answers the question meanwhile: every installed command is
        // announced on every cycle under `command-from-cli`, so the last
        // build's log or its --json report names each one. A standalone
        // listing wants per-tool scoping in the registry first.

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
            applyInstallRequest()

            const requested = runtime.options?.command
            const perRequest = (Array.isArray(requested) ? requested : [])
                .filter(entry => entry?.hook === hook)
                .map(entry => entry.command)
            // Installed ones outlive the request that set them, so they run
            // for the instance's OWN rebuilds too — which is the case
            // --command alone cannot serve.
            const fromInstalled = installed.get(hook) ?? []
            const fromCli = [...perRequest, ...fromInstalled]
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
                // A per-request command is announced once per process: it is
                // in the invocation you just typed. An INSTALLED one is
                // announced every cycle, because you may have set it an hour
                // ago and each build's report has to carry the fact that this
                // build was not a function of the repository alone.
                const key = `${hook}:${command}`
                if (fromInstalled.includes(command) || !announced.has(key)) {
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

        return { executeCommand, module: import.meta.url }
    }
}
