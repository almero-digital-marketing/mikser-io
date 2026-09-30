// Driven by server-port-memory.test.js, in its own process.
//
// Starts a real mikser with --server, reads the port it announces, kills it,
// and does it again — which is the only way to test "across restarts".
//
// argv[2] working folder. Prints one JSON line: the port each run landed on.
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const workdir = process.argv[2]
const MIKSER_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

// Resolves once the port is known and the process has had a moment to
// finish booting — killing on the log line itself races the write, which is
// the thing being tested rather than a thing to reproduce.
function run(args, { expectAnnouncement = true } = {}) {
    return new Promise((resolve) => {
        const child = spawn('node', ['--no-warnings', 'app.js', '--working-folder', workdir, ...args], {
            cwd: MIKSER_ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
            env: { ...process.env, NO_COLOR: '1', NODE_PATH: path.dirname(MIKSER_ROOT) },
        })
        let out = ''
        let settling = false
        const done = (value) => {
            try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
            child.stdout.destroy()
            child.stderr.destroy()
            resolve(value)
        }
        const look = (chunk) => {
            out += chunk
            const announced = out.match(/Server port: (\d+)([^\n]*)/)
            if (announced && !settling) {
                settling = true
                setTimeout(() => done({ port: Number(announced[1]), note: announced[2].trim() }), 2500)
                return
            }
            // A NAMED port is not announced — it was not chosen, it was given
            // — so completion is the signal that it got far enough to record.
            if (!expectAnnouncement && !settling && /Mikser completed/.test(out)) {
                settling = true
                setTimeout(() => done({ port: null, note: 'named' }), 2500)
            }
        }
        child.stdout.on('data', look)
        child.stderr.on('data', look)
        setTimeout(() => done(null), 40000)
    })
}

const first  = await run(['--server'])
const second = await run(['--server'])
await run(['--server', '3457'], { expectAnnouncement: false })
const afterNamed = await run(['--server'])

const remembered = await readFile(path.join(workdir, 'runtime/server-port'), 'utf8')
    .then(text => Number(text.trim()), () => null)

console.log(JSON.stringify({
    first: first?.port ?? null,
    second: second?.port ?? null,
    secondNote: second?.note ?? '',
    afterNamed: afterNamed?.port ?? null,
    remembered,
}))
process.exit(0)
