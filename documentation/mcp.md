# MCP — talking to mikser from AI

Mikser ships an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server in core. Enable it with `--mcp` and any MCP-compatible client — Claude Desktop, Claude Code, ChatGPT, a custom agent — can drive mikser the same way a developer would: list entities, read content, write new files, render layouts, watch logs as they happen.

This page is a tour: what MCP is in mikser-shaped terms, how to turn it on, what tools are available out of the box, and ten end-to-end scenarios from "preview an invoice" to "audit my entire catalog."

## What MCP gives mikser

Two channels:

1. **Tools** — RPC-style functions the AI can call. Mikser ships five plus a liveness probe; every plugin can add more via `mcp.simpleTool(...)`. Tools are the verbs: *list*, *read*, *update*, *delete*, *render*.

2. **Logs** — every line mikser writes to its pino logger is broadcast as a `notifications/message` to every connected MCP client. When an AI builds a doc and the render fails, the AI sees the same `Render error: /documents/about.md ...` line that you would see in your terminal.

The transport is HTTP — the `--mcp [path]` option mounts the MCP endpoint on the same Express app that `--server` creates. Default path is `/mcp`. Same CORS, same port, same lifecycle.

> **Trust model.** MCP is in-process. Whoever can reach the `/mcp` endpoint already controls the engine — no per-tool token check, no per-endpoint scope. The HTTP `/api` plane keeps its token gate; that's for *frontends*. For untrusted AI access, put `/mcp` behind your reverse proxy's auth layer.

## Turning it on

```bash
# Default port (3001) and path (/mcp), open (no token):
mikser --server --mcp

# Custom path:
mikser --server --mcp /ai

# Programmatic:
import { setup } from 'mikser-io'
await setup({ server: 3001, mcp: true })
```

> **Single open endpoint is fine for loopback dev. For anything past loopback (ngrok, public reverse proxy, shared LAN) configure endpoints with tokens — next section.**

## Endpoints (token-gated + loopback-trusted, scoped tool surfaces)

Same shape as the api plugin's `endpoints` config: a named map, each entry with an optional `token` and a tool/resource scope.

### The auth rule

Uniform across both `mcp.endpoints` and `api.endpoints`. A request is allowed if **either**:

1. It carries a valid `Authorization: Bearer <token>` matching the endpoint's configured token, OR
2. It comes from a loopback address (`127.0.0.0/8`, `::1`, `::ffff:127.x.x.x`).

If neither holds, the request is rejected:

- Wrong token presented → `401 Invalid token` (intent to authenticate, must validate)
- No token from non-loopback → `403 Token required from non-loopback sources` (or, for endpoints with no token configured: *Endpoint accepts loopback connections only*)

This is the "trusted local host" model — same shape Postgres' trust-auth and Redis' default-no-password use. A process on the mikser host can hit any endpoint without the token; remote callers can't unless they have one. If a process on your host is hostile you have bigger problems than mikser's tools.

To bypass the loopback restriction for a specific endpoint (deliberate exposure, no token):

```js
intranet: {
    tools: ['mikser_ping'],
    allowRemote: true,   // explicit: I know this is open to the world
},
```

```js
// mikser.config.js
mcp: {
    base: '/mcp',                  // optional, default '/mcp'
    endpoints: {
        public: {
            tools: [
                'mikser_ping',
                'mikser_api_list_entities',
                'mikser_api_read_entity',
                'mikser_layouts_inspect',
            ],
            // No token → no auth header required
            // No resources field → all mikser:// resources visible
        },
        admin: {
            token: process.env.MIKSER_MCP_ADMIN_TOKEN,
            tools: ['mikser_*'],   // glob — every mikser tool
        },
    },
},
```

Produces:

| URL | Auth | Tool surface |
|---|---|---|
| `/mcp/public` | none | 4 read-only tools |
| `/mcp/admin` | `Authorization: Bearer <token>` | everything matching `mikser_*` |

Endpoint options:

| Field | Meaning | Default |
|---|---|---|
| `token` | Bearer token required for remote (non-loopback) access. Loopback is allowed without it. | unset |
| `allowRemote` | When `true`, no-token requests from non-loopback sources are allowed. Use deliberately. | `false` |
| `tools` | Tool name list or globs (via minimatch). `'*'` or omit for all. | `'*'` |
| `resources` | `mikser://` URI list or globs. `'*'` or omit for all. | `'*'` |

Glob patterns are useful because tool names embed plugin ownership:

- `mikser_api_*` — every tool from the api plugin
- `mikser_layouts_*` — every tool from the layouts plugin
- `mikser_*_render` — render-style actions across plugins (api's and preview's)
- `mikser_*_read*` — any read-shaped action (read_entity today, more later)
- `mikser_*` — everything mikser exposes

### Client configuration

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mikser-public": {
      "url": "http://localhost:3001/mcp/public"
    },
    "mikser-admin": {
      "url": "http://localhost:3001/mcp/admin",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

**Claude Code** (`.claude/settings.json`): same shape as above under the `mcpServers` key.

**curl probe:**

```bash
# Public — works without auth
curl -X POST http://localhost:3001/mcp/public \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}'

# Admin — without token → 401; with token → full surface
curl -X POST http://localhost:3001/mcp/admin \
  -H "Authorization: Bearer $MIKSER_MCP_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}'
```

### Boot log

```
MCP endpoint mounted: /mcp/public   (tools=[mikser_ping,...] [public, loopback-only])
MCP endpoint mounted: /mcp/intranet (tools=[mikser_ping]     [public, REMOTE OPEN])
MCP endpoint mounted: /mcp/admin    (tools=[mikser_*]        [token])
```

The bracketed label is the reachability state — `loopback-only` is the safe default, `REMOTE OPEN` is the deliberate opt-in, `token` means the endpoint is gated.

### A few things worth knowing

- **Endpoints don't share sessions.** A client connected to `/mcp/public` has a separate MCP session from one connected to `/mcp/admin` — same engine underneath, but distinct session state, distinct tool surfaces, distinct logs (per-client log levels are per-session).
- **Behind a reverse proxy, set `server.trustProxy`.** Without it, mikser sees every request as coming from the proxy's loopback IP and the trusted-host fallback would let unauthenticated remote requests through. Set `runtime.config.server.trustProxy = 'loopback'` (proxy on the same host) or a CIDR for a known proxy IP range. Express's `trust proxy` semantics apply.
- **Token via header only.** No `?token=` query-param fallback — query params leak into reverse-proxy access logs. Header-only is non-negotiable.
- **Don't pass tokens via CLI flag.** Tokens live in config / env (`process.env.MIKSER_MCP_ADMIN_TOKEN`). CLI flags leak via `ps aux`.
- **Per-tool gating is per-endpoint.** A client either has access to an endpoint or doesn't, and the endpoint narrows the surface. If you want truly per-tool ACLs ("this token can call render but not delete"), use two endpoints with overlapping but distinct `tools` lists.
- **Generate tokens with `openssl rand -hex 32`** — 256 bits of randomness. Don't reuse production tokens in dev configs.
- **The loopback default protects accidents, not deliberate tunnels.** If you point nginx on `:443` at `127.0.0.1:3001`, mikser sees the connection as loopback and the trusted-host fallback applies. The right gate in that case is a token. Don't deploy mikser publicly through a tunnel and rely on the loopback default.

Test it from the command line:

```bash
curl -X POST http://localhost:3001/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```

You'll get an SSE response with the server identity and your session id. From a real client (Claude Desktop, etc.), just point at `http://localhost:3001/mcp`.

## Tools by plugin

Tool ownership follows the plugin that owns the concept. Core ships one tool (the liveness probe); the rest come from whatever plugins are loaded. This is the same pattern as HTTP routes — plugins compose their surface, the engine doesn't enumerate it.

**Core substrate:**

| Tool                  | What it does                                                                          |
| --------------------- | ------------------------------------------------------------------------------------- |
| `mikser_ping`         | Engine identity + current lifecycle phase + `--server` URL (if running). Liveness check. |

**`api` plugin** (catalog read/write):

| Tool                  | What it does                                                                          |
| --------------------- | ------------------------------------------------------------------------------------- |
| `mikser_api_list_entities`| Paginated list of catalog entities with sift-compatible filter, sort, projection.     |
| `mikser_api_read_entity`  | Read one entity by id. Pass `include: ["content"]` to also fetch the source file (text formats only). |
| `mikser_api_update_entity`| Write/overwrite a content file inside a collection. Triggers a new lifecycle cycle.   |
| `mikser_api_delete_entity`| Remove a content file from a collection.                                              |
| `mikser_api_render`       | Render a transient entity through the full pipeline and return the produced bytes.    |

**`layouts` plugin** (template introspection):

| Tool                    | What it does                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `mikser_layouts_inspect` | Returns a layout's template source, the variables it references, its expected postprocessor, and sample entities currently using it. Use before drafting a preview to learn what data shape the layout expects. |

**`preview` plugin** (transient render + clickable URL, and inline UI blocks):

| Tool              | What it does                                                                          |
| ----------------- | ------------------------------------------------------------------------------------- |
| `mikser_preview_render`  | Render an entity AND surface the output at a clickable `http://localhost:<port>/preview/<id>.<ext>` URL. Previews live in memory (not on disk, never under `outputFolder`), auto-expire (default 10 min), and LRU-evict past a 100 MB cap. Requires `--server`. |
| `mikser_preview_ui`      | Render an entity to **inline HTML** using a layout that declares `mcpUi` frontmatter, and return it as a UI block the host can surface inside the conversation. Selects the layout by matching `entityId` against `layout.meta.match` and filtering on `mode` (`preview` / `edit` / `approval` / your own). Returns the rendered HTML plus action metadata (postMessage names the UI emits, sandbox flags) so the host can wire up an interactive iframe. See [Layout frontmatter](#layout-frontmatter-and-mcp-ui) below. |

Other plugins are expected to follow the same shape — `vector` will add `find_similar`, `schemas` will add `list_schemas` / `get_schema_shape`, and so on.

## Layout frontmatter and MCP-UI

mikser layouts can carry YAML frontmatter just like documents do. The frontmatter plugin lifts it into `entity.meta`, where any consumer can read it without coordinating with anyone else. `mikser_preview_ui` consumes one specific namespace: `meta.mcpUi`.

```hbs
---
match: "@/articles/*"
mcpUi:
  mode: preview                # or "edit", "approval", or your own
  description: "Article preview with approve/reject controls"
  actions:                     # postMessage names the UI emits
    - approve
    - reject
  sandbox:                     # iframe sandbox flags the host should apply
    - allow-scripts
---
<!DOCTYPE html>
<html>
  <body>
    <article>{{document.meta.title}}</article>
    <button data-action="approve">Approve</button>
    <button data-action="reject">Reject</button>
    <script>
      document.querySelectorAll('[data-action]').forEach(b =>
        b.addEventListener('click', () => window.parent.postMessage({
          type: 'mcp-ui/action',
          action: b.dataset.action,
          entityId: {{{json document.id}}},
        }, '*'))
      )
    </script>
  </body>
</html>
```

When the agent calls `mikser_preview_ui({ entityId: '/articles/launch', mode: 'preview' })`:

1. The plugin walks the catalog for layouts where `meta.mcpUi.mode === 'preview'`.
2. Among those, it picks the one whose `meta.match` pattern matches the entity (using mikser's `matchEntity` — same matcher used by the layouts plugin).
3. It runs the layout through the renderer chain (`render-hbs`, `render-eta`, `render-liquid`, etc.) and returns the HTML inline plus `_meta.mcpUi` containing the declared actions and sandbox flags.

A few constraints worth knowing when authoring `mcpUi` layouts:

- **The iframe has no `fetch`.** Hosts sandbox UI blocks tightly — assume no network from inside the rendered HTML. Use `postMessage` to send actions back; the host bridges them to the tool result.
- **Same layout system, different output path.** The MCP-UI layout doesn't have to be the same file as your production layout; declare a focused, sandbox-safe variant under a distinct name. mikser's auto-match won't pick it up for normal rendering as long as the filename doesn't collide.
- **One source of truth for the body.** All renderers (`render-hbs`, `render-eta`, `render-liquid`) now read layout bodies from `entity.layout.content`. The frontmatter plugin strips the YAML before the renderer ever sees it.
- **ECT is the exception.** `mikser-io-render-ect` still file-loads layouts through ECT's own resolver, so YAML frontmatter on `.ect` layouts renders as literal text. Pick `hbs` / `eta` / `liquid` for layouts that need `mcpUi` frontmatter.

## Built-in resources

Five introspection resources ship with core — read-only views into the running engine. They use the `mikser://` scheme and return JSON.

| Resource                  | What it shows                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `mikser://lifecycle`      | Current lifecycle phase (`initialize`, `process`, `render`, etc.) — `null` between phases.      |
| `mikser://runtime`        | Resolved `runtime.options` — folders, plugins, server port, current phase.                      |
| `mikser://config`         | Effective `runtime.config` — the merged config plugins see, including per-plugin keys.          |
| `mikser://server`         | HTTP server location (`url`, `mcpUrl`, `serves`). Single-call answer to "where can outputs be seen?" |
| `mikser://logs/recent`    | Rolling 500-line buffer of log lines. Each carries `seq`, `level`, and `data.msg`.              |

Use the log buffer to debug failures that scrolled past the live `notifications/message` stream — e.g. an AI joining mid-cycle can read what happened before its session opened.

## Twelve scenarios

These are written as the conversation an operator would have with their AI. The arrows show the actual MCP tool calls the AI would emit.

### 1. "Show me every published blog post in English."

The AI translates the request into a single filter call:

```json
→ mikser_api_list_entities {
    "filter": { "collection": "documents", "meta.published": true, "meta.lang": "en" },
    "sort": { "meta.date": -1 },
    "fields": ["id", "meta.title", "meta.date"],
    "limit": 50
  }
```

The `fields` projection keeps the response small; the AI gets back a summary list and can decide which one to drill into.

### 2. "What does the about page look like? Render it for me."

Two-step: fetch the entity, then render it through the engine.

```json
→ mikser_api_read_entity { "id": "/documents/about.md" }
← { meta: {...}, content: "..." }

→ mikser_api_render { "entity": { ...the entity from step 1... }, "options": { "save": false } }
← { content: [{ type: "resource", resource: { mimeType: "text/html", text: "<html>..." } }] }
```

`save: false` tells the engine to render but skip the disk write — perfect for previews. The AI gets the rendered HTML inline and can paste it into the chat.

### 3. "Create a draft invoice layout and preview it with this customer data."

```json
→ mikser_api_update_entity {
    "collection": "layouts",
    "relativePath": "invoice-draft.hbs",
    "content": "<!DOCTYPE html>\n<h1>Invoice {{number}}</h1>\n..."
  }

→ mikser_api_render {
    "entity": {
      "id": "/preview/invoice-1.json",
      "collection": "documents",
      "format": "json",
      "meta": { "layout": "invoice-draft", "customer": "Acme Co.", "number": "INV-001" }
    },
    "options": { "save": false, "catalog": false, "postprocessor": "pdf" }
  }
← { content: [{ type: "resource", resource: { mimeType: "application/pdf", blob: "JVBERi0xLjQK..." } }] }
```

`catalog: false` keeps the catalog clean — the preview never persists. The PDF comes back as a base64 blob the AI can offer for download.

### 4. "Add this image to my files folder and use it in the homepage."

Files in mikser are just files on disk, so the AI uses `mikser_api_update_entity` for both writes:

```json
→ mikser_api_update_entity {
    "collection": "files",
    "relativePath": "images/hero.svg",
    "content": "<svg xmlns='http://www.w3.org/2000/svg'>...</svg>"
  }

→ mikser_api_read_entity { "id": "/documents/index.md" }
← { meta: { hero: null, ... }, content: "..." }

→ mikser_api_update_entity {
    "collection": "documents",
    "relativePath": "index.md",
    "content": "---\nhero: /files/images/hero.svg\n---\n# Welcome\n..."
  }
```

The next lifecycle cycle picks up both writes, re-renders the homepage with the new hero, and the asset pipeline runs its presets against the new SVG.

### 5. "Find every page that mentions our old company name."

```json
→ mikser_api_list_entities {
    "filter": { "content": { "$regex": "Acme Corp", "$options": "i" } },
    "fields": ["id", "meta.title"]
  }
```

Mikser stores rendered content on entities; sift's `$regex` matches against any dotted path. The AI gets a list of every doc that needs editing, then can loop and propose patches one by one.

### 6. "Watch what happens when I rebuild — explain any errors."

The AI doesn't have to call anything special. The moment its session is initialized, every log line the engine writes — debug, info, warn, error — streams to it as `notifications/message`. So a render failure like:

```
Render error: /documents/about.md (layouts/main.hbs:14:8) Helper "fmtDate" not defined
```

…lands in the AI's context the instant it happens. The AI can then call `mikser_api_read_entity` on `/layouts/main.hbs` to look at line 14 and propose a fix.

### 7. "Convert all my Markdown frontmatter from `date` to `publishedAt`."

The AI walks the catalog, reads each doc, rewrites it, and writes it back. No special migration tool — the same five verbs.

```json
→ mikser_api_list_entities {
    "filter": { "collection": "documents", "format": "md", "meta.date": { "$exists": true } },
    "fields": ["id"],
    "limit": 100
  }
← { items: [{ id: "/documents/2025/launch.md" }, ...] }

# For each:
→ mikser_api_read_entity { "id": "/documents/2025/launch.md" }
→ mikser_api_update_entity {
    "collection": "documents",
    "relativePath": "2025/launch.md",
    "content": "---\npublishedAt: 2025-04-12\n---\n# Launch\n..."
  }
```

If the AI gets it wrong on the first file, the user sees the diff in chat before approving the rest.

### 8. "Why didn't the navigation update?"

```json
→ mikser_ping
← { name: "mikser-io", version: "...", started: true, activeClients: 1 }

→ mikser_api_list_entities { "filter": { "id": "/documents/nav.yml" }, "fields": ["stamp", "time"] }
```

The AI checks the entity's `stamp` (last source change) against `time` (last cycle processed) and notices they're equal — there's nothing new to render. It can then check what *triggers* a nav refresh in the layouts and propose adding an explicit `runtime.process()` call.

### 9. "Clean up old test fixtures from the documents folder."

```json
→ mikser_api_list_entities {
    "filter": { "collection": "documents", "id": { "$regex": "^/documents/test-" } },
    "fields": ["id"]
  }
← { items: [{ id: "/documents/test-x.md" }, ...] }

# For each:
→ mikser_api_delete_entity { "collection": "documents", "relativePath": "test-x.md" }
```

Each delete removes the source file *and* prunes its rendered outputs from the manifest on the next cycle. The AI can ask for confirmation before destructive batches.

### 10. "Generate a sitemap of every published doc, grouped by language."

```json
→ mikser_api_list_entities {
    "filter": { "meta.published": true },
    "sort": { "meta.lang": 1, "meta.date": -1 },
    "fields": ["id", "meta.title", "meta.lang", "meta.href"],
    "limit": 100
  }
```

The AI groups the response by `meta.lang` and writes a single sitemap document back:

```json
→ mikser_api_update_entity {
    "collection": "documents",
    "relativePath": "sitemap.json",
    "content": "{\n  \"en\": [...],\n  \"bg\": [...]\n}"
  }
```

### 11. "Generate three layout variants for the same hero section. Show me previews."

```json
→ mikser_api_update_entity { "collection": "layouts", "relativePath": "hero-a.hbs", "content": "<!-- centered version -->..." }
→ mikser_api_update_entity { "collection": "layouts", "relativePath": "hero-b.hbs", "content": "<!-- left-aligned with image -->..." }
→ mikser_api_update_entity { "collection": "layouts", "relativePath": "hero-c.hbs", "content": "<!-- full-bleed video -->..." }

→ mikser_preview_render { "entity": { "id": "/preview-a.json", "collection": "documents", "format": "json", "meta": { "layout": "hero-a" } } }
→ mikser_preview_render { "entity": { "id": "/preview-b.json", "collection": "documents", "format": "json", "meta": { "layout": "hero-b" } } }
→ mikser_preview_render { "entity": { "id": "/preview-c.json", "collection": "documents", "format": "json", "meta": { "layout": "hero-c" } } }
```

Three writes + three renders, three HTML previews in the chat. The user picks one, the AI deletes the other two layouts.

### 12. "Audit my site for missing meta descriptions."

```json
→ mikser_api_list_entities {
    "filter": { "collection": "documents", "$or": [
      { "meta.description": { "$exists": false } },
      { "meta.description": "" }
    ]},
    "fields": ["id", "meta.title"]
  }
```

The AI gets the list, can `mikser_api_read_entity` each one to read its content, draft a description, and propose the edits in batch.

## Plugin authors: registering your own tools

The same shape as registering an HTTP route. Inside your plugin factory:

```js
import { whenMcpActive } from 'mikser-io'

export default (core) => {
    const { runtime, useLogger } = core

    whenMcpActive((mcp) => {
        mcp.simpleTool(
            'mything_estimate',
            'Estimate something specific to my plugin.',
            {
                input: z.string().describe('What to estimate.'),
            },
            async ({ input }) => ({
                content: [{ type: 'text', text: `Estimated: ${input}` }],
            }),
        )
    })
}
```

`whenMcpActive` only fires when the engine was started with `--mcp` — no need to guard manually. Tools registered after the substrate is up propagate to every already-connected client via `notifications/tools/list_changed`.

For the full surface — `registerTool`, `registerResource`, `registerPrompt` — see the [MCP SDK docs](https://github.com/modelcontextprotocol/typescript-sdk).

## Multiple clients, one engine

Mikser is single-tenant. The catalog, the file system, the lifecycle — there's one of each. The MCP substrate honors that: when multiple AI clients connect, they all see the same catalog state and they all receive every log line. There is no per-client view of "your" data.

The practical implication: if two clients call `mikser_api_update_entity` for the same file in the same second, the second write wins. No locking, no merge — same semantics as two editors saving the same file.

## Limitations and pitfalls

- **No streaming render output.** `mikser_api_render` returns the complete output as a single tool response. For very large renders (multi-MB PDFs), this is fine for chat clients but inappropriate as a load-bearing API. Use the HTTP `/api/<endpoint>/render` route for that.
- **No undo.** `mikser_api_delete_entity` is final. Wrap destructive flows in your client's confirmation UI.
- **Resources are not entities.** Four `mikser://` introspection resources ship with core — `mikser://lifecycle`, `mikser://runtime`, `mikser://config`, `mikser://logs/recent` — and surface engine state (current phase, options, merged config, rolling 500-line log buffer). They're for introspection, not catalog content. Don't conflate them with `mikser_api_read_entity`.
- **Late tool registration.** Plugins that register tools deep in `onLoaded` will only appear after their hook runs. Until then, `tools/list` won't include them. Clients should re-list on `notifications/tools/list_changed`.

## Why this is in core, not a plugin

See [ADR-0006](./decisions/0006-when-to-add-to-core.md). The short version: MCP is a transport (like HTTP), not domain logic. Every plugin wants the same instance. A plugin-of-plugins would be the wrong shape — same reasoning as why Express is engine-owned.
