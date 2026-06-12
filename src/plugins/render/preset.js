import { mkdir } from 'node:fs/promises'
import path from 'node:path'

export async function load({ entity, runtime }) {
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