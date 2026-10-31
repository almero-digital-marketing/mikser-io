import { lstat, mkdir, readFile, readlink, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isReportOnlyRun } from '../tools.js'

// The links this plugin made, kept so it can take back the ones no longer
// asked for.
//
// A share taken out of the config leaves a link whose source is usually still
// there — a package in node_modules — so the link is not broken, finalize's
// sweep of broken links does not see it, and without this the files it points
// at go on being published. Seen on a site that stopped sharing
// `node_modules/@mediapipe/tasks-vision/wasm` as `mediapipe`: `out/mediapipe`
// served the whole runtime until it was removed by hand.
//
// The output folder cannot answer "which of these links are ours" by itself:
// other plugins link files into it too, from the same working folder. So the
// answer is written down, link → source, as each one is made.
//
// In the runtime folder, NOT the cache. Taking a share out changes the config,
// a changed config wipes the cache, and a record kept there would be gone on
// exactly the run that needs it.
//
// A link made before the record existed is not in it, so the first run after
// upgrading cannot take it back; it is recorded from then on if the config
// still asks for it.
const RECORD = 'shares.json'

// What is at `location`: nothing, a link (and where it points), or something
// that is not a link.
async function found(location) {
    try {
        const stats = await lstat(location)
        return { exists: true, link: stats.isSymbolicLink() ? await readlink(location) : null }
    } catch (err) {
        if (err.code == 'ENOENT') return { exists: false, link: null }
        throw err
    }
}

const inside = (folder, location) => {
    const relative = path.relative(folder, location)
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export function shares(options = {}) {
    return ({
        useLogger,
        onLoaded,
        runtime,
    }) => {
        onLoaded(async () => {
            const logger = useLogger()
            const workingFolder = path.resolve(runtime.options.workingFolder)
            const recordFile = path.join(runtime.options.runtimeFolder ?? path.join(workingFolder, 'runtime'), RECORD)
            const locations = options.locations || []
            let recorded = ''
            try { recorded = await readFile(recordFile, 'utf8') } catch { /* none yet */ }
            if (!locations.length && !recorded) return

            const outputFolder = path.resolve(runtime.options.outputFolder)
            // A run that only answers a question does not take anything back
            // or move anything: it may be reading a different config than the
            // build that owns the output folder.
            const reportOnly = isReportOnlyRun()

            // Every configured share, as link → source.
            const wanted = new Map()
            for (let item of locations) {
                const { source, destination } = typeof item == 'string' ? { source: item, destination: item } : item
                wanted.set(path.join(outputFolder, destination), path.resolve(path.join(workingFolder, source)))
            }

            let made = {}
            try { made = JSON.parse(recorded || '{}') } catch { /* unreadable: start again */ }

            // The shares no longer configured. Only what this plugin made, and
            // only while it still points where it did: anything at that path
            // since — a file a renderer wrote, another plugin's link — is not
            // ours to remove. Links into another output folder belong to
            // another config and are left in the record as they are.
            if (!reportOnly) {
                for (const [link, source] of Object.entries(made)) {
                    if (!inside(outputFolder, link) || wanted.has(link)) continue
                    if ((await found(link)).link === source) {
                        await unlink(link)
                        logger.info('Share removed: %s (no longer configured)', path.relative(outputFolder, link))
                    }
                    delete made[link]
                }
            }

            for (const [link, source] of wanted) {
                // Throws on a source that is not there, as it always has: a
                // share of nothing is a config error, not a no-op.
                const sourceStat = await stat(source)
                const there = await found(link)
                if (there.link === source) {
                    made[link] = source
                    continue
                }
                if (there.exists && !there.link) {
                    // Not ours to replace, and a share that does not happen
                    // is said, not skipped.
                    logger.warn('Not shared: %s is already in the output folder and is not a link', path.relative(outputFolder, link))
                    continue
                }
                if (there.link) {
                    if (reportOnly) continue
                    // The share's source moved: a link left pointing at the
                    // old one serves files the config no longer names.
                    await unlink(link)
                    logger.info('Share moved: %s → %s (was %s)', path.relative(outputFolder, link), source, there.link)
                }
                await mkdir(path.dirname(link), { recursive: true })
                logger.debug('Sharing: %s → %s', source, link)
                await symlink(source, link, sourceStat.isDirectory() ? 'dir' : 'file')
                made[link] = source
            }

            const record = Object.keys(made).length ? JSON.stringify(made, null, 2) : ''
            if (!reportOnly && record != recorded) {
                await mkdir(path.dirname(recordFile), { recursive: true })
                await writeFile(`${recordFile}.part`, record)
                await rename(`${recordFile}.part`, recordFile)
            }
        })

        // Names this package to the runtime's loaded-plugin record — see
        // plugins.js. A plugin that declares nothing still reports as loaded,
        // but as `package: null`.
        return { module: import.meta.url }
    }
}
