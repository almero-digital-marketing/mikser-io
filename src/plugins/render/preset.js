import { mkdir } from 'node:fs/promises'
import path from 'node:path'

// A renderer's `load` runs for EVERY entity in the cycle, not only the ones
// this renderer will render — that is deliberate and is how renderAsset
// installs runtime.asset() for all templates. So this has to tolerate an
// entity that has no preset, rather than assume it is looking at one.
//
// Without the guard, adding renderPreset() to a project's plugin list made
// every page render throw on `entity.preset.uri` — and a crash reads as
// "you have found something real", which is a much more expensive wrong
// signal than a no-op. The names invite exactly that mistake:
//
//   renderAsset()   provides runtime.asset() to templates  (a URL helper)
//   assets()        runs presets and produces derivatives   (the work)
//   renderPreset()  renders a preset-authored layout        (this file)
//
// All three are named after the object they concern rather than the job they
// do, so reasoning "the one that RUNS presets must be renderPreset" is wrong
// but not unreasonable.
export async function load({ entity, runtime }) {
    if (!entity?.preset?.uri) return
    const preset = await import(`${entity.preset.uri}?stamp=${Date.now()}`)
    runtime.preset = preset.default
}

export async function render({ entity, options, config, context, plugins, runtime, state, logger }) {
    await mkdir(path.dirname(entity.destination), { recursive: true })
    await runtime.preset({ entity, options, config, context, plugins, runtime, state, logger })
    return entity.destination
}

export function renderPreset(options = {}) {
    return { name: options.name ?? 'preset', options, load, render }
}