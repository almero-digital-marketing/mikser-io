// Test harness for scenario tests — spawns mikser as a child process
// against a temporary working directory, asserts on stdout + on-disk
// state, cleans up.
//
// Why subprocess instead of in-process: the source.js gate, catalog
// version stamp, manifest persistence, and refs replay all hinge on
// MODULE-LEVEL state that initializes once per Node process. Scenarios
// that test "restart, then change, then restart" need genuine fresh
// processes — otherwise the catalog/manifest/refs caches from the
// previous test leak into the next and the test passes for the wrong
// reason. The cost is ~1-2 seconds per spawn; the safety is that each
// test is a true end-to-end restart simulation.

import { spawn } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const MIKSER_ROOT = path.resolve(__dirname, '../..')

// Strip ANSI color codes from pino-pretty output so pattern matches
// stay readable.
export function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*m/g, '')
}

// Build a uniquely-named scratch directory under the OS tmpdir.
// Per-test isolation; safe to run scenarios in parallel.
let counter = 0
export function freshWorkdir(label = 'scenario') {
    counter++
    return path.join(tmpdir(), `mikser-scenarios-${process.pid}-${counter}-${label}`)
}

// Materialize a flat-keyed { relativePath: content } map into the
// workdir. Parent dirs are mkdir'd automatically. Use this once per
// test to set up the initial state; per-step mutations use writeFile /
// rm directly.
export async function setupFixture(workdir, files) {
    await rm(workdir, { recursive: true, force: true })
    await mkdir(workdir, { recursive: true })
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(workdir, rel)
        await mkdir(path.dirname(full), { recursive: true })
        await writeFile(full, content)
    }
}

// Run mikser one-shot against workdir with optional extra args. Returns
// { code, stdout, stderr } once the process exits. 30s safety timeout
// catches hung child processes.
export function runMikser(workdir, args = []) {
    return new Promise((resolve, reject) => {
        const p = spawn('node', ['--no-warnings', 'app.js', '--working-folder', workdir, ...args], {
            cwd: MIKSER_ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, NO_COLOR: '1' },
        })
        let stdout = '', stderr = ''
        p.stdout.on('data', d => stdout += d.toString())
        p.stderr.on('data', d => stderr += d.toString())
        const timer = setTimeout(() => p.kill('SIGKILL'), 30_000)
        p.on('close', code => {
            clearTimeout(timer)
            resolve({ code, stdout, stderr, combined: stripAnsi(stdout + stderr) })
        })
        p.on('error', err => {
            clearTimeout(timer)
            reject(err)
        })
    })
}

export async function cleanup(workdir) {
    await rm(workdir, { recursive: true, force: true })
}

// Convenience: read the manifest snapshot file directly. NDJSON
// format (one snapshot per line) — parse line by line and skip empty
// trailing lines.
export async function readManifest(workdir) {
    const file = path.join(workdir, 'runtime', 'manifest.ndjson')
    if (!existsSync(file)) return null
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(file, 'utf8')
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

// Convenience: read the catalog directly. NDJSON format — first line
// is a metadata header, subsequent lines are entities. Return a shape
// compatible with what tests expect from the old JSON-array catalog:
// `{ version, entities: [...] }`.
export async function readCatalog(workdir) {
    const file = path.join(workdir, 'runtime', 'catalog.ndjson')
    if (!existsSync(file)) return null
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(file, 'utf8')
    const result = { version: null, entities: [] }
    for (const line of text.split('\n')) {
        if (!line.trim()) continue
        const obj = JSON.parse(line)
        if (obj.__meta__) result.version = obj.version
        else result.entities.push(obj)
    }
    return result
}
