# ADR-0008 — MCP-UI action delivery: pure-relay default, optional webhook handler

**Status:** Accepted
**Date:** 2026
**Supersedes:** —
**Superseded by:** —

## Context

ADR-0007 (`MCP-UI: layouts as the agent's UI surface`) and the `mikser_preview_ui` tool shipped in 7.12.0 let an agent render an mcpUi layout as inline HTML for the host to surface as a sandboxed iframe. The user interacts with the iframe — clicks Approve, fills a form, picks a status — and the layout's `<script>` emits a structured `postMessage` event.

The 7.12.0 implementation returns the rendered HTML synchronously and resolves the tool call immediately. The agent never waits. From the agent's point of view, `mikser_preview_ui` finishes the moment the HTML is built; the user's click happens after the tool result has already been consumed and the agent has moved on.

Two consequences:

1. **The click goes nowhere.** Hosts with full Apps-extension support bridge the iframe's `postMessage` back to the agent as a synthetic message; hosts without that support drop the event silently. Either way, the click can't influence the in-flight tool call because there is no in-flight tool call by the time the click happens.

2. **The verification loop in the README is aspirational.** `documentation/mcp.md` describes a workflow where the agent renders an approval UI, the user clicks Approve, and the agent receives a structured `{ action: 'approve', payload: {} }` result it can act on. That workflow does not actually work end-to-end against any host today, even ones that fully implement the Apps extension — because the tool didn't ask to wait.

Separately, there's a design question about *what should happen* when the click arrives. Three plausible models:

- **Pure relay**: the tool result is the click data; the agent decides what `approve` means in context. Aligns with MCP's general philosophy (tools are primitives, agents are intelligence). Right for AI-native workflows.
- **Server-side handlers**: layout authors declare what each action does in mikser configuration. mikser executes the action. Right for productized workflows but turns mikser into an application server — violates ADR-0001 (`Mikser is the content layer of the application, not the app`).
- **Webhook delegation**: layout authors point at an external HTTP endpoint. mikser forwards the click; the external system decides what to do. Right for productized workflows where the application server is *separate* from mikser. Doesn't violate ADR-0001 because the application logic lives outside mikser.

The pure-relay model alone is sufficient for agent-driven workflows but leaves productized use cases (Slack-style chat, CRM, admin tool) needing to also intercept the click. The webhook model handles those without turning mikser into a workflow engine.

## Decision

### Part A — `mikser_preview_ui` becomes awaitable

**A1. The tool call suspends until an action arrives.**

`mikser_preview_ui` no longer resolves the moment the HTML is rendered. It generates a `callId`, registers a pending entry keyed by that id, injects the id into the render context so the iframe's script can address it, returns the HTML inside a tool-result envelope, and *waits*. The wait resolves when one of three things happens:

- A `POST /api/mcp-ui/action/<callId>` arrives with a valid action (success)
- The tool's `timeoutSeconds` elapses (timeout error)
- The tool call is cancelled by the host or agent (cancellation)

**A2. The iframe's script posts the action directly to mikser.**

`window.parent.postMessage(...)` is kept as a best-effort signal for hosts that bridge it, but the canonical delivery path is an HTTP POST from the iframe to mikser:

```js
fetch(`/api/mcp-ui/action/${callId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, entityId, payload }),
})
```

This works on every host that lets the iframe make same-origin fetch calls (which is all of them — the iframe is loaded from mikser's origin, so the fetch is same-origin). It does not depend on host-side Apps-extension support. The `postMessage` becomes purely an optimization for hosts that can act on it earlier.

**A3. The default tool result is a pure relay of the action data.**

Absent any webhook handler (Part B below), the resolved tool result has the shape:

```json
{
    "action": "approve",
    "entityId": "/documents/blog/launch.md",
    "payload": {}
}
```

The agent receives this and decides what `approve` means in the conversation's context. mikser has no opinion. The agent owns semantics.

**A4. Cleanup is bounded.**

The pending-action map is in-memory. Entries are removed when:

- The action POST is received and processed (success path)
- The configured timeout elapses (default: 300 seconds; configurable per call via `timeoutSeconds` parameter)
- The engine shuts down

There is no persistent state; an engine restart drops every pending tool call mid-flight. The agent sees a tool-call error and can retry. This is acceptable because tool calls already have host-side timeouts in the seconds-to-minutes range — mikser does not need to outlive the host's patience.

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

When `handler.url` is set, the action POST endpoint forwards the action data to that URL instead of resolving the tool call directly. The handler's response body becomes the tool result.

**B2. The forwarded request is a standard webhook.**

```http
POST https://app.example.com/mikser-actions
Content-Type: application/json
X-Mikser-Signature: sha256=...
X-Mikser-Request-Id: <opaque ulid for idempotency>
X-Mikser-Layout-Id: /layouts/mcp-ui/post-approval.hbs
X-Mikser-Mode: approval

{
    "callId":   "tool_01J...",
    "entityId": "/documents/blog/launch.md",
    "action":   "approve",
    "payload":  {},
    "timestamp": "2026-06-07T15:00:00Z",
    "agent": {
        "sessionId":  "...",
        "clientName": "Claude Desktop"
    }
}
```

`X-Mikser-Signature` is HMAC-SHA256 of the request body using `handler.secret`. Receivers verify before processing. If `secret` is unset, no signature is sent — fine for development; not recommended for production.

**B3. The handler's JSON response is the tool result.**

```json
{
    "ok": true,
    "summary": "Committed to main; deployment queued (build #4821).",
    "url": "https://app.example.com/deploys/4821",
    "_meta": { "buildId": 4821 }
}
```

mikser passes this through to the agent unchanged. The agent uses it to compose its next message ("I committed your edit; the deploy is at https://..."). No domain knowledge in mikser.

**B4. Handler failures fall back to pure relay.**

Network error, timeout, non-2xx response, non-JSON response: mikser logs a warning and resolves the tool call with the default `{ action, entityId, payload }` plus a `handlerError` field carrying the failure reason. The user's click is never lost.

```json
{
    "action": "approve",
    "entityId": "/documents/blog/launch.md",
    "payload": {},
    "handlerError": "ETIMEDOUT: handler did not respond within 5000ms"
}
```

The agent sees the error, can decide to surface it to the user, retry, or proceed without backend confirmation.

**B5. The handler block is the entire extension surface.**

There are no other handler-related fields. No conditional handlers, no per-action handlers (the receiver dispatches), no transformation rules, no retry policy. Anything richer is application logic and belongs in the receiver, not in mikser. See `Watch for drift` below.

## Consequences

**Easier:**

- The verification loop documented in `documentation/mcp.md` actually works. Agent calls `mikser_preview_ui`, user clicks, agent receives `{ action: 'approve' }` and acts on it.
- AI-native workflows have no boilerplate — same tool, same default result shape, no glue code per project.
- External applications (Slack-style chat, CRM, admin UI) can take ownership of action semantics with one frontmatter field, no plugin authoring.
- The escape hatch is fail-safe: a broken handler degrades to pure relay, never silent loss.
- mikser stays a content engine. No workflow DSL, no conditional execution, no business rules.

**Harder:**

- `mikser_preview_ui` is now stateful (pending action map) and async (waits for the POST). Test coverage needs to handle the new shapes — timeout, handler success, handler failure, double-POST race.
- The `/api/mcp-ui/action/:callId` endpoint is a new attack surface. Validation: callId must exist in the pending map (random IDs rejected); action must be in the layout's declared `actions` list (typo/abuse rejected). No data POSTed without an active tool call can take effect.
- HMAC signing requires layout authors to store `handler.secret` somewhere — environment variables, a secret manager. Adds operational complexity for production use.
- Engine restart drops in-flight pending tool calls. The agent gets a tool error and may retry; the user's click before restart is lost. Acceptable trade-off vs. building persistence; documented.
- Increased coupling between mikser and the iframe template: the script needs the `callId` injected. Layouts that opt into MCP-UI now need a small `<script>` block with a known shape. Existing layouts are unaffected; new layouts use the template documented in `mcp.md`.

## Examples

**Default flow — no handler. Pure-relay agent receives the click.**

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
      const callId    = {{{json data.callId}}}
      const entityId  = {{{json document.id}}}
      document.querySelectorAll('[data-action]').forEach(b => {
        b.addEventListener('click', () => {
          // postMessage for hosts that bridge it
          window.parent.postMessage({ type: 'mcp-ui/action', action: b.dataset.action, entityId }, '*')
          // canonical delivery — same-origin fetch
          fetch(`/api/mcp-ui/action/${callId}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: b.dataset.action, entityId, payload: {} }),
          })
        })
      })
    </script>
  </body>
</html>
```

Agent receives:
```json
{ "action": "approve", "entityId": "/documents/blog/launch.md", "payload": {} }
```

Agent decides the next step based on conversation context.

**With-handler flow — external app intercepts the click.**

```yaml
---
match: "@/posts/*"
mcpUi:
  mode: approval
  actions: [approve, reject]
  sandbox: [allow-scripts]
  handler:
    url:    https://my-app.example.com/posts/approve
    secret: ${MIKSER_HANDLER_SECRET}
---
```

mikser forwards the POST to `https://my-app.example.com/posts/approve`. Receiver does the work (commits, queues a job, sends a notification), returns:

```json
{
    "ok": true,
    "summary": "Committed e9a4f as main. Deploy started; ETA 90s.",
    "url": "https://my-app.example.com/deploys/482",
    "_meta": { "deployId": 482 }
}
```

Agent receives the above as the tool result; relays a meaningful message to the user.

**Handler down, fall back to default relay.**

If `https://my-app.example.com/posts/approve` returns 503 (or times out, or refuses connection), mikser resolves the tool call with:

```json
{
    "action": "approve",
    "entityId": "/documents/posts/launch.md",
    "payload": {},
    "handlerError": "ECONNREFUSED: handler at https://my-app.example.com/posts/approve unreachable"
}
```

Agent surfaces the error, suggests retrying or proceeding manually. The user's intent is preserved; no silent loss.

## Watch for drift

The discipline ADR-0001 (`Mikser is the content layer of the application, not the app`) makes a sharp line here. The temptations are real; the rules that resist them:

- **"Let's allow conditional handlers — different URL per action."** That's a routing DSL. The receiver is the right place to dispatch by action. Keep `handler.url` as a single URL per layout.
- **"Let's add retry/backoff for the webhook."** That's a queue. Mikser's job is to forward once with a clear timeout; if the receiver needs reliability, it owns the queue.
- **"Let's let the handler rewrite the action before the agent sees it."** That defeats Part A's pure-relay default — agents would never know what really happened. The receiver's response is what the agent sees, no in-between transformation.
- **"Let's add server-side scripting inside the layout — execute the handler logic without leaving mikser."** That's mikser becoming an application server. Layouts are templates. If you want logic, run it externally and point the handler at it.
- **"Let's persist the pending action map across restarts."** That's a database/queue, not an in-memory map. The cost-benefit doesn't justify it for action callbacks — restart-loses-pending is acceptable; restart-loses-content would not be.
- **"Let's add a built-in action-vocabulary — approve/reject/edit as first-class."** No. Action names are arbitrary strings. The layout author declares whatever vocabulary fits the use case (`publish`, `archive`, `assign-to-quentin`, …). mikser validates against the layout's declared `actions` list, nothing more.
- **"Let's stream the handler's response — progress events while it works."** Tempting for long-running backends; defer. Synchronous handler responses are simpler and cover the common case; long-running operations should return a `pollUrl` or similar in their response body and let the agent take over the wait via subsequent tool calls.
- **"The default tool result shape feels too minimal — let's add the rendered HTML as a field too."** The agent already has the HTML — it's what it returned to the host. Re-including it bloats every tool result. The pure-relay shape stays at `{ action, entityId, payload }`.
- **"What about authentication on the action POST itself? Anyone can POST to /api/mcp-ui/action/<callId>."** The callId is the auth — it's a random UUID minted per tool call, scoped to its layout's allowed actions. A POST with a stale or random callId returns 404. A POST with a valid callId but disallowed action returns 400. The threat model is "any user on localhost can POST" — same threat model as the existing /api/render route, mitigated by the local-only listener and the action-list whitelist.

The principle: mikser forwards a click to one URL with a fixed schema. What happens next is the external system's problem. Every additional knob on the mikser side is a step toward becoming an application server. The discipline is to keep the surface narrow even when convenience would argue for more.
