// How wide this build renders.
//
// One number sizes three things: the inline render dispatcher, the inline
// postprocess dispatcher, and the two Piscina pools. It was hardcoded to 4 —
// `setup()` read it from its own argument, which `app.js` never passes, and
// there was no flag and no config key. A 24-core container could keep four
// renders in flight and nothing could say otherwise, which is what a site hit
// when every preset declaring a concurrency cap is pinned INLINE: the cap was
// per preset, the inline dispatcher held four, and the machine idled.
//
// THE DEFAULT STAYS 4. Wide-by-default is dangerous for a renderer that
// spawns external processes — mikser-io-assets' preset.js has the OOM story
// — and a build that is memory-bound gets worse, not better, with more of it
// in flight. Raising it is a decision about one machine and one workload, so
// it is taken by whoever knows both.
export const DEFAULT_THREADS = 4

/**
 * CLI over config over default. Returns { threads, source } — the source so
 * the one startup line can say where the number came from, which is the
 * question anybody reading it actually has.
 *
 * `cli` is undefined unless `--threads` was typed: the flag is declared with
 * no default precisely so that "not given" stays distinguishable from "given
 * the same value as the default", which is the distinction the precedence
 * rests on.
 */
export function resolveThreads({ cli, config } = {}) {
    if (cli !== undefined && cli !== null) return { threads: validate(cli, '--threads'), source: 'cli' }
    if (config !== undefined && config !== null) {
        return { threads: validate(config, 'config.threads'), source: 'config' }
    }
    return { threads: DEFAULT_THREADS, source: 'default' }
}

// Commander hands over strings, a config hands over whatever was written, so
// both are accepted and neither is guessed at: `true` coerces to 1 through
// Number() and would silently become a one-thread build, so only strings and
// numbers are considered at all.
function validate(value, source) {
    const number = typeof value === 'string' ? Number(value) : value
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
        throw new Error(
            `${source} must be a positive whole number of threads — got ${JSON.stringify(value)}. `
            + `It sizes the inline render and postprocess dispatchers and both worker pools.`)
    }
    return number
}
