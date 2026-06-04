import path from 'node:path'

const TEARDOWN_DELAY = 60_000

let browser
let teardownTimer

export async function setup({ config, logger }) {
    if (teardownTimer) {
        clearTimeout(teardownTimer)
        teardownTimer = undefined
        logger.debug('Puppeteer browser reused')
        return
    }

    // Resolve which chrome to use, in precedence order:
    //   1. config.launch.executablePath  — explicit, wins
    //   2. config.executable             — friendly top-level alias
    //   3. PUPPETEER_EXECUTABLE_PATH     — puppeteer's standard env var
    //                                      (useful for prod servers where
    //                                      the path differs from dev)
    //   4. undefined → puppeteer's bundled download (the brittle path
    //      that fails when ~/.cache/puppeteer is half-populated)
    //
    // For headless production servers, pointing at a system chromium
    // installed via apt skips puppeteer's postinstall download entirely.
    const executablePath =
        config?.launch?.executablePath
        ?? config?.executable
        ?? process.env.PUPPETEER_EXECUTABLE_PATH
        ?? undefined

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
