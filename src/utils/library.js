

// Does a value fall under a resources library?
//
// The library key is a REGULAR EXPRESSION source — `resources()` derives it
// with escapeStringRegexp(url), and you only escape a string you are about to
// compile. It has two consumers: the plugin's discovery walk, which decides
// what to download, and the `resource` render helper, which builds the url.
// They read the same string with two different matchers — discovery used a
// GLOB, which demands a full match, so a key derived from `url` (a bare prefix
// with no trailing wildcard) matched nothing. Nothing was ever downloaded for
// a url-declared library, while the helper happily built links to the files
// that were not fetched. Green build, missing images.
//
// One function, so the two cannot drift again.
const libraryPatterns = new Map()

export function matchesLibrary(value, pattern) {
    if (typeof value !== 'string' || !pattern) return false
    if (!libraryPatterns.has(pattern)) {
        let re
        try { re = new RegExp(pattern) }
        // A hand-written `match` that is not valid regex would otherwise throw
        // mid-walk and take the build down.
        catch { re = { test: () => false } }
        libraryPatterns.set(pattern, re)
    }
    return libraryPatterns.get(pattern).test(value)
}
