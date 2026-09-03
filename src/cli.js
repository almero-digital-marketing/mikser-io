// CLI options a plugin adds.
//
// An option is a contract between a person and a build, and a plugin is where
// half the build lives — so a plugin that cannot add one has to be reached
// some other way: an environment variable, a config key that means "do the
// expensive thing", a wrapper script. All three were tried downstream and all
// three are worse in the same way: they are invisible to `--help`, they cannot
// be refused when misspelled, and they do not appear beside the checks they
// belong next to.
//
// The reason it was not possible is an ordering fact rather than a decision.
// The engine parses argv in onInitialize, and the CONFIG — which is where the
// plugins are named — is not read until onLoad. At the moment the first parse
// runs, the engine genuinely does not know what options exist.
//
// So the parse happens in two stages, and the second one is the real one:
//
//   1. onInitialize — core's own options, tolerating unknowns, because the
//      table is knowingly incomplete. Enough to find the config and the
//      folders.
//   2. after the load phase — every plugin has been constructed and has had
//      its chance to declare, so the table is complete. argv is parsed again
//      against it, and NOW an unknown option is an error.
//
// The refusal that has to survive this is the one from 9.81.0: a misspelled
// flag must never be silently ignored. It is not weakened, only moved to the
// point where "unknown" can actually be decided.

import runtime from './runtime.js'

// What plugins declared, for the message when something is not recognised and
// for anyone asking what a build's option table actually contains.
const declared = new Map()

// Declare a CLI option from inside a plugin.
//
// Call it while the plugin is being constructed — that is during the load
// phase, before the second parse. Declaring later is not an error but the
// option will not be parsed, so it says so rather than doing nothing.
//
//   cliOption('--lighthouse', 'audit the built pages with Lighthouse, and exit 0')
//
// Reads back from `runtime.options` under commander's usual camel-cased name.
export function cliOption(flags, description, defaultValue) {
    const commander = runtime.engine?.commander
    if (!commander) {
        throw new Error('cliOption: no commander yet — call it while the plugin is being constructed')
    }
    if (runtime.engine.cliSealed) {
        throw new Error(
            `cliOption(${JSON.stringify(flags)}): the option table was already parsed. `
            + 'Declare options while the plugin is constructed (the load phase), not afterwards — '
            + 'a later one would never be read and the flag would look ignored.')
    }
    if (declared.has(flags)) return declared.get(flags)
    const option = defaultValue === undefined
        ? commander.option(flags, description)
        : commander.option(flags, description, defaultValue)
    declared.set(flags, option)
    return option
}

// Every option a plugin added, in declaration order.
export function pluginCliOptions() {
    return [...declared.keys()]
}

// Stage two: the table is complete, so parse for real.
//
// Called once, after the load phase. Merges what the complete table yields
// over what stage one produced — a plugin's option lands here for the first
// time, and core's own options parse identically both times.
export function completeCliParse() {
    const commander = runtime.engine?.commander
    if (!commander || runtime.engine.cliSealed) return
    runtime.engine.cliSealed = true

    // Always, even when no plugin declared anything.
    //
    // Stage one tolerates an unknown option AND the excess argument it then
    // looks like, so it cannot be the stage that judges argv — left to it,
    // `mikser --bogus-flag` came back "too many arguments. Expected 0
    // arguments but got 1", which is commander describing its own internal
    // reading rather than the mistake a person made. Skipping stage two when
    // no plugin declared would leave exactly that message on most builds.
    //
    // Strict here: every option any part of this build understands is
    // registered, so anything left over is a misspelling, and saying which one
    // is the whole point of the refusal.
    commander.allowUnknownOption(false).allowExcessArguments(false)

    // Help, now that the table is complete — including every option the
    // project's own plugins declared, which is the whole reason it waited.
    if (runtime.engine.helpRequested) {
        commander.outputHelp()
        process.exit(0)
    }

    commander.parse(process.argv)
    Object.assign(runtime.options, commander.opts())
}

// The plugin-declared options carried by a client's argv.
//
// A forwarded build is answered by an INSTANCE, which parsed its own argv
// (`--watch`) and never saw the client's. Core's own request options — json,
// clear, renderPresets — each travel explicitly for exactly this reason. A
// plugin option has to as well, or `mikser --lighthouse` works with nothing
// listening and silently does nothing with a watcher up, which is the failure
// this whole surface exists to remove.
//
// Read from the argv the client sent, against the table the INSTANCE has:
// both processes load the same config, so the instance knows every option the
// client could legitimately have passed.
export function pluginOptionsFrom(argv) {
    const commander = runtime.engine?.commander
    if (!commander || !declared.size || !Array.isArray(argv)) return {}
    // A throwaway parse: `parseOptions` reads without applying, so the
    // instance's own options are untouched by asking what a client sent.
    let parsed
    try {
        const probe = commander.createCommand()
        for (const flags of declared.keys()) probe.option(flags, '')
        probe.allowUnknownOption(true).allowExcessArguments(true)
        probe.parse(argv, { from: 'user' })
        parsed = probe.opts()
    } catch {
        return {}
    }
    // Only what a plugin declared. Core's options travel on the request
    // itself, and re-applying them from argv here would give two sources for
    // one answer.
    const names = new Set(Object.keys(parsed))
    const values = {}
    for (const name of names) {
        if (parsed[name] !== undefined) values[name] = parsed[name]
    }
    return values
}
