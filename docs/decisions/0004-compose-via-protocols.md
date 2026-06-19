# ADR-0004 — Compose with external systems via clean protocols, not shared code

**Status:** Accepted
**Date:** 2026

## Context

Real projects rarely use mikser in isolation. A client site typically composes mikser with a customer-data system, an analytics layer, an email-sending platform, payment processors, search indexes, and so on. Some of these are vendor products; some are internal tools owned by the same team that owns mikser.

The naive integration choice — especially for internal tools — is to share code. Shared types, shared utility libraries, direct imports between projects. "We own both, so why not?"

That choice has a known failure mode. Coupling two systems by shared code means each one's evolution drags the other along. Refactors become coordinated cross-project commits. Plugin authors on either side reach into shared types. Eventually a single piece of work touches both repos, and the integration *becomes* the platform.

The alternative is to keep mikser independent at the code level, and compose with other systems only via clean protocols (HTTP, webhooks, files, event streams). Integration with any external system happens through a thin adapter plugin that lives on the mikser side and calls the other system via its public API.

This applies symmetrically: mikser also exposes its own clean protocols (the `api` plugin, the SDKs, the static output, the file tree) and other systems consume those — they don't reach into mikser internals.

## Decision

Mikser does not share code with any external system, internal or vendor:

- No shared type packages between mikser and any other project.
- No shared utility libraries imported from a private "common" repo.
- No direct module imports from another project's source.

Composition with external systems happens through:

- **HTTP / REST APIs** — both as consumer (via plugins calling out) and as producer (via mikser's `api` plugin)
- **Webhooks** — external systems push events into mikser via the api plugin; mikser plugins push events out via outbound HTTP
- **Files** — the rendered output, the data exports, the static catalog
- **Event streams** — when streaming semantics matter (mikser exposes SSE via the api plugin)

Where an integration is needed, it lives as a **mikser plugin** that calls the external system's public API. The external system has no awareness of mikser; the asymmetry — one side has an adapter, the other doesn't know it exists — is a feature.

## Consequences

**Easier:**
- Mikser evolves at its own pace, with no coupling to other systems' release cycles.
- Any external system can be swapped without touching mikser core.
- A developer can be productive on mikser without learning the systems it composes with.
- Mikser's principles (see ADR-0001, ADR-0002, ADR-0003) stay enforceable independently — no external concerns leak in.
- The integration boundary is a protocol, not an API surface — explicit, testable, versionable.

**Harder:**
- Compositions are per-project. Each client project has its own configuration describing how its mikser instance talks to the rest of the stack.
- Cross-project changes (a new field in an external system that mikser should know about) require protocol changes rather than a single PR across shared code.
- Some duplication of cross-cutting concerns. We accept this — both SDKs ship their own `MikserError`, for example, even though they could share one. Duplication cost is far smaller than coupling cost.

## Examples in the codebase

- Adapter-shaped plugins exist for several external integrations. Each lives entirely on the mikser side; the external system has no knowledge of mikser.
- The `api` plugin exposes mikser's content to anything that can speak HTTP — frontends, dashboards, other services. They consume; mikser doesn't import their types.
- The two SDKs (`mikser-io-sdk-api`, `mikser-io-sdk-vector`) are HTTP clients of mikser. They have no awareness of what consumes them.
- No private cross-project npm packages appear in any mikser plugin's dependency tree.

## Watch for drift

The principle is violated whenever the temptation to share code crosses project boundaries. Pressure-test phrasing to recognize:

- "We're duplicating error handling between mikser and \<other system\> — should we share a base library?"
- "This plugin needs the other system's identity types — let's import them"
- "Both projects need the same JWT verification — common-lib should hold it"
- "It would be simpler if mikser knew about \<other system\>'s concepts directly"

Each of these proposes shared code. Each looks reasonable in isolation. Each, accepted, starts the drift toward a coupled-platform end-state.

The single biggest sign of drift is a "common" or "shared" package appearing as a dependency of mikser and another project. The moment any cross-project library exists, the principle has been violated. Reject it. Duplicate the code if you must; preserve the boundary.

**The strongest integration is no integration at all.** When mikser must talk to another system, they talk via a protocol that neither owns the other's internals through. The protocol is small and explicit. The systems stay independent.

**Adapter plugins are not drift.** An integration plugin that calls another system's HTTP API while living entirely inside mikser (no shared code, no shared types) is the correct shape. The asymmetry (mikser has an adapter; the other side doesn't know mikser exists) is what keeps both systems independently usable.
