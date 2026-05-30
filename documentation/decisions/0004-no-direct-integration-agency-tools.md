# ADR-0004 — No direct integration with other agency tools

**Status:** Accepted
**Date:** 2026

## Context

The agency runs multiple independent tools — mikser for content, whitebox for customer awareness and grounded analytics, and potentially others in the future. All of them are owned by the same team. The naive choice is to integrate them via shared libraries, shared types, or direct imports — "we own both, so why not?"

That choice has a known failure mode. Coupling two systems by shared code means each one's evolution drags the other along. Refactors become coordinated cross-project commits. Plugin authors on either side reach into shared types. The tools stop being independently usable. Eventually a single piece of work touches both repos and the integration *becomes* the platform.

The alternative is to keep the projects independent at the code level, and let them compose only via clean protocols (HTTP, webhooks, files). Integration happens through thin adapter plugins that live on one side and call the other via its public API.

This sounds more expensive — and is, marginally. But it preserves a critical property: each tool stays *standalone usable*. A client can adopt mikser without adopting whitebox, and vice versa. Each tool's principles stay enforceable independently. Either can be dropped from a stack without touching the other.

## Decision

Mikser and whitebox (and any future agency tool) are independent projects with no shared code. They compose via clean protocols only:

- HTTP / REST APIs
- Webhooks
- Files on a shared filesystem (where applicable)
- Event streams (when needed)

Cross-project integration happens through thin **adapter plugins** that live on one side and call the other via its public API. The other side has no awareness of the adapter.

No "agency-core" library. No shared types repository. No private cross-project npm packages.

This principle is generalizable: every future agency tool joins the same pattern. Independent project, clean protocol, optional adapter plugin.

## Consequences

**Easier:**
- Each tool evolves at its own pace. mikser's release cycle has no coupling to whitebox's.
- Either can be dropped from a client stack without touching the other.
- A developer can be productive on one without learning the other. Onboarding cost stays linear, not multiplicative.
- Each tool's principles stay enforceable independently (see ADR-0001 for mikser's; whitebox has its own equivalents).
- The integration boundary is a protocol, not an API surface — explicit, testable, versionable.
- Each tool can be open-sourced, sold, or shared with external developers independently of the others.

**Harder:**
- Per-client compositions are bespoke. Each client project has its own glue describing how its mikser instance talks to its whitebox instance. (This glue is small and per-project documentation covers it.)
- Cross-project changes (e.g., a new whitebox channel that mikser should know about) require coordinated protocol changes rather than a single PR.
- Some duplication of cross-cutting concerns. We accept this — both SDKs ship their own `MikserError`, for example, even though they could share one. The duplication cost is far smaller than the coupling cost would be.

## Examples

- `mikser-io-whitebox` plugin is a mikser-side adapter that pushes processed entities to a configured whitebox `feed` endpoint and uploads files to a `storage` endpoint. Whitebox doesn't know mikser exists; from its perspective, an HTTP client is hitting its API.
- The mikser SDKs (`mikser-io-sdk-api`, `mikser-io-sdk-vector`) are clients of mikser's HTTP API. They have no whitebox awareness.
- No shared types between mikser and whitebox. Each project has its own representations. Identity, content, entities — all distinct.
- No private cross-project library. The shared substrate between mikser and whitebox is *this ADR* and the design philosophy it encodes, not any code artifact.

## Watch for drift

The principle is violated whenever the temptation to share code crosses project boundaries. Pressure-test phrasing to recognize:

- "We're duplicating error handling between mikser and whitebox — should we share a base library?"
- "mikser-io-whitebox needs the whitebox identity types — let's import them"
- "Both projects need the same JWT verification — agency-core should hold it"
- "It would be simpler if mikser knew about whitebox passports directly"

Each of these proposes shared code. Each looks reasonable in isolation. Each, accepted, starts the drift toward the coupled-platform end-state we built two projects to avoid.

The single biggest sign of drift is a "common" package appearing as a dependency of more than one agency tool. The moment `agency-utils` or `agency-types` exists, the principle is violated. Reject it. Duplicate the code if you must; preserve the boundary.

The strongest integration is no integration. When two systems must talk, they talk via a protocol that neither owns the other's internals through. The protocol is small and explicit. The systems stay independent.

**Plugin caveat (this is *not* drift):** Adapter plugins like `mikser-io-whitebox` live entirely on one side. They are *mikser plugins* — they use whitebox via its public HTTP API and have no shared code with whitebox. This is the correct shape for integration. The asymmetry (one side has an adapter, the other doesn't know it exists) is a feature, not a bug.
