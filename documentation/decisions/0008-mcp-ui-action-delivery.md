# ADR-0008 — MCP-UI: spec-compatible shell + `tools/call` delivery + optional webhook

**Status:** Accepted
**Date:** 2026
**Supersedes:** —
**Superseded by:** —

## Context

ADR-0007 (`MCP-UI: layouts as the agent's UI surface`) introduced the idea that mikser layouts can serve as the agent's UI surface inside an MCP host. The `mikser_preview_ui` tool renders an `mcpUi`-decorated layout against an entity and returns HTML for the host to surface as a sandboxed iframe. The user interacts with the iframe — clicks Approve, fills a form, picks a status — and the click needs to get back to mikser as a structured tool result.

Three facts about the surrounding ecosystem shape this decision:

1. **The MCP Apps spec ([2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)) defines how iframe-to-server delivery works.** The iframe runs as an MCP client speaking JSON-RPC over `window.parent.postMessage` to the host. The host's "AppBridge" translates `tools/call` frames into real MCP tool calls on the existing transport. Every conformant host (Goose, ChatGPT/Apps SDK, mcp-ui's reference host, basic-host, VS Code Insiders) implements this same pattern.

2. **The spec mandates the iframe is cross-origin from the host with a restrictive default CSP.** "The Host and the Sandbox MUST have different origins." Default CSP when `ui.csp` is omitted: `default-src 'none'; connect-src 'none'`. So a `fetch` to mikser from inside the iframe — even on the same machine — is blocked by the browser. The only outbound channel is `postMessage`.

3. **The spec mandates that UI is delivered as a static *resource*, not inline tool-result HTML.** Tools that want UI declare `_meta.ui.resourceUri` on their tool definition, pointing at a `ui://` resource with `mimeType: 'text/html;profile=mcp-app'`. Spec-conformant hosts fetch that resource once via `resources/read`, load it in a sandboxed iframe, then push the tool's per-call result to the iframe via `ui/notifications/tool-result`. Empirically, hosts like basic-host display tools that lack `_meta.ui.resourceUri` as plain text rather than rendering an iframe — even if `content[0]` declares `mimeType: 'text/html'`.

These three facts together rule out two tempting alternatives:

- **An in-process HTTP endpoint that the iframe POSTs to**, with a server-minted "callId" as the capability URL. Prototyped on `feat/mcp-ui-handler`, ruled out — incompatible with `connect-src 'none'`, invisible to the host's consent/audit surface, inverts every other MCP App implementation in the ecosystem.
- **Returning the rendered HTML inline as `content[0].text` and trusting hosts to render it.** Initially shipped in 8.0.x; surfaced as the symptom "basic-host received the tool result but shows it as text, not an iframe." Spec-conformant hosts need the resource URI on the tool definition; they ignore content with `mimeType: 'text/html'` when no resource URI is set.

Separately, productized workflows want to intercept the action server-side without forcing the agent to learn application-specific schemas — a CRM, support system, or admin tool wants to receive the click, do its work, and return a domain-specific result. Pure relay (mikser returns the click data, agent decides what `approve` means) is right for AI-native workflows; webhook delegation (mikser forwards the click to an external URL) is right for productized ones. We want both, without turning mikser into a workflow engine.

## Decision

### Part A — Rendering: static shell resource + structured tool result

**A1. Mikser ships a single static UI resource: `ui://mikser/preview-ui-shell`.**

```js
mcp.registerResource(
    'mikser-preview-ui-shell',
    'ui://mikser/preview-ui-shell',
    { mimeType: 'text/html;profile=mcp-app', ... },
    async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: SHELL_HTML }],
    }),
)
```

The shell is ~120 lines of self-contained HTML+JS implementing the MCP Apps protocol:

- Sends `ui/initialize` to the host on load (2-second timeout, fails open if no host replies).
- Listens for `ui/notifications/tool-result`. Reads `structuredContent.html` from the result and injects it into a `#mikser-ui-root` div. Re-executes any `<script>` tags the layout brought (innerHTML doesn't execute embedded scripts by default).
- Exposes `window.sendAction(action, payload?)` — the API layouts use to deliver clicks back as `tools/call` against `mikser_ui_action`. The shell tracks `entityId` and `layoutId` from the tool result, so layouts don't have to.
- Renders an in-iframe debug panel showing every protocol event with timestamps — so authors can see exactly where the round-trip fails on hosts that don't bridge.

The shell is static. It does not change between tool calls, between entities, or between mikser versions. It is a fixed bundle of protocol plumbing.

**A2. `mikser_preview_ui` declares `_meta.ui.resourceUri` pointing at the shell.**

```js
mcp.registerTool('mikser_preview_ui', {
    description: '...',
    inputSchema: { entityId, mode },
    _meta: {
        ui: { resourceUri: 'ui://mikser/preview-ui-shell' },
    },
}, handler)
```

This is the spec-mandated signal that this tool renders UI. Hosts that implement MCP Apps fetch the resource once via `resources/read` and use it as the iframe template for every call to this tool. Hosts that don't implement MCP Apps display `content[0].text` as plain text (the fallback path; better than nothing).

**A3. The tool result returns content + `structuredContent`.**

```jsonc
{
    "content": [
        { "type": "text", "text": "<rendered fragment>", "mimeType": "text/html" }
    ],
    "structuredContent": {
        "entityId": "/blog/launch.md",
        "layoutId": "/layouts/mcp-ui/post-approval.hbs",
        "mode": "approval",
        "html": "<rendered fragment>",
        "mcpUi": { "actions": [...], "sandbox": [...], "actionTool": "mikser_ui_action" }
    },
    "_meta": { "mcpUi": { ... } }
}
```

`content[0].text` is the fallback for non-UI hosts. `structuredContent` is what the host passes to the iframe via `ui/notifications/tool-result`. The shell reads `structuredContent.html` and injects it; it reads `entityId` and `layoutId` to scope subsequent `sendAction` calls.

**A4. Layouts are body fragments, not full HTML documents.**

The shell wraps `<!DOCTYPE>` / `<html>` / `<head>` / `<body>` around the injected content. Layouts produce a fragment containing inline `<style>`, body content, and optional inline `<script>`. The script can call `sendAction(action, payload?)` directly — it's exposed on `window` by the shell. No protocol code, no `ui/initialize`, no RPC helper, no postMessage shape.

Compare a layout authored before this ADR (~85 lines) with one authored after (~40 lines): everything below `<style>` stays; everything above `<style>` and the entire 50-line protocol `<script>` block disappears.

### Part B — Action delivery: `tools/call` against `mikser_ui_action` (visibility=['app'])

**B1. Mikser registers a separate, app-callable tool: `mikser_ui_action`.**

```js
mcp.registerTool('mikser_ui_action', {
    description: '...',
    inputSchema: { entityId, layoutId, action, payload },
    _meta: { ui: { visibility: ['app'] } },
}, handler)
```

`visibility: ['app']` makes the tool invisible to the agent — it never appears in the agent's tool surface — but callable from inside iframes via the host's AppBridge. The agent sees the result as a normal tool turn in its conversation.

**B2. The action allow-list is the auth boundary.**

`mikser_ui_action`'s handler looks up the layout by `layoutId`, reads its `mcpUi.actions` list, and rejects any action not in that list with an error result. This is the single place where layout-declared "you can do these things" meets iframe-supplied "I want to do this thing." Unknown actions never reach pure relay, never reach `handler.url`.

**B3. There is no callId, no signature, no token on this channel.**

The host's MCP transport is already authenticated. The visibility flag already gates which tools the iframe can invoke. The action allow-list already scopes what the iframe can ask for. Layered defenses; no per-call crypto.

**B4. There is no in-process HTTP endpoint for action delivery.**

`/api/mcp-ui/action/...` does not exist. Adding one would create a second delivery path with a different auth model, double the test surface, and offer no benefit on conformant hosts (CSP blocks the fetch) or non-conformant ones (the iframe wouldn't render anyway). One channel, one auth model.

### Part C — Optional webhook handler

**C1. Layouts may declare a `handler` block in their `mcpUi` frontmatter.**

```yaml
---
match: "@/articles/*"
mcpUi:
  mode: approval
  actions: [approve, reject, request-changes]
  sandbox: [allow-scripts]
  handler:
    url:     https://app.example.com/mikser-actions
    secret:  ${MIKSER_HANDLER_SECRET}    # optional, enables HMAC signing
    timeout: 5000                        # optional, ms; default 5000
---
```

When `handler.url` is set, `mikser_ui_action`'s handler forwards the action data to that URL instead of returning the pure-relay payload. The handler's JSON response body becomes the tool result.

**C2. The forwarded request is a standard webhook.**

```http
POST https://app.example.com/mikser-actions
Content-Type: application/json
X-Mikser-Signature: sha256=...
X-Mikser-Request-Id: <opaque uuid for idempotency>
X-Mikser-Layout-Id: /layouts/mcp-ui/post-approval.hbs
X-Mikser-Mode: approval

{
    "entityId": "/documents/blog/launch.md",
    "layoutId": "/layouts/mcp-ui/post-approval.hbs",
    "action":   "approve",
    "payload":  {},
    "mode":     "approval",
    "timestamp": "2026-06-07T15:00:00Z"
}
```

`X-Mikser-Signature` is HMAC-SHA256 of the request body using `handler.secret`. Receivers verify before processing. If `secret` is unset, no signature is sent — fine for development; not recommended in production.

**C3. The handler's JSON response is the tool result.**

```json
{
    "ok": true,
    "summary": "Committed to main; deployment queued (build #4821).",
    "url": "https://app.example.com/deploys/4821",
    "_meta": { "buildId": 4821 }
}
```

Mikser passes this through to the agent unchanged. The agent composes its next message from it. No domain knowledge in mikser.

**C4. Handler failures fall back to pure relay.**

Network error, timeout, non-2xx response, non-JSON response: mikser logs a warning and resolves the tool call with the default `{ entityId, action, payload }` plus a `handlerError` field carrying the failure reason. The user's click is never lost.

```json
{
    "entityId": "/documents/blog/launch.md",
    "action":   "approve",
    "payload":  {},
    "handlerError": "Handler timeout (5000ms) — https://app.example.com/mikser-actions"
}
```

**C5. The handler block is the entire extension surface.**

Mikser does not learn about action semantics — what `approve` means, what `request-changes` should do, where the result goes. Adding that knowledge to mikser would violate ADR-0001 (`Mikser is the content layer of the application, not the app`). The webhook contract IS the extension point; if you want behaviour, write a service.

## Consequences

**Easier:**

- Spec compliance is unconditional. Spec-conformant hosts (Goose, ChatGPT, mcp-ui's reference host, basic-host, VS Code Insiders) render mikser layouts as iframes correctly. No host-specific shims.
- Layouts shrink dramatically — no more per-layout 50-line protocol boilerplate. Author content + inline styles + click handlers; the shell handles everything else. Comparing the blog example's `post-approval.hbs` v8.0.x vs v8.1.0: ~85 lines → ~40 lines, roughly half. The protocol bug surface collapses to one place.
- The action allow-list + visibility flag are the entire auth model. No bespoke crypto primitive to debug.
- One static resource served forever; one tool result shape that's the same on every call. Cacheable, predictable, testable.

**Harder:**

- Layouts authored before 8.1.0 — full HTML documents with embedded `ui/initialize` and RPC plumbing — need rewriting. The new shape is mechanically simpler but it is *not* drop-in compatible with 8.0.x layouts. Mikser's blog example layouts ship pre-rewritten as canonical references.
- Hosts that haven't implemented MCP Apps (`Claude Desktop` per the open `upstream-host` bug [anthropics/claude-ai-mcp#165](https://github.com/anthropics/claude-ai-mcp/issues/165)) show the iframe as raw text. There is no fallback — and that's deliberate. Both alternatives explored above introduce more problems than they solve.
- The shell's debug panel is on by default. Production use will want to either gate it behind a query param or remove it entirely. Tracked as a follow-up.

## Examples

See `documentation/mcp.md` "Layout frontmatter and MCP-UI" — every worked example was rewritten when this ADR landed. Each one collapses to roughly 30-50 lines including inline styles.

## Alternatives considered

**Direct HTTP from iframe to mikser (capability URL pattern).** Prototyped on `feat/mcp-ui-handler`. Random callId, single-use, action allow-list, loopback bind — textbook capability URL, genuinely secure against CSRF/replay/unknown-actions. Ruled out because:

1. Default MCP Apps CSP is `connect-src 'none'` — the browser blocks the fetch on conformant hosts.
2. The iframe is cross-origin from the host by spec — there is no "same-origin" with mikser to leverage.
3. The action bypasses the host's audit/consent surface.
4. It inverts the direction of every other MCP App implementation, making mikser layouts non-portable.

**Returning HTML inline in `content[0].text` with `mimeType: 'text/html'`.** Shipped initially in 8.0.x. Surfaced as the symptom "basic-host received the tool result, displayed it as plain text, never rendered an iframe." Conformant hosts read `_meta.ui.resourceUri` off the tool definition (static) to decide what iframe template to load — they do not infer it from response content. The fix is the resource pattern in Part A.

**Per-layout tools (`mikser_preview_approval`, `mikser_preview_edit`, etc.) each with their own static `_meta.ui.resourceUri`.** Cleaner mapping but tool count grows with layout count, and the agent has to learn which tool handles which mode. The shell-as-template approach keeps the agent's tool surface stable (one `mikser_preview_ui` for all UIs) while still satisfying the spec's static-URI requirement.

**Dual-channel (postMessage primary, HTTP fallback).** Rejected as "no legacy" — two delivery paths means two auth models, two test surfaces, two failure modes to debug, and no host where both are needed. Pick one channel; pick the one the spec specifies.

**Built-in action vocabulary (mikser knows what `approve` / `reject` mean).** Rejected. This is the application layer; mikser is the content layer (ADR-0001). The agent owns semantics by default; `handler.url` is the escape hatch for productized cases.

**Server-side handler scripts (layouts ship a `handler:` callback in JS).** Rejected. Same reasoning — mikser would become a workflow engine. External webhooks compose; in-mikser handlers would couple action behaviour to mikser deployment.

**Per-action handlers (`handler` is a map: `{ approve: url1, reject: url2 }`).** Rejected as YAGNI. Single URL with the action in the payload is enough — the receiver multiplexes.

## Watch for drift

These are the failure modes this decision is protecting against. If you see them, push back.

- **The shell grows application-specific knowledge.** Someone proposes "the shell could pre-format the date before injecting" or "the shell could add a global retry banner." Refuse. The shell is protocol + injection + sendAction relay. Application concerns live in layouts.
- **A second action-delivery channel sneaks in.** Someone notices `mikser_ui_action` doesn't work on a non-conformant host and proposes adding an HTTP endpoint as a "fallback." Don't. The 8.1.0 design is one channel by deliberate choice.
- **`_meta.ui.resourceUri` drift on the tool definition.** Someone removes it or changes it to point at something dynamic. Spec-conformant hosts will stop rendering iframes — they only read this field at tool-list time, not per-call.
- **Layouts start re-implementing the protocol.** Someone writes a layout with its own `ui/initialize` handshake "for control." That layout will fight the shell. The shell exposes `sendAction`; that's the entire contract a layout uses.
- **The visibility flag drifts on `mikser_ui_action`.** If `_meta.ui.visibility` is removed or changed to `['model', 'app']`, the tool leaks into the agent's surface — it'll appear as an action the agent can take "out of context" without any iframe ever rendering. Strict `['app']`.
- **Action vocabulary creeps into core.** Someone proposes a built-in `approve` semantic so simple layouts don't need a handler. Refuse; that's application-layer logic.
- **Per-action handler URLs.** Someone proposes `handler: { approve: '...', reject: '...' }`. Refuse. One URL, the action goes in the payload, the receiver routes.
- **Retry / backoff on the handler.** Mikser doesn't retry. If the handler is down, the user re-clicks.
- **Persistent pending state.** There is no pending state — `mikser_preview_ui` returns synchronously and the shell handles per-render state in the iframe. Don't add a "pending action" table.
