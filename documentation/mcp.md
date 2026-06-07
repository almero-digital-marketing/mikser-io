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
| `mikser_preview_ui`      | Render an entity to **inline HTML** using a layout that declares `mcpUi` frontmatter, and return it as a UI block the host surfaces in the conversation. Selects the layout by matching `entityId` against `layout.meta.match` and filtering on `mode` (`preview` / `edit` / `approval` / your own). Returns the rendered HTML plus action metadata (declared actions, sandbox flags, the action tool's name) so the host wires up an interactive iframe. The iframe delivers user clicks via **JSON-RPC over `postMessage`** per the [MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps) — the host bridges them as `tools/call` against `mikser_ui_action`. See [Layout frontmatter](#layout-frontmatter-and-mcp-ui) and [ADR-0008](./decisions/0008-mcp-ui-action-delivery.md). |
| `mikser_ui_action`       | **App-callable only.** Invisible to the agent (`_meta.ui.visibility=['app']` per MCP Apps spec). Iframes opened via `mikser_preview_ui` invoke this through the host's AppBridge to deliver a click. Validates the `action` against the layout's `mcpUi.actions` list, then either returns `{entityId, action, payload}` as a pure relay (the agent decides what it means) or forwards to the layout's `mcpUi.handler.url` webhook (HMAC-signed if `handler.secret` is set) and uses the handler's JSON response as the tool result. Handler failures fall back to pure-relay with a `handlerError` field — clicks are never lost. |

Other plugins are expected to follow the same shape — `vector` will add `find_similar`, `schemas` will add `list_schemas` / `get_schema_shape`, and so on.

## Layout frontmatter and MCP-UI

mikser layouts can carry YAML frontmatter just like documents do. The layouts plugin strips the frontmatter at read time and lifts the attributes into `entity.meta`, where any consumer can read them without coordinating with anyone else. `mikser_preview_ui` consumes one specific namespace: `meta.mcpUi`.

mikser ships a **single static shell resource** at `ui://mikser/preview-ui-shell` that implements the MCP Apps protocol (the spec-required `ui/initialize` handshake, the `ui/notifications/tool-result` listener that injects content, the `tools/call` relay for clicks). `mikser_preview_ui` declares `_meta.ui.resourceUri: 'ui://mikser/preview-ui-shell'`, so spec-conformant hosts fetch the shell once via `resources/read`, load it in a sandboxed iframe, then deliver the per-call rendered HTML to the iframe via `ui/notifications/tool-result`.

**That means your layouts are content-only.** No `<!DOCTYPE>`, no `<html>` / `<head>` / `<body>`, no MCP protocol script. The shell handles everything. Your layout produces a fragment that gets injected into the shell's `#mikser-ui-root` div. Click handlers call `sendAction(action, payload)` — exposed as a global by the shell — and the shell relays them to `mikser_ui_action` over `tools/call`.

```hbs
---
match: "@/articles/*"
mcpUi:
  mode: preview                # or "edit", "approval", or your own
  description: "Article preview with approve/reject controls"
  actions:                     # action names mikser_ui_action will accept
    - approve
    - reject
  sandbox:                     # iframe sandbox flags the host should apply
    - allow-scripts
  # handler:                   # optional — external webhook for the action
  #   url: https://review.example.com/mikser/action
  #   secret: env:REVIEW_SIGNING_SECRET
---
<article>{{document.meta.title}}</article>
<button data-action="approve">Approve</button>
<button data-action="reject">Reject</button>
<script>
  // sendAction(action, payload?) is provided by the shell. Call it from
  // any click handler. It returns a Promise that resolves with
  // mikser_ui_action's tool result (pure relay or handler-forwarded).
  document.querySelectorAll('[data-action]').forEach(b =>
    b.addEventListener('click', () => sendAction(b.dataset.action))
  )
</script>
```

That's an entire mcpUi layout. Compare with the v8.0.x version of this same example, which had ~50 lines of protocol boilerplate per layout — `ui/initialize` handshake, RPC helper, pending Map, postMessage shape. All of it lives in the shell now, so all layouts get the spec-correct protocol for free, and layout authoring is plain HTML + DOM.

**Discovery.** Before calling `mikser_preview_ui`, the agent should read `mikser://mcp-ui/modes` to see which modes are actually available in this project and which entity patterns each one covers. The resource is derived live from layout frontmatter, so adding a new `mcpUi`-decorated layout makes the new mode immediately discoverable — no tool re-registration, no restart.

**Dispatch.** When the agent calls `mikser_preview_ui({ entityId: '/articles/launch', mode: 'preview' })`:

1. The plugin walks the catalog for layouts where `meta.mcpUi.mode === 'preview'`.
2. Among those, it picks the one whose `meta.match` pattern matches the entity (using mikser's `matchEntity` — same matcher used by the layouts plugin).
3. It runs the layout through the renderer chain (`render-hbs`, `render-eta`, `render-liquid`, etc.) producing a **content fragment** — not a full document — for the entity.
4. It returns a tool result with: `content[0].text` = the rendered fragment (fallback for non-UI hosts), `structuredContent` = `{ html, entityId, layoutId, mode, mcpUi: {...} }` (what the iframe receives), and `_meta.ui.resourceUri` = `ui://mikser/preview-ui-shell` (on the tool definition, telling the host *which iframe* to render this into).

Spec-conformant hosts read the resourceUri off the tool, fetch the shell, load it in a sandboxed iframe, and post `structuredContent` to the iframe via `ui/notifications/tool-result`. The shell injects `structuredContent.html` into its root div. The user clicks; the shell calls `tools/call mikser_ui_action`; the host bridges that to mikser as a real MCP call. The agent sees two tool invocations in the conversation: the render, then the action. This is the [MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps) pull model — no suspended promises, no HTTP callbacks.

**Optional webhook handler.** A layout that declares `mcpUi.handler.url` makes `mikser_ui_action` forward each action to that URL (HMAC-signed if `handler.secret` is set, JSON body with `entityId`, `layoutId`, `action`, `payload`, `mode`, `timestamp`). The handler's JSON response becomes the tool result the agent sees. Handler failures fall back to pure-relay with a `handlerError` field — clicks are never silently lost. Mikser stays a content engine; application semantics live in the handler. See [ADR-0008](./decisions/0008-mcp-ui-action-delivery.md).

A few constraints worth knowing when authoring `mcpUi` layouts:

- **Layouts are body fragments, not full documents.** The shell wraps `<!DOCTYPE>` / `<html>` / `<head>` / `<body>` around your content. Adding them yourself is harmless but redundant — the host strips them during innerHTML injection. Inline `<style>` is fine (browsers honor it inside a div). Inline `<script>` is fine (the shell re-executes innerHTML-injected scripts so they take effect).
- **`sendAction(action, payload?)` is the only protocol API you need.** It's exposed on `window` by the shell. Returns a Promise resolving with `mikser_ui_action`'s tool result. The shell handles `ui/initialize`, target origins, timeouts, and the pending-id dance. Layouts that try to reimplement the protocol won't break, but they also don't gain anything.
- **The iframe is cross-origin from the host and the default CSP blocks all network.** Per MCP Apps spec, "The Host and the Sandbox MUST have different origins" and the default CSP is `default-src 'none'; connect-src 'none'`. So `fetch` to *any* URL from inside the iframe is blocked — including back to mikser. The shell's only outbound channel is `window.parent.postMessage`.
- **Same layout system, different output path.** The MCP-UI layout doesn't have to be the same file as your production layout; declare a focused, sandbox-safe variant under a distinct name. mikser's auto-match won't pick it up for normal rendering as long as the filename doesn't collide.
- **Frontmatter is stripped at read time.** The layouts plugin parses YAML inside `readLayoutContent`, populates `entity.meta`, and stores a clean body. The renderer never sees the YAML.
- **ECT is the exception.** `mikser-io-render-ect` still file-loads layouts through ECT's own resolver, so YAML frontmatter on `.ect` layouts renders as literal text. Pick `hbs` / `eta` / `liquid` for layouts that need `mcpUi` frontmatter.

### Worked examples

MCP-UI is a novel concept and the conventions get easier to internalise once you see them on real layouts. Seven examples below — varied template engines (`hbs`, `eta`, `liquid`), varied interaction patterns (pure render, single button, multi-action approval, form submission, multi-select picker, status switcher, multi-step wizard), varied domains (article, product, SEO, tags, support ticket, onboarding). Copy-and-modify is the intended workflow.

Each agent call looks like `mikser_preview_ui({ entityId: '...', mode: '<mode>' })`. The host renders the returned HTML in a sandboxed iframe. The iframe then speaks JSON-RPC over `postMessage` to the host (per the [MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps)) — each click becomes a `tools/call` against `mikser_ui_action`, which the host bridges to mikser over the normal MCP transport. Examples 2–7 use the same `sendAction(action, payload)` helper shown in the canonical sample above; the helper handles the `ui/initialize` handshake and the per-click RPC.

#### 1. Pure preview — no JS, no action

The minimum-viable case. The agent shows the user what an article looks like rendered; the user reads it; no interaction is needed. Use this when you just want a visual confirmation step.

```hbs
---
match: "@/articles/*"
mcpUi:
  mode: preview
  description: "Read-only article preview. Use to visually confirm a proposed edit before committing."
  actions: []
  sandbox: []
---
<style>
  article h1 { margin-bottom: 0.25em; }
  article .meta { color: #6b7280; font-size: 0.875em; margin-bottom: 1.5em; }
</style>
<article>
  <h1>{{document.meta.title}}</h1>
  <div class="meta">{{date document.meta.date 'MMMM D, YYYY'}}{{#if document.meta.author}} · by {{document.meta.author}}{{/if}}</div>
  <div>{{markdown document.content}}</div>
</article>
```

The empty `actions: []` and `sandbox: []` signal "this is read-only — no script execution needed." The agent invokes it and shows the result; the user reads it; the conversation continues. No back-channel.

#### 2. Single-action button — publish / unpublish

One button. One action name. Useful for binary state changes: publish a draft, archive a stale post, flag an issue.

```hbs
---
match: "@/products/*"
mcpUi:
  mode: publish-switch
  description: "Product publish switcher. Shows the current state and one button to flip it. Result includes the desired new state."
  actions: [toggle-publish]
  sandbox: [allow-scripts]
---
<style>
  body { font: 16px system-ui; padding: 2em; }
  #toggle { padding: 0.6em 1.4em; font-size: 1em; border: 0; border-radius: 4px; background: #2563eb; color: white; cursor: pointer; }
</style>
<h2>{{document.meta.title}}</h2>
<p>SKU: <code>{{document.meta.sku}}</code></p>
<p>Current status:
  {{#if document.meta.published}}
    <span style="color: #10b981;">● Published</span>
  {{else}}
    <span style="color: #6b7280;">● Draft</span>
  {{/if}}
</p>
<button id="toggle">
  {{#if document.meta.published}}Unpublish{{else}}Publish now{{/if}}
</button>
<script>
  document.getElementById('toggle').addEventListener('click', () =>
    sendAction('toggle-publish', { published: {{#if document.meta.published}}false{{else}}true{{/if}} })
  )
</script>
```

The payload includes the **desired new state**, computed by the template — so the agent doesn't have to flip the boolean itself. This is the cheapest pattern: one button, one structured result.

#### 3. Multi-action approval — approve / reject / request-changes

Three buttons, three actions. The agent's tool call resolves with whichever action the user clicked. Useful for moderation flows where the agent proposed an edit and wants explicit human consent.

```hbs
---
match: "@/blog/*"
mcpUi:
  mode: approval
  description: "Editorial approval for a blog post. Returns one of approve / reject / request-changes. For request-changes, payload includes a free-text note from the reviewer."
  actions: [approve, reject, request-changes]
  sandbox: [allow-scripts]
---
<style>
  body { font: 16px system-ui; max-width: 720px; margin: 2em auto; padding: 0 1em; }
  .actions { display: flex; gap: 0.5em; align-items: center; }
  .actions button { padding: 0.5em 1em; border: 0; border-radius: 4px; color: white; cursor: pointer; }
  .approve  { background: #10b981; }
  .reject   { background: #ef4444; }
  .changes  { background: #f59e0b; }
  textarea  { width: 100%; margin-top: 0.5em; padding: 0.5em; font: inherit; }
</style>
<article>
  <h1>{{document.meta.title}}</h1>
  <div style="color: #6b7280; margin-bottom: 1em;">{{date document.meta.date 'MMM D, YYYY'}}</div>
  <div>{{markdown document.content}}</div>
</article>

<hr style="margin: 2em 0; border: 0; border-top: 1px solid #e5e7eb;">

<div class="actions">
  <button class="approve" data-action="approve">Approve</button>
  <button class="reject"  data-action="reject">Reject</button>
  <button class="changes" data-action="request-changes">Request changes…</button>
</div>

<details style="margin-top: 1em;">
  <summary style="cursor: pointer; color: #6b7280;">Note for the author (only sent with "Request changes")</summary>
  <textarea id="note" rows="3"></textarea>
</details>

<script>
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action  = btn.dataset.action
      const payload = action === 'request-changes'
        ? { note: document.getElementById('note').value }
        : {}
      sendAction(action, payload)
    })
  })
</script>
```

Notice the structured payload only attaches when relevant. The agent's next step depends on the action: approve → publish; reject → log + notify; request-changes → re-edit with the note in context.

#### 4. Form submission — SEO fields (Liquid)

Show several fields with current values; collect edits; send a patch object back. Useful when the agent wants the user to fine-tune specific metadata without re-running an LLM pass.

```liquid
---
match: "@/articles/*"
mcpUi:
  mode: edit-seo
  description: "Edit SEO fields (title, description, og:image alt) inline. Result payload is a patch object with only the changed fields."
  actions: [save, cancel]
  sandbox: [allow-scripts]
---
<style>
  body { font: 16px system-ui; max-width: 600px; margin: 2em auto; padding: 0 1em; }
  form { display: grid; gap: 1em; }
  label > div { font-weight: 500; }
  input, textarea { width: 100%; padding: 0.5em; font: inherit; }
  .actions { display: flex; gap: 0.5em; margin-top: 0.5em; }
  .actions button { padding: 0.5em 1em; border: 0; border-radius: 4px; cursor: pointer; }
  .save   { background: #2563eb; color: white; }
  .cancel { background: #e5e7eb; }
</style>
<h2>SEO · {{ document.meta.title }}</h2>
<form id="seo">
  <label>
    <div>Title (max 60 chars)</div>
    <input name="seoTitle" value="{{ document.meta.seo.title }}" maxlength="60">
  </label>
  <label>
    <div>Description (max 160 chars)</div>
    <textarea name="seoDescription" rows="3" maxlength="160">{{ document.meta.seo.description }}</textarea>
  </label>
  <label>
    <div>OG image alt</div>
    <input name="ogImageAlt" value="{{ document.meta.seo.ogImageAlt }}">
  </label>
  <div class="actions">
    <button type="button" class="save"   data-action="save">Save</button>
    <button type="button" class="cancel" data-action="cancel">Cancel</button>
  </div>
</form>

<script>
  const initial = {
    seoTitle:       {{ document.meta.seo.title | json }},
    seoDescription: {{ document.meta.seo.description | json }},
    ogImageAlt:     {{ document.meta.seo.ogImageAlt | json }},
  }
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action
      const payload = {}
      if (action === 'save') {
        const fd = new FormData(document.getElementById('seo'))
        for (const [k, v] of fd.entries()) {
          if (v !== initial[k]) payload[k] = v   // diff: only send changed fields
        }
      }
      sendAction(action, payload)
    })
  })
</script>
```

Note the diff-on-submit: the layout sends only the fields the user actually changed. The agent's next step is `mikser_api_update_entity({ id: entityId, patch: payload.seo })` — surgical writes, no clobbering.

#### 5. Multi-select picker — tags (Eta)

Show available choices, let the user multi-select, send the final selection back. Eta syntax here for variety; same idea works in any engine.

```eta
---
match: "@/blog/*"
mcpUi:
  mode: tag-picker
  description: "Multi-select tag picker. Payload is the final array of tag slugs (not a diff)."
  actions: [save, cancel]
  sandbox: [allow-scripts]
---
<style>
  body { font: 16px system-ui; padding: 2em; max-width: 500px; }
  #tags { display: flex; flex-wrap: wrap; gap: 0.4em; margin: 1em 0; }
  #tags button { padding: 0.4em 0.8em; border-radius: 999px; border: 1px solid #d1d5db; background: white; color: #1f2937; cursor: pointer; }
  #tags button.selected { background: #2563eb; color: white; }
  .actions { display: flex; gap: 0.5em; }
  .actions button { padding: 0.5em 1em; border: 0; border-radius: 4px; cursor: pointer; }
  .save   { background: #10b981; color: white; }
  .cancel { background: #e5e7eb; }
</style>
<h3>Tags for: <%= it.document.meta.title %></h3>
<div id="tags">
  <% for (const tag of it.runtime.allTags || []) { %>
    <% const selected = (it.document.meta.tags || []).includes(tag) %>
    <button type="button" data-tag="<%= tag %>" class="<%= selected ? 'selected' : '' %>"><%= tag %></button>
  <% } %>
</div>
<div class="actions">
  <button class="save"   data-action="save">Save</button>
  <button class="cancel" data-action="cancel">Cancel</button>
</div>

<script>
  document.querySelectorAll('[data-tag]').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('selected'))
  })
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action
      const tags = Array.from(document.querySelectorAll('[data-tag].selected')).map(b => b.dataset.tag)
      sendAction(action, { tags })
    })
  })
</script>
```

`it.runtime.allTags` is exposed from a sidecar `tag-picker.eta.js` that populates the candidate list before render. The selection is sent as a flat array — the agent decides whether to compute a diff or just overwrite.

#### 6. Status switcher — support ticket triage

A row of mutually exclusive status options with the current one highlighted. One click → one action. Returns the chosen status as the payload.

```hbs
---
match: "@/support/tickets/*"
mcpUi:
  mode: triage
  description: "Set a support ticket's status. Returns one action `set-status` with the chosen value in payload.status."
  actions: [set-status]
  sandbox: [allow-scripts]
---
<style>
  body { font: 16px system-ui; padding: 2em; max-width: 600px; }
  .statuses { display: flex; gap: 0.5em; margin-top: 1.5em; }
  .statuses button { padding: 0.5em 1em; border: 0; border-radius: 4px; cursor: pointer; background: #e5e7eb; color: #1f2937; }
  .statuses button.current { background: #2563eb; color: white; }
  blockquote { border-left: 3px solid #e5e7eb; padding-left: 1em; margin: 1em 0; color: #4b5563; }
</style>
<h2>Ticket #{{document.meta.ticketId}}</h2>
<p style="color: #6b7280;">{{document.meta.subject}}</p>
<blockquote>{{document.meta.firstMessage}}</blockquote>

<div class="statuses">
  {{#each (array "open" "in-progress" "waiting-on-customer" "resolved" "won't-fix")}}
    <button data-status="{{this}}" class="{{#eq this ../document.meta.status}}current{{/eq}}">{{this}}</button>
  {{/each}}
</div>

<script>
  document.querySelectorAll('[data-status]').forEach(btn => {
    btn.addEventListener('click', () =>
      sendAction('set-status', { status: btn.dataset.status })
    )
  })
</script>
```

Single action with a parameterised payload — the user picks the value, the agent's next step is uniform regardless of which status was chosen.

#### 7. Multi-step wizard — onboarding flow

The iframe holds its own state across multiple steps; only the final submission calls `sendAction`. Good when the interaction is genuinely multi-step (multiple form pages, confirm-then-go) and bouncing through the agent between steps would be expensive.

```hbs
---
match: "@/onboarding/*"
mcpUi:
  mode: setup
  description: "Three-step onboarding wizard. The iframe handles steps internally; the agent only sees the final `complete` action with the merged answers, or `cancel` if abandoned."
  actions: [complete, cancel]
  sandbox: [allow-scripts]
---
<style>
  body { font: 16px system-ui; padding: 2em; max-width: 520px; }
  #progress { display: flex; gap: 0.25em; margin-bottom: 2em; }
  #progress > div { flex: 1; height: 4px; background: #e5e7eb; }
  input, select { width: 100%; padding: 0.5em; font: inherit; }
  .nav { display: flex; gap: 0.5em; margin-top: 2em; }
  .nav button { padding: 0.5em 1em; border: 0; border-radius: 4px; cursor: pointer; }
  #back   { background: #e5e7eb; }
  #next   { background: #2563eb; color: white; }
  #cancel { margin-left: auto; background: transparent; color: #6b7280; }
</style>

<div id="progress">
  <div data-step="1"></div>
  <div data-step="2"></div>
  <div data-step="3"></div>
</div>

<div data-step="1" class="step">
  <h2>What's your team name?</h2>
  <input name="teamName">
</div>
<div data-step="2" class="step" hidden>
  <h2>How many people?</h2>
  <input name="teamSize" type="number" min="1" max="10000">
</div>
<div data-step="3" class="step" hidden>
  <h2>Primary content type?</h2>
  <select name="contentType">
    <option>blog</option>
    <option>documentation</option>
    <option>marketing-site</option>
    <option>knowledge-base</option>
  </select>
</div>

<div class="nav">
  <button id="back" hidden>Back</button>
  <button id="next">Next</button>
  <button id="cancel">Cancel</button>
</div>

<script>
  const state = { step: 1, answers: {} }
  const totalSteps = 3
  function render() {
    document.querySelectorAll('[data-step].step').forEach(el => {
      el.hidden = Number(el.dataset.step) !== state.step
    })
    document.querySelectorAll('#progress [data-step]').forEach(el => {
      el.style.background = Number(el.dataset.step) <= state.step ? '#2563eb' : '#e5e7eb'
    })
    document.getElementById('back').hidden = state.step === 1
    document.getElementById('next').textContent = state.step === totalSteps ? 'Done' : 'Next'
  }
  function captureCurrent() {
    const input = document.querySelector(`[data-step="${state.step}"].step input, [data-step="${state.step}"].step select`)
    if (input) state.answers[input.name] = input.value
  }
  document.getElementById('next').addEventListener('click', () => {
    captureCurrent()
    if (state.step < totalSteps) { state.step++; render() }
    else { sendAction('complete', state.answers) }
  })
  document.getElementById('back').addEventListener('click', () => {
    captureCurrent(); state.step--; render()
  })
  document.getElementById('cancel').addEventListener('click', () => sendAction('cancel'))
  render()
</script>
```

State lives inside the iframe; the agent only sees the final merged answers (or `cancel`). One `mikser_ui_action` call covers the whole wizard. This pattern is worth it when the back-and-forth would otherwise burn 3–4 agent turns.

### Design principles

The seven examples above lean on the same conventions. Worth naming them so they're easy to extend.

- **`sendAction(action, payload?)` is the contract** — exposed on `window` by the shell at `ui://mikser/preview-ui-shell`. Layouts call it; the shell relays `tools/call` against `mikser_ui_action` to the host; the host bridges it to mikser. Returns a Promise resolving with `mikser_ui_action`'s tool result (pure relay or handler-forwarded). `action` MUST be a name declared in your layout's `mcpUi.actions` list — mikser rejects anything else and never invokes the optional `handler.url`. You don't need to thread `entityId` / `layoutId` yourself; the shell tracks both from `ui/notifications/tool-result`.
- **Layouts are body fragments, not full documents.** No `<!DOCTYPE>`, no `<html>` / `<head>` / `<body>` — the shell wraps your content. Inline `<style>` and `<script>` are fine and survive `innerHTML` injection (the shell re-executes scripts).
- **Embed entity data with `{{{json document.id}}}` (or the equivalent in your engine).** Triple-stash in Handlebars / `| json` in Liquid / `<%= JSON.stringify(it.x) %>` in Eta. Prevents injection if a field contains quotes — never interpolate raw string fields into a `'string-literal'` in script tags.
- **Pick the smallest sandbox that works.** Pure render: `sandbox: []` (no scripts at all). Click-only interaction: `sandbox: [allow-scripts]`. `postMessage` works at `allow-scripts` because it's not a network operation in the CSP sense. Don't ship `allow-same-origin` casually — it lifts most of the cross-origin protection the host's double-iframe setup gives you.
- **Send only what changed.** Multi-field forms (#4) should diff against the initial values and post only the deltas. Single-state toggles (#2, #6) send the target state, not the current state. Wizards (#7) send the merged final answers. Smaller payloads are cheaper for the agent to reason about.
- **Style inline, ship self-contained.** No external CSS, no web fonts, no analytics — the default MCP Apps CSP is `default-src 'none'; connect-src 'none'`. The shell's only outbound channel is `postMessage` to the host. System fonts (`font-family: system-ui`) and inline `<style>` are fine; everything else has to be embedded.
- **Use the layout body to compute what the agent shouldn't.** Example #2's payload pre-computes the *new* publish state. Example #4 pre-computes the diff. Pushing logic to render-time means the agent receives ready-to-act-on data rather than raw inputs it has to interpret.
- **Don't smuggle long content through the payload.** If the user types a 2000-word note, send back a reference id and call `mikser_api_read_entity` later — not as a single huge `payload.note` string. Tool results live in the agent's context window.
- **For external workflows, declare `mcpUi.handler.url` instead of teaching the agent the schema.** When a layout's action should hit your application server (Slack notification, JIRA transition, queue), set `handler.url` in the frontmatter. `mikser_ui_action` POSTs the action to that URL (HMAC-signed if `handler.secret` is set) and uses the response as the tool result. The agent stays generic; the application semantics stay in your service. Mikser stays a content engine.

These conventions aren't enforced by the engine — they're just what makes layouts compose with agents cleanly. The contract is the MCP Apps spec; mikser's role is to ship the shell (`ui://mikser/preview-ui-shell`), render the layout against the entity, and accept the resulting `tools/call`. Application semantics live either in the agent (pure-relay) or in your `handler.url` webhook — never in mikser.

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

Plugins can register their own resources under `mikser://`. The `preview` plugin ships one:

| Resource                  | What it shows                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `mikser://mcp-ui/modes`   | Live list of `mcpUi` modes and their candidate layouts (one entry per layout: id, match pattern, description, actions, sandbox flags). Derived from layout frontmatter at read time — newly added layouts show up without restarts. Read this before calling `mikser_preview_ui` to discover what the project supports instead of guessing mode names. |

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
