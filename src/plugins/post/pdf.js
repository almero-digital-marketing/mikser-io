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

    const { default: puppeteer } = await import('puppeteer').catch(() => {
        throw new Error('Puppeteer is required for the pdf postprocessor — run: npm install puppeteer')
    })
    // --no-sandbox / --disable-setuid-sandbox are required on most
    // headless Linux servers and Docker images where Chrome's sandbox
    // can't be set up. Applied by default and merged (deduped) with any
    // user-supplied launch.args so callers can add flags without losing
    // these. To run WITH the sandbox, override launch.args explicitly.
    const defaultArgs = ['--no-sandbox', '--disable-setuid-sandbox']

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
    // installed via apt (executable: '/usr/bin/chromium') skips
    // puppeteer's postinstall download entirely. Set
    // PUPPETEER_SKIP_DOWNLOAD=true at npm install time to keep it from
    // even trying.
    const executablePath =
        config?.launch?.executablePath
        ?? config?.executable
        ?? process.env.PUPPETEER_EXECUTABLE_PATH
        ?? undefined

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
