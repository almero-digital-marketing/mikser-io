# ADR-0001 — Mikser is the content layer of the application, not the app

**Status:** Accepted
**Date:** 2026

## Context

Most CMS-shaped projects (Strapi, Payload, Sanity, Contentful) try to be "the backend." They absorb business logic via computed fields, hooks, workflows, user accounts, and transactions. This creates two recurring problems for projects that depend on them:

1. **Migration tax** — when the CMS reinvents itself (Strapi v3→v4, KeystoneJS 5→6, Ghost API rewrites), every consumer pays. Across an agency portfolio over 5–10 years this is not a one-time cost; it's a permanent tax.
2. **Inability to swap content sources** — because business logic lives inside the CMS, replacing the CMS means rebuilding the business logic. The "vendor lock-in" is in the business code, not the data.

The alternative is to treat content as one *layer* of an application, not the whole application. Define a small, defensible boundary; let everything else live elsewhere.

## Decision

Mikser handles only content-shaped concerns:

- Pages, documents, the published catalog
- Multi-format output generation (HTML, PDF, MJML email, etc.)
- Content-shaped query and search

Business logic lives in separate services owned by the application:

- User accounts, sessions, transactions
- Real-time application features (chat, presence, collaboration state)
- Custom workflows tied to business rules
- Customer data, identity, analytics (see ADR-0004 — these go in whitebox)

The SDKs (`mikser-io-sdk-api`, `mikser-io-sdk-vector`) are the seam between the two layers.

## Consequences

**Easier:**
- Each layer evolves independently. Business code can be rewritten without touching content; content can be migrated without rewriting business code.
- Application onboarding is smaller — engineers don't need to learn "the whole platform," just the layer they're working in.
- Multiple business systems can consume the same content. The content layer doesn't care.

**Harder:**
- Slightly higher upfront cost — two systems to deploy, two operational concerns.
- Requires active discipline at the seam — "what counts as content" is a recurring judgment call (see *Watch for drift*).
- Cannot use mikser alone as "the backend." Composition with other services is mandatory, not optional.

## Examples in the codebase

- No user accounts. The api plugin's only auth model is per-endpoint bearer tokens — for gating, not for identity.
- No transactional database for primary content. Files are the substrate (see ADR-0002).
- No business-rule plugins. There's no `mikser-io-discount-engine` or `mikser-io-loyalty-points`.
- Form submissions, comments, customer events all belong in whitebox, not mikser, even though they have a content-shaped HTML surface. The HTML *renders* in mikser; the data *lives* in whitebox.

## Watch for drift

Pressure-test phrasing to recognize:

- "Can we just add this user-related thing to mikser? It's only a small lookup."
- "We need a workflow for X — let's put it in a render hook."
- "The form already renders in mikser, can the submission live there too?"

The default answer is no. The framing — *content layer, not the app* — is a filter, not a slogan. Every time you use it, the framing gets stronger and the boundary stays defensible.

The single biggest sign of drift is mikser plugins starting to carry domain models that aren't content (carts, accounts, customers, transactions). When that happens the layer has been violated. Course-correct by moving the concern to the appropriate other system.
