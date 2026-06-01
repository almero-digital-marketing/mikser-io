# Caching and reverse-proxy failover

When the `api` plugin's endpoints declare `cache: true`, every cacheable list response is written to disk in `out/`. The cache lives on the filesystem — not in memory — so a reverse proxy in front of mikser can serve the cached file as failover when mikser itself is unreachable.

This is what keeps your frontend rendering during deploys, restarts, brief upstream blips, and the kind of outages that would otherwise cascade into a blank page.

> **Working nginx config** ([jump to the snippet](#stock-nginx-no-lua-no-extra-modules)) — stock primitives, no Lua, no extra modules. Copy-paste, change the paths, deploy.

## Set `fields` on any cached public endpoint — read this first

`cache: true` on a public endpoint without an explicit `fields` allow-list is a data-leak waiting to happen. The cached file contains every field of every matching entity — markdown content, internal `uri` / `source` paths, timestamps, ANY meta field including the ones you didn't think to limit — and it's served at a static GET URL that anyone with the URL can hit, even when mikser is alive and authenticated requests would be rejected.

Always set `fields` when both `cache: true` and `token` is unset:

```js
sitemap: {
    query: e => e.type === 'document' && e.meta?.published && e.meta?.component,
    operations: ['list', 'subscribe'],
    cache: true,
    fields: [                       // ← REQUIRED for public caches
        'id', 'destination',
        'meta.route', 'meta.component', 'meta.title',
    ],
}
```

The api plugin enforces this projection on every response — list, query, AND subscribe — regardless of what the client requests. A curl with no `?fields=...` parameter still gets exactly the safe subset. Token-gated endpoints don't need it (the token is the access control); public endpoints absolutely do.

mikser-io 6.26.0+ logs a warning at load time if it sees a token-less endpoint with `cache: true` but no `fields`. If you see that warning, stop and add the projection before deploying.

## Why a disk cache at all

Two real problems get solved.

**Outage survival.** When mikser is unreachable — process down, deploy in flight, network glitch, container restart — the live API stops responding. Without a cache, every list request 5xxs at the proxy and falls through to the client. Routes don't resolve, list reads fail, and the frontend either freezes on its loading state or surfaces a generic "backend unavailable." With the cache, the proxy reads from disk and serves the last-known-good response. SSE updates pause (you can't fake a live stream from a static file), but list reads — which dominate page-load traffic — survive transparently.

**Repeat-query savings.** Every browser tab issuing `useMikserRoutes(...)` makes the same `GET /api/sitemap/entities?...` request on boot. Without a cache, mikser re-runs sift over the in-memory catalog for each. With a cache, the proxy serves the cached file from disk and only the first request after an invalidation actually hits mikser. For SPAs in front of small-to-medium catalogs that's a measurable drop in CPU on the engine.

## How to turn it on

Set `cache: true` on the api endpoint:

```js
api: {
    endpoints: {
        sitemap: {
            query: e => e.type === 'document' && e.meta?.published && e.meta?.component,
            operations: ['list', 'subscribe'],
            cache: true,                    // ← engages the disk cache
        },
    },
}
```

That's the only engine-side change. Once a cacheable endpoint exists, every successful `GET /<endpoint>/entities?...` triggers a write-through cache file as a side effect.

## File layout

The cache file path mirrors the request URL exactly — no hashing, no encoding magic. The segment after `/entities/` is the raw query string the client sent (URL-encoded), or `index` when there's no query:

```
out/api/sitemap/entities/index.json                              ← GET /api/sitemap/entities
out/api/sitemap/entities/meta.published=true.json                ← GET /api/sitemap/entities?meta.published=true
out/api/sitemap/entities/meta.component=page&limit=20.json       ← GET /api/sitemap/entities?meta.component=page&limit=20
```

Two consequences worth noting:

1. **The proxy doesn't need to know mikser's filename scheme.** It just maps `$args` (nginx's raw query string variable) to a file path the same way mikser does. No hashing on either end.
2. **Structurally-equal queries with different parameter orders create different files.** `?a=1&b=2` and `?b=2&a=1` would be the same query semantically but write to two separate cache files. The SDK uses a stable parameter order, so this only matters for hand-crafted URLs. Soft inefficiency, not a correctness bug.

## Stock nginx, no Lua, no extra modules

The minimum config that gives you transparent failover:

```nginx
location /api/sitemap/entities {
    proxy_pass http://localhost:3001;
    proxy_intercept_errors on;
    error_page 502 503 504 = @cache;
}

location @cache {
    root /var/www/out;
    # $args is the raw query string mikser used as the cache filename.
    # Falls through to index.json for the no-params case.
    try_files /api/sitemap/entities/$args.json
              /api/sitemap/entities/index.json
              =502;
}
```

What this gives you:

- **Live request when mikser is up.** `proxy_pass` reaches mikser, which serves a fresh response. As a side effect mikser writes the cache file to disk — the proxy doesn't have to do anything special.
- **Cached response when mikser is down.** nginx's `proxy_intercept_errors` catches the 5xx, falls through to `@cache`, and serves the file at the matching `$args` path. The client sees a 200 with the last-cached payload.
- **Same URL in both cases.** The client never has to know about a separate cache URL; the SDK never needs special configuration for "fast path vs live path."

For multiple cacheable endpoints, repeat the location block per endpoint, or use a regex location that captures the endpoint name and rewrites the `try_files` paths accordingly.

### Variant: cache-first read (only hit mikser when the file is missing)

If you want the proxy to read from cache by default and only fall through to mikser when the file doesn't exist (lowest possible latency, but reads can be slightly stale until invalidation rebuilds the file):

```nginx
location /api/sitemap/entities {
    root /var/www/out;
    try_files /api/sitemap/entities/$args.json
              /api/sitemap/entities/index.json
              @mikser;
}

location @mikser {
    proxy_pass http://localhost:3001;
}
```

The trade-off: the cache file may exist but be stale because invalidation hasn't run yet (catalog change in mikser hasn't been observed by the file system). For most read-heavy workloads where staleness on the order of seconds is acceptable, this is the better config. For workloads where reads must reflect the very latest catalog state, stick with the proxy-first variant above.

## Other reverse proxies

The pattern is the same in any HTTP layer that supports "try upstream, fall back to static file": map the request URL to a deterministic file path, serve the file on upstream failure.

### Caddy

```caddyfile
example.com {
    handle /api/sitemap/entities {
        reverse_proxy localhost:3001 {
            @cacheable status 502 503 504
            handle_response @cacheable {
                root * /var/www/out
                try_files /api/sitemap/entities/{query}.json /api/sitemap/entities/index.json
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
        const cacheKey = url.searchParams.toString() || 'index'
        const cachePath = `api/sitemap/entities/${cacheKey}.json`

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
<Location /api/sitemap/entities>
    ProxyPass http://localhost:3001/api/sitemap/entities
    ProxyPassReverse http://localhost:3001/api/sitemap/entities
    ProxyErrorOverride On

    ErrorDocument 502 /cache-fallback
    ErrorDocument 503 /cache-fallback
    ErrorDocument 504 /cache-fallback
</Location>

<Location /cache-fallback>
    RewriteEngine On
    RewriteCond /var/www/out/api/sitemap/entities/%{QUERY_STRING}.json -f
    RewriteRule .* /var/www/out/api/sitemap/entities/%{QUERY_STRING}.json [L]
    RewriteRule .* /var/www/out/api/sitemap/entities/index.json [L]
</Location>
```

The key invariant across all of these: the proxy must be able to derive the cache file path from the request URL using only what the request gives it (path + raw query string). The naming scheme means no hashing, no JSON parsing, no shared secret.

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
- **Cache directory size grows with the unique-query space.** Long-tail queries each create a file; for unbounded query spaces this grows unboundedly until the next invalidation. Endpoints with `cache: true` are right when the query space is small and predictable (sitemap, navigation, faceted-search dimensions). Less right when every client issues a different unique query.

## Without `cache: true`

The endpoint runs as before — every list request hits mikser, no files written. The cache is opt-in per endpoint precisely because the trade-offs above only make sense for some endpoints (sitemap, public reads) and not others (admin, search-as-you-type).
