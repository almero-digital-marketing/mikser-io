# Caching and reverse-proxy failover

When an `api` plugin endpoint declares `cache: true`, every cacheable list response is written to disk under `out/`. The cache lives on the filesystem — not in memory — so a reverse proxy in front of mikser can serve the cached file as failover when mikser itself is unreachable.

This is what keeps the live, per-id reads inside your app working during deploys, restarts, brief upstream blips, and the kind of outages that would otherwise cascade into a blank page.

> **Working nginx config** ([jump to the snippet](#stock-nginx-no-lua-no-extra-modules)) — stock primitives, no Lua, no extra modules. Copy-paste, change the paths, deploy.

## What this cache is for, and what it isn't

`cache: true` is the **fail-safety mechanism for live API reads**. The typical SPA / hybrid app uses it on a single full-content endpoint (`public`) so that calls like `useDocument(id)` keep working — out of the proxy's cached responses — when mikser is briefly down.

It is **not** the place to publish a predictable known-shape snapshot — a route table, a nav menu, a category index, anything that runs on every page load. That work belongs on the `data` plugin: a `catalog.<name>` entry writes one file per name to `out/data/<name>.json`, served by mikser's built-in static handler, CDN-cacheable, with no API round-trip needed. The SDK consumes it via `entities('<endpoint>', { data: { catalog: '<name>' } })` — see the **[sdk-api docs](https://github.com/almero-digital-marketing/mikser-io-sdk-api)** for the `data` option. Name the snapshot after its role — `sitemap` is the routing-specific name, `menu` for a nav, `tags` for a tag index, and so on.

That split matters because the two needs have different shapes:

| Need                                  | Right tool                                                       |
|---|---|
| First-paint snapshot (routes, nav, tags…) | `data.catalog.<name>` → `out/data/<name>.json` (static file)  |
| Per-id document fetch survives outage | `api.endpoints.<name>.cache: true` (per-query disk cache, this doc) |
| Live updates (SSE)                    | Subscribe path — necessarily live, never cached                  |

The rest of this document is about the second row.

## Why the per-query cache exists at all

**Outage survival.** When mikser is unreachable — process down, deploy in flight, network glitch, container restart — the live API stops responding. Without a cache, every list/read request 5xxs at the proxy and falls through to the client. The page either freezes on its loading state or surfaces a generic "backend unavailable." With the cache, the proxy reads from disk and serves the last-known-good response. SSE updates pause (you can't fake a live stream from a static file), but list reads — which dominate page-load traffic for things like `useDocument(id)` — survive transparently.

**Repeat-query savings.** Multiple tabs issuing the same `GET /api/public/entities?...` for a popular document otherwise re-run sift against the catalog every time (indexed clauses push down to SQL, the rest fall through to JS-side sift on the result rows). With the cache the proxy can serve from disk, and only the first request after an invalidation actually hits mikser. For small-to-medium catalogs that's a measurable drop in engine CPU.

## Configure it

Set `cache: true` on the api endpoint:

```js
api: {
    endpoints: {
        public: {
            query: e => e.type === 'document' && e.meta?.published,
            operations: ['list', 'subscribe'],
            cache: true,                    // ← engages the per-query disk cache
        },
    },
}
```

That's the only engine-side change. Once a cacheable endpoint exists, every successful `GET /<endpoint>/entities?...` triggers a write-through cache file as a side effect.

**Caveat for broad list calls.** A `public`-style endpoint without a `fields` projection that gets hit with a *broad* list (no filter) writes a single cache file containing every full entity in scope — a megabyte-scale file behind a single URL. That's fine if a single such file is actually what you want; usually it isn't. Two ways to avoid it:

1. **Route first-paint catalog listings through the data-plugin snapshot** (see top of this doc) — they don't touch the live API at all. This is what the SDK examples do.
2. **If you need a live broad list**, either narrow the endpoint via `fields:`, or split into two endpoints (a narrow one for the broad list, the full-content one for per-id reads).

## File layout

Cache files are named by a sha256 prefix of the query string. Slashes, percent-encodings, brackets, unicode in filter values — any character a URL spec allows — would break a raw-query-string filename on real filesystems (path separators, length limits, reserved chars). Hashing sidesteps all of that.

```
out/api/public/entities/index.json                  ← GET /api/public/entities  (empty query → 'index')
out/api/public/entities/4f3a2c1d8e9b6f7a.json       ← GET /api/public/entities?meta.published=true
out/api/public/entities/8e2c0a1b5d9f4e3a.json       ← GET /api/public/entities?id=/docs/welcome&expand=author
```

The filename is `sha256(queryString).slice(0, 16) + '.json'` — 16 hex chars, 64 bits of address space, comfortably collision-resistant for any realistic cache population.

The trade-off this introduces: nginx can't compute the hash with stock primitives. To keep the failover working without Lua, **the SDK provides the hash as a `cache=<hash>` URL parameter, and nginx uses `$arg_cache` to find the file**.

### The `cache` URL parameter

The SDK's `list()` automatically appends `&cache=<hash>` to every GET request:

```
GET /api/public/entities?expand=author&cache=4f3a2c1d8e9b6f7a
```

Both sides compute the same hash from the same query string. The server strips `cache` from the query before computing its own hash (so the param is invisible to the cache key — see `cacheNameForQueryString` in `src/plugins/api.js`). The two hashes match by construction.

A client that lies about the hash, or doesn't send one, just produces a cache miss in nginx — the request falls through to mikser, which writes the file at the correct name. No cache poisoning is possible because the server is always the source of truth.

## Stock nginx, no Lua, no extra modules

The minimum config that gives you transparent failover:

```nginx
location /api/public/entities {
    proxy_pass http://localhost:3001;
    proxy_intercept_errors on;
    error_page 502 503 504 = @cache;
}

location @cache {
    root /var/www/out;
    # $arg_cache is the hash the SDK appended as &cache=<hash>.
    # Falls through to index.json for the no-params case and
    # to a 502 when the file doesn't exist (truly catastrophic).
    try_files /api/public/entities/$arg_cache.json
              /api/public/entities/index.json
              =502;
}
```

What this gives you:

- **Live request when mikser is up.** `proxy_pass` reaches mikser, which serves a fresh response. As a side effect mikser writes the cache file to disk — the proxy doesn't have to do anything special.
- **Cached response when mikser is down.** nginx's `proxy_intercept_errors` catches the 5xx, falls through to `@cache`, and serves the file at the matching `$arg_cache` path. The client sees a 200 with the last-cached payload.
- **Same URL in both cases.** The client never has to know about a separate cache URL; the SDK never needs special configuration for "fast path vs live path."

For multiple cacheable endpoints, repeat the location block per endpoint, or use a regex location that captures the endpoint name and rewrites the `try_files` paths accordingly.

### Variant: cache-first read (only hit mikser when the file is missing)

If you want the proxy to read from cache by default and only fall through to mikser when the file doesn't exist (lowest possible latency, but reads can be slightly stale until invalidation rebuilds the file):

```nginx
location /api/public/entities {
    root /var/www/out;
    try_files /api/public/entities/$arg_cache.json
              /api/public/entities/index.json
              @mikser;
}

location @mikser {
    proxy_pass http://localhost:3001;
}
```

The trade-off: the cache file may exist but be stale because invalidation hasn't run yet (catalog change in mikser hasn't been observed by the file system). For most read-heavy workloads where staleness on the order of seconds is acceptable, this is the better config. For workloads where reads must reflect the very latest catalog state, stick with the proxy-first variant above.

### Non-SDK clients (curl, search engines, etc.)

Requests without a `cache` param miss the nginx fast path entirely — `$arg_cache` is empty, `try_files` skips that line, and the proxy directive runs. That's correct degradation: non-SDK clients just don't benefit from CDN/nginx acceleration. They still get correct responses. If a non-SDK consumer wants the fast path, they compute the same `sha256(queryString).slice(0, 16)` and append `&cache=...` themselves.

## Other reverse proxies

The pattern is the same in any HTTP layer that supports "try upstream, fall back to static file": map the request URL to a deterministic file path, serve the file on upstream failure.

### Caddy

```caddyfile
example.com {
    handle /api/public/entities {
        reverse_proxy localhost:3001 {
            @cacheable status 502 503 504
            handle_response @cacheable {
                root * /var/www/out
                # `query.cache` is the hash the SDK appended as &cache=<hash>.
                try_files /api/public/entities/{query.cache}.json /api/public/entities/index.json
                file_server
            }
        }
    }
}
```

### Cloudflare Workers (R2 or KV-backed)

```js
export default {
    async fetch(request, env) {
        const url = new URL(request.url)
        // Use the client-provided hash hint when present; fall back to
        // 'index' for empty queries. For clients that didn't send a
        // hash, this becomes a cache miss — the upstream fetch handles it.
        const cacheHint = url.searchParams.get('cache') ?? 'index'
        const cachePath = `api/public/entities/${cacheHint}.json`

        try {
            const upstream = await fetch(`https://mikser-origin.internal${url.pathname}${url.search}`)
            if (upstream.ok) return upstream
            throw new Error(`upstream ${upstream.status}`)
        } catch {
            const cached = await env.R2.get(cachePath)
            if (cached) return new Response(cached.body, { headers: { 'content-type': 'application/json' } })
            return new Response('Bad Gateway', { status: 502 })
        }
    },
}
```

### Apache (httpd)

```apache
<Location /api/public/entities>
    ProxyPass http://localhost:3001/api/public/entities
    ProxyPassReverse http://localhost:3001/api/public/entities
    ProxyErrorOverride On

    ErrorDocument 502 /cache-fallback
    ErrorDocument 503 /cache-fallback
    ErrorDocument 504 /cache-fallback
</Location>

<Location /cache-fallback>
    RewriteEngine On
    # Extract &cache=<hash> from the query string; fall back to 'index'.
    RewriteCond %{QUERY_STRING} (^|&)cache=([0-9a-f]{16})($|&)
    RewriteRule .* /var/www/out/api/public/entities/%2.json [L]
    RewriteRule .* /var/www/out/api/public/entities/index.json [L]
</Location>
```

The key invariant across all of these: the proxy must be able to derive the cache file path from the request URL using only what the request gives it. With the client-provided `cache=<hash>` hint, that derivation is trivial — extract the value, append `.json`. No hashing, no JSON parsing, no shared secret beyond the algorithm itself (sha256, first 16 hex chars).

## Invalidation

Any catalog change — `CREATE`, `UPDATE`, `DELETE` on any entity — clears the entire `out/<base>/<endpoint>/entities/` directory for every endpoint configured with `cache: true`. The next request through repopulates whatever query the client asked for via the write-through path. There's no per-query invalidation tracking; it's coarse but correct, and the cost of re-warming after a change is bounded by traffic.

The reason for the coarse approach: per-entity-to-per-query invalidation would require either (a) tracking which entities matched which queries (memory + bookkeeping), or (b) re-running every cached query against the new catalog state to figure out who changed (CPU cost roughly proportional to cache size). Both are real engineering with real bug surface. "Drop everything on change, let traffic refill" is simpler and correct for the workloads this cache is designed for: small-to-medium catalogs where individual changes are infrequent relative to read traffic.

If you have a high-write workload where dropping the cache on every change is too aggressive, the disk cache is the wrong tool — reach for an in-memory cache with proper invalidation tracking, or accept the cost of re-running queries on every read.

## What's *not* cached

- **`POST /<endpoint>/entities/query`** — there's no URL-derivable cache key for a request body. The proxy would have no way to find the right file on failover. The SDK's `client.list()` uses GET when the query fits (≤1800 bytes URL-encoded) and falls back to POST only for queries that don't fit in a URL — so most real traffic still benefits.
- **`/<endpoint>/entities/subscribe`** — SSE is by definition a live connection. No reverse proxy can serve "current updates" from a static file. When mikser is down, SSE simply doesn't reconnect; the SDK surfaces this via `useMikserStatus` so the frontend can show an honest "reconnecting" state.
- **`/<endpoint>/render`** — render is a render-time operation, not a list. Caching it would be a separate feature with different semantics (rendered output by entity + render options) and a different config flag.

## Honest trade-offs

- **Different parameter orders create different cache files.** Already mentioned above. Most traffic from the SDK has stable ordering so this is a non-issue in practice.
- **Long URLs fail to cache.** Filesystems typically limit filenames to 255 bytes. Queries longer than that cause the cache write to fail silently (logged, not propagated to the response). Live traffic still works — only failover for those queries is lost. The SDK's GET form falls back to POST at ~1800 bytes anyway, so this affects mostly hand-crafted queries.
- **Stale cache between mikser restart and first traffic.** If you restart mikser and a cache file from the previous run is still on disk, a proxy fallback during the restart window serves the old cache. Add a `pre_stop` hook that clears the directory if you need restarts to be sharp.
- **Cache directory size grows with the unique-query space.** Long-tail queries each create a file; for unbounded query spaces this grows unboundedly until the next invalidation. Endpoints with `cache: true` work best when the query space is small and predictable (per-id reads, navigation lookups). Less right when every client issues a different unique query.

## Without `cache: true`

The endpoint runs as before — every list request hits mikser, no files written. The cache is opt-in per endpoint precisely because the trade-offs above only make sense for some endpoints (a small full-content endpoint fronting `useDocument`, an admin lookup) and not others (search-as-you-type, anything with unbounded query space).
