// Map with a concurrency bound.
//
// Its own module, and that is the point: tools/publish.mjs ends in
// `await main()`, so importing it RUNS A RELEASE. A test that reached in for
// this helper executed the whole tool — verified, and harmless only because
// nothing happened to be pending at that moment. With a package staged,
// `npm run test:unit` would have pushed a tag.
//
// Anything the tool wants to test goes here or beside it, never behind that
// import.

// Preserves INPUT order in the result, which is what the release pre-flight
// depends on: it zips the results back against the topological order, and
// everything downstream — the order packages are released in, which exists so
// a dependent is never published before its dependency — reads that order.
export async function mapConcurrent(items, limit, fn) {
    const results = new Array(items.length)
    let next = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const index = next++
            if (index >= items.length) return
            results[index] = await fn(items[index], index)
        }
    })
    await Promise.all(workers)
    return results
}
