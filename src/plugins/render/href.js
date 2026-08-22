import path from 'node:path'

export function load({ entity, runtime, options }) {
    const { clear } = options

    runtime.hrefLang = (href) => runtime.lookupHref(href)

    runtime.hrefLangPage = (href, page) => {
        if (page > 1) href += `.${page}`
        return runtime.lookupHref(href)
    }

    runtime.href = (href, lang) => {
        if (!href || typeof href != 'string') return
        if (typeof lang != 'string') lang = undefined

        if (href.indexOf('http') == 0) return href
        lang ||= entity.meta?.lang

        let found = runtime.hrefLang(href)
        if (!found) {
            const from = path.dirname(entity.destination || '/')
            return { url: path.relative(from, href) }
        } else {
            if (!found.id) {
                found = found[lang]
            }
            if (found?.destination) {
                const destination = clear ? found.destination.replace('index.html', '') : found.destination
                const from = path.dirname(entity.destination || '/')
                found.url = path.relative(from, destination)
            }
            return found
        }
    }

    runtime.hrefPage = (href, page, lang) => {
    }

    runtime.prev = entity.page > 1 ? entity.page - 1 : false
    runtime.next = entity.page + 1 < entity.pages ? entity.page + 1 : false
}

export function hrefUrlHelpers(options = {}) {
    return { name: options.name ?? 'href', options, load }
}
