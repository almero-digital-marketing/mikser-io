import { mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

// A renderer's `load` runs for EVERY entity in the cycle, not only the ones
// this renderer will render — that is deliberate and is how assetUrlHelper
// installs runtime.asset() for all templates. So this has to tolerate an
// entity that has no preset, rather than assume it is looking at one.
//
// Without the guard, adding renderPreset() to a project's plugin list made
// every page render throw on `entity.preset.uri` — and a crash reads as
// "you have found something real", which is a much more expensive wrong
// signal than a no-op. The names invite exactly that mistake:
//
//   assetUrlHelper() provides runtime.asset() to templates  (a URL helper)
//   assets()        runs presets and produces derivatives   (the work)
//   renderPreset()  renders a preset-authored layout        (this file)
//
// The URL helpers carry `Helper` in their names for exactly this reason;
// renderPreset keeps its bare name because it really is a renderer.
export async function load({ entity, runtime }) {
    if (!entity?.preset?.uri) return
    const preset = await import(`${entity.preset.uri}?stamp=${Date.now()}`)
    runtime.preset = preset.default
}

async function describe(file) {
    try {
        const { mtimeMs, size } = await stat(file)
        return { mtimeMs, size }
    } catch { return null }
}

// A render that failed leaves nothing half-written behind.
//
// This is the one place user code is handed a final output path and left to
// fill it, and a half-written derivative there is not self-correcting. The
// marker `isPresetRendered` consults is keyed on the SOURCE checksum, and an
// interruption does not change the source; the file exists, so the engine's
// missing-output path does not fire either. Both gates therefore say "nothing
// to do" over a truncated file, for as long as nobody looks. Measured on a
// 20KB fixture: interrupt one re-render and every later build serves 10KB of
// it. Worse where the preset wraps a tool whose non-zero exit it does not
// check — it RESOLVES, the manifest snapshots the truncated bytes, and
// --audit-output then reads green, because it compares each output against
// the hash its own render recorded.
//
// Removed only when THIS render is what changed it. A preset that fails
// before writing anything still has a good derivative on disk, and deleting
// that would take a working asset off the site until the next build — so the
// file is measured before and after, and left alone if it did not move.
export async function render({ entity, options, config, context, plugins, runtime, state, logger }) {
    await mkdir(path.dirname(entity.destination), { recursive: true })
    const before = await describe(entity.destination)
    try {
        await runtime.preset({ entity, options, config, context, plugins, runtime, state, logger })
    } catch (error) {
        const after = await describe(entity.destination)
        const touched = after && (!before || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        if (touched) await rm(entity.destination, { force: true })
        throw error
    }
    return entity.destination
}

export function renderPreset(options = {}) {
    return { name: options.name ?? 'preset', options, load, render }
}