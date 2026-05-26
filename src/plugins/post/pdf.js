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
    browser = await puppeteer.launch({
        headless: true,
        ...config?.launch
    })
    logger.debug('Puppeteer browser launched')
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
