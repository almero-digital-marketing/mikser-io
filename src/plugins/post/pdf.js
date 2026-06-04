import path from 'node:path'
import { access } from 'node:fs/promises'

const TEARDOWN_DELAY = 60_000

let browser
let teardownTimer

// Platform-appropriate paths where Chrome / Chromium / Edge typically
// live when installed via the OS package manager (apt / dmg / msi).
// Order matters — first existing one wins. `executable: 'auto'` probes
// this list so the same mikser.config.js works on a Mac dev box and a
// Linux production server without env-conditional path strings.
function chromeCandidates() {
    if (process.platform === 'darwin') return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
        '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]
    if (process.platform === 'win32') return [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    // linux + everything else
    return [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/microsoft-edge-stable',
        '/usr/bin/microsoft-edge',
        '/snap/bin/chromium',
    ]
}

async function discoverSystemChrome() {
    for (const candidate of chromeCandidates()) {
        try {
            await access(candidate)
            return candidate
        } catch { /* not there, try next */ }
    }
    return null
}

export async function setup({ config, logger }) {
    if (teardownTimer) {
        clearTimeout(teardownTimer)
        teardownTimer = undefined
        logger.debug('Puppeteer browser reused')
        return
    }

    // Resolve which chrome to use, in precedence order:
    //   1. config.launch.executablePath  — explicit, wins
    //   2. config.executable (literal path) — friendly top-level alias
    //   3. PUPPETEER_EXECUTABLE_PATH     — puppeteer's standard env var
    //   4. config.executable === 'auto'  → probe OS-typical chrome paths
    //                                      (cross-platform default —
    //                                      same config works on macOS
    //                                      dev + Linux prod)
    //   5. undefined → puppeteer's bundled download
    //
    // 'auto' is the recommended setting when the same project is
    // deployed across OSes. It avoids env-conditional config strings
    // like (process.platform === 'darwin' ? '/Applications/...' : '/usr/bin/...').
    const aliased = config?.executable
    let executablePath = config?.launch?.executablePath
    if (executablePath === undefined) {
        if (aliased !== undefined && aliased !== 'auto') {
            // Literal config.executable (including '' — that's a config
            // bug but we surface it via puppeteer's launch error rather
            // than silently falling through to env).
            executablePath = aliased
        } else if (process.env.PUPPETEER_EXECUTABLE_PATH !== undefined) {
            executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
        } else if (aliased === 'auto') {
            executablePath = await discoverSystemChrome()
            if (!executablePath) {
                const tried = chromeCandidates().map(p => '    ' + p).join('\n')
                throw new Error(
                    `post-pdf: 'executable: \\'auto\\'' was configured but no system chrome was found on ${process.platform}.\n` +
                    `Tried:\n${tried}\n` +
                    `Install one of the above OR set 'executable' to an explicit path.`
                )
            }
            logger.debug('Auto-discovered chrome: %s', executablePath)
        }
    }

    // Driver library: try `puppeteer` first (most common, bundles chrome),
    // then `puppeteer-core` (same API without the chrome auto-download —
    // the right choice when you've configured an external `executable`).
    // Either is fine; either can drive any chrome binary you point at.
    const puppeteer =
        await import('puppeteer').then(m => m.default).catch(() => null)
        ?? await import('puppeteer-core').then(m => m.default).catch(() => null)

    if (!puppeteer) {
        // Context-aware install instructions. If the user already configured
        // an executable, they almost certainly want puppeteer-core (lean,
        // no chrome download). Otherwise either works.
        if (executablePath) {
            throw new Error(
                `post-pdf needs the puppeteer driver library to talk to chrome at ${executablePath}.\n` +
                `Since you've configured an external executable, install the lean driver (no bundled chrome):\n` +
                `  npm install puppeteer-core`
            )
        }
        throw new Error(
            'post-pdf needs a puppeteer driver to render PDFs.\n' +
            'Two options:\n' +
            '  - Quickest:   npm install puppeteer            (bundles chrome ~500MB)\n' +
            '  - Headless:   sudo apt install google-chrome-stable\n' +
            '                npm install puppeteer-core      (no chrome download)\n' +
            '                # then in mikser.config.js:\n' +
            "                'post-pdf': { executable: '/usr/bin/google-chrome-stable' }"
        )
    }

    // --no-sandbox / --disable-setuid-sandbox are required on most
    // headless Linux servers and Docker images where Chrome's sandbox
    // can't be set up. Applied by default and merged (deduped) with any
    // user-supplied launch.args so callers can add flags without losing
    // these. To run WITH the sandbox, override launch.args explicitly.
    const defaultArgs = ['--no-sandbox', '--disable-setuid-sandbox']

    browser = await puppeteer.launch({
        headless: true,
        ...config?.launch,
        ...(executablePath ? { executablePath } : {}),
        args: [...new Set([...defaultArgs, ...(config?.launch?.args ?? [])])],
    })
    if (executablePath) {
        logger.debug('Puppeteer browser launched (executable: %s)', executablePath)
    } else {
        logger.debug('Puppeteer browser launched (bundled chrome)')
    }
}

export async function postprocess({ entity, options, config, logger }) {
    const sourcePath = path.join(options.outputFolder, entity.origin)

    const page = await browser.newPage()
    try {
        await page.goto(`file://${sourcePath}`, {
            waitUntil: 'networkidle0',
            ...config?.navigation
        })
        return await page.pdf({
            format: 'A4',
            printBackground: true,
            ...config?.pdf
        })
    } finally {
        await page.close()
    }
}

export async function teardown({ options, config, logger }) {
    if (!options?.watch) {
        await browser?.close()
        browser = undefined
        logger.debug('Puppeteer browser closed')
        return
    }
    const delay = config?.teardownDelay ?? TEARDOWN_DELAY
    teardownTimer = setTimeout(async () => {
        teardownTimer = undefined
        await browser?.close()
        browser = undefined
        logger.debug('Puppeteer browser closed')
    }, delay)
    logger.debug('Puppeteer browser teardown scheduled in %dms', delay)
}
