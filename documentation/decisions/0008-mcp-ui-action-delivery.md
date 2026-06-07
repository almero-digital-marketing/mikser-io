# ADR-0008 — MCP-UI action delivery: spec-compatible `tools/call` + optional webhook handler

**Status:** Accepted
**Date:** 2026
**Supersedes:** —
**Superseded by:** —

## Context

ADR-0007 (`MCP-UI: layouts as the agent's UI surface`) and the `mikser_preview_ui` tool let an agent render an mcpUi layout as inline HTML for the host to surface as a sandboxed iframe. The user interacts with the iframe — clicks Approve, fills a form, picks a status — and the click needs to get back to mikser as a structured tool result.

Two facts about the surrounding ecosystem shape this decision:

1. **The MCP Apps spec ([2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)) defines how iframe-to-server delivery works.** The iframe runs as an MCP client speaking JSON-RPC over `window.parent.postMessage` to the host. The host's "AppBridge" translates `tools/call` frames into real MCP tool calls on the existing transport. Every conformant host (Claude Desktop, Claude.ai, ChatGPT/Apps SDK, Goose, mcp-ui's reference host) implements this same pattern.

2. **The spec mandates the iframe is cross-origin from the host with a restrictive default CSP.** "The Host and the Sandbox MUST have different origins." Default CSP when `ui.csp` is omitted: `default-src 'none'; connect-src 'none'`. So a `fetch` to mikser from inside the iframe — even on the same machine — is blocked by the browser. The only outbound channel is `postMessage`.

These two facts rule out a tempting alternative: an in-process HTTP endpoint that the iframe POSTs to, with a server-minted "callId" as the capability URL. That alternative was prototyped on the `feat/mcp-ui-handler` branch and ruled out in favour of spec compliance — explored, documented, never merged. The capability-URL pattern is secure (unguessable + single-use + action allowlist + loopback bind) but is incompatible with `connect-src 'none'`, invisible to the host's consent/audit surface, and inverts the direction of every other MCP App implementation in the ecosystem.

Separately, productized workflows want to intercept the action server-side without forcing the agent to learn application-specific schemas — a CRM, support system, or admin tool wants to receive the click, do its work, and return a domain-specific result. Pure relay (mikser returns the click data, agent decides what `approve` means) is right for AI-native workflows; webhook delegation (mikser forwards the click to an external URL) is right for productized ones. We want both, without turning mikser into a workflow engine.

## Decision

### Part A — Action delivery uses MCP Apps `tools/call` exclusively

**A1. `mikser_preview_ui` returns HTML synchronously.**

The tool resolves the moment the layout has rendered. No suspended promise, no pending map, no callId. The agent sees `mikser_preview_ui` as a normal, fast tool call that produces HTML + metadata. The user's click is its own tool turn later.

**A2. Mikser registers a separate, app-callable tool: `mikser_ui_action`.**

```js
mcp.registerTool('mikser_ui_action', {
    description: 'Deliver a user action emitted from an mcpUi iframe...',
    inputSchema: { entityId, layoutId, action, payload },
    _meta: { ui: { visibility: ['app'] } },   // ← MCP Apps spec
}, handler)
```

`visibility: ['app']` makes the tool invisible to the agent — it never appears in the agent's tool surface — but callable from inside iframes the host opened via `mikser_preview_ui`. The host's AppBridge bridges the iframe's `tools/call` postMessage frame into a real MCP tool call on the existing transport. The agent sees the result as a normal tool turn in its conversation.

**A3. The iframe's script speaks JSON-RPC over `postMessage`.**

The layout's `<script>` block performs the spec's `ui/initialize` handshake on load, then sends `tools/call` against `mikser_ui_action` for each click:

```js
window.parent.postMessage({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
        name: 'mikser_ui_action',
        arguments: { entityId, layoutId, action, payload },
    },
    id: ...,
}, hostOrigin)
```

There is no direct HTTP between iframe and mikser. There is no callId, no signature, no token. The host's MCP transport is already authenticated; the visibility flag already gates which tools the iframe can invoke; the action allow-list (Part A4) prevents a compromised iframe from invoking actions the layout did not declare.

**A4. The action allow-list is the auth boundary.**

`mikser_ui_action`'s handler looks up the layout by `layoutId`, reads its `mcpUi.actions` list, and rejects any action not in that list with an error result. This is the single place where layout-declared "you can do these things" meets iframe-supplied "I want to do this thing." Unknown actions never reach pure relay, never reach `handler.url`.

**A5. There is no in-process HTTP endpoint for action delivery.**

`/api/mcp-ui/action/...` does not exist. Adding one would create a second delivery path with a different auth model, double the test surface, and offer no benefit on conformant hosts (where it would be blocked by CSP) or non-conformant ones (where the iframe wouldn't run anyway). One channel, one auth model.

### Part B — Optional webhook handler

**B1. Layouts may declare a `handler` block in their mcpUi frontmatter.**

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

**B2. The forwarded request is a standard webhook.**

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

**B3. The handler's JSON response is the tool result.**

```json
{
    "ok": true,
    "summary": "Committed to main; deployment queued (build #4821).",
    "url": "https://app.example.com/deploys/4821",
    "_meta": { "buildId": 4821 }
}
```

Mikser passes this through to the agent unchanged. The agent composes its next message from it. No domain knowledge in mikser.

**B4. Handler failures fall back to pure relay.**

Network error, timeout, non-2xx response, non-JSON response: mikser logs a warning and resolves the tool call with the default `{ entityId, action, payload }` plus a `handlerError` field carrying the failure reason. The user's click is never lost.

```json
{
    "entityId": "/documents/blog/launch.md",
    "action":   "approve",
    "payload":  {},
    "handlerError": "Handler timeout (5000ms) — https://app.example.com/mikser-actions"
}
```

The agent decides whether to surface the error to the user, retry, or proceed without backend confirmation.

**B5. The handler block is the entire extension surface.**

Mikser does not learn about action semantics — what `approve` means, what `request-changes` should do, where the result goes. Adding that knowledge to mikser would violate ADR-0001 (`Mikser is the content layer of the application, not the app`). The webhook contract IS the extension point; if you want behaviour, write a service.

## Consequences

**Easier:**

- Spec compliance is free and unconditional. Every conformant MCP Apps host renders mikser layouts and bridges the action delivery correctly. No host-specific shims.
- The agent's view of the work is auditable — render and action are two distinct tool turns, both visible in the conversation log, both surface-able in the host's consent/audit UI.
- The auth model is the spec's auth model. Visibility metadata gates iframe-callable tools; the action allow-list scopes what the iframe can ask for. No bespoke crypto primitive to debug.
- No HTTP surface added to the engine; one fewer attack surface, one fewer thing to test, one less moving part during startup.

**Harder:**

- Layouts authored before the MCP Apps spec landed need their `<script>` blocks rewritten. The new shape is mechanically straightforward (handshake + RPC helper + `sendAction()`) but it is *not* what the 7.12.0 docs showed. Old layouts that posted `{type: 'mcp-ui/action', action, ...}` will not deliver to mikser until updated.
- Hosts that haven't implemented MCP Apps bridging show the iframe as raw text and the action stays inside the sandbox. There is no fallback — and that's deliberate (see "Alternatives considered" below).
- Local testing via `curl` no longer works as a delivery probe. To exercise `mikser_ui_action` outside an MCP host, invoke it directly through any MCP transport (stdio, HTTP MCP endpoint).

## Examples

**Default flow — no handler. Pure-relay; agent receives the click.**

```yaml
---
match: "@/blog/*"
mcpUi:
  mode: approval
  actions: [approve, reject]
  sandbox: [allow-scripts]
---
<!DOCTYPE html>
<html>
  <body>
    <article>{{document.meta.title}}</article>
    <button data-action="approve">Approve</button>
    <button data-action="reject">Reject</button>
    <script>
      // ui/initialize handshake + sendAction helper — see mcp.md
      // "Layout frontmatter and MCP-UI" for the canonical shape.
      const entityId = {{{json document.id}}}
      const layoutId = {{{json document.layout.id}}}
      // ... rpc helper ...
      const sendAction = (action, payload = {}) => rpc('tools/call', {
        name: 'mikser_ui_action',
        arguments: { entityId, layoutId, action, payload },
      })
      document.querySelectorAll('[data-action]').forEach(b =>
        b.addEventListener('click', () => sendAction(b.dataset.action)),
      )
    </script>
  </body>
</html>
```

Agent receives (as the `mikser_ui_action` tool result):
```json
{ "entityId": "/documents/blog/launch.md", "action": "approve", "payload": {} }
```

Agent decides the next step based on conversation context.

**With-handler flow — external app intercepts the click.**

```yaml
---
match: "@/posts/*"
mcpUi:
  mode: approval
  actions: [approve, reject, request-changes]
  sandbox: [allow-scripts]
  handler:
    url:     https://blog.example.com/mikser/post-action
    secret:  ${BLOG_HANDLER_SECRET}
---
<!-- Same script shape as above; the difference is server-side. -->
```

Mikser POSTs the action to `https://blog.example.com/mikser/post-action`. The receiver:

1. Verifies `X-Mikser-Signature`
2. Looks up the post by `entityId`
3. Calls its publish API for `approve`, archives for `reject`, files a comment for `request-changes`
4. Returns `{ "ok": true, "summary": "Published. Slack notification sent.", "url": "https://blog.example.com/posts/launch" }`

Agent sees the handler's response as the tool result and composes the user-facing message from it.

## Alternatives considered

**Direct HTTP from iframe to mikser (capability URL pattern).** Prototyped on `feat/mcp-ui-handler`. Random callId, single-use, action allow-list, loopback bind — textbook capability URL, genuinely secure against CSRF/replay/unknown-actions. Ruled out because:

1. Default MCP Apps CSP is `connect-src 'none'` — the browser blocks the fetch on conformant hosts.
2. The iframe is cross-origin from the host by spec — there is no "same-origin" with mikser to leverage.
3. The action bypasses the host's audit/consent surface — Claude Desktop's app-permissions UI hooks into the postMessage bridge, not into iframe-initiated HTTP.
4. It inverts the direction of every other MCP App implementation, making mikser layouts non-portable.

**Dual-channel (postMessage primary, HTTP fallback).** Rejected as "no legacy" — two delivery paths means two auth models, two test surfaces, two failure modes to debug, and no host where both are needed. Pick one channel; pick the one the spec specifies.

**Built-in action vocabulary (mikser knows what `approve` / `reject` mean).** Rejected. This is the application layer; mikser is the content layer (ADR-0001). The agent owns semantics by default; `handler.url` is the escape hatch for productized cases.

**Server-side handler scripts (layouts ship a `handler:` callback in JS).** Rejected. Same reasoning — mikser would become a workflow engine. External webhooks compose; in-mikser handlers would couple action behaviour to mikser deployment.

**Per-action handlers (`handler` is a map: `{ approve: url1, reject: url2 }`).** Rejected as YAGNI. Single URL with the action in the payload is enough — the receiver multiplexes. Adding per-action URLs encourages spreading application logic across the YAML.

**Bind `callId` to MCP session id for the HTTP fallback (a tightening for the rejected alternative above).** Not applicable — there is no HTTP fallback.

## Watch for drift

These are the failure modes this decision is protecting against. If you see them, push back.

- **A second action-delivery channel sneaks in.** Someone notices `mikser_ui_action` doesn't work on a non-conformant host and proposes adding an HTTP endpoint as a "fallback." Don't. The 7.13.0 design is one channel by deliberate choice. Adding fallbacks brings back every problem this ADR removed.
- **Action vocabulary creeps into core.** Someone proposes a built-in `approve` semantic so simple layouts don't need a handler. Refuse; that's application-layer logic. Either the agent decides (pure relay) or the handler decides (webhook). Mikser does not.
- **Per-action handler URLs.** Someone proposes `handler: { approve: '...', reject: '...' }`. Refuse. One URL, the action goes in the payload, the receiver routes. Multi-URL handlers spread routing logic across YAML files and across mikser/handler boundaries.
- **The visibility flag drifts.** Someone removes `_meta.ui.visibility = ['app']` from `mikser_ui_action`, or sets it to `['model', 'app']`. The first breaks every conformant host (the iframe can no longer invoke the tool); the second leaks the tool into the agent's surface, where it appears as an action it can take "out of context" without any iframe ever rendering.
- **Retry / backoff on the handler.** Mikser doesn't retry. If the handler is down, the user re-clicks. Retrying inside mikser couples retry behaviour to mikser config rather than to the application's reliability model, and silently turns a single click into N POSTs.
- **Persistent pending state.** There is no pending state — `mikser_preview_ui` returns synchronously. Don't add a "pending action" table to support some imagined replay scenario. The replay scenario is "user clicks again", which works correctly because actions are idempotent on the handler side (the handler decides).
