# Mikser Cloud — Planning (stub)

**The shift in one line:** mikser stops being only a CLI/library you install and becomes a hosted product. Pre-configured appliances (invoices, blog, photos, pkm, ...) run as managed containers; a hosted `party-mikser-io` instance orchestrates them per tenant. The OSS substrate doesn't change — cloud is a product built on it, not an extension of it.

This is a strategic stub, not a technical plan. Cloud isn't versioned alongside `mikser-io` (engine versions and product versions iterate independently). The document exists to stake the architectural boundary and name the hard problems before any cloud code gets written.

## The discipline this stub enforces

**OSS earns cloud, not the other way around.** Cloud doesn't get built until `mikser-io` 10.0 has been used in real workloads by users who didn't pay for it. Building cloud on an untested substrate compounds risk — every cloud assumption built on an unvalidated substrate assumption is a refactor waiting to happen.

The boundary check at any cloud-era PR: **does this code reference cloud concepts? If yes → wrong repo unless that repo is `mikser-cloud` or an appliance repo.** No multi-tenancy, no billing hooks, no platform observability in `mikser-io` or `party-mikser-io`.

## What cloud cleanly is

| layer | what ships | where it lives |
|---|---|---|
| **Hosted runtime** | Containers running mikser appliances. Persistent storage for files + `runtime/`. Health probes. Restart semantics. | `mikser-cloud` |
| **Appliances** | Pre-configured mikser images, one per problem domain. Each is `mikser-io` + opinionated plugin set + sample config + starter folder structure. | `mikser-appliance-<name>` per repo |
| **Party as a service** | Per-tenant hosted `party-mikser-io` instance. Routes discovery / refs / subscribe between the tenant's appliances. | `mikser-cloud` (uses party-mikser-io as a library) |
| **Control plane** | Web UI: spin up an appliance, connect it to others, expose to an MCP agent, billing, auth, tenant isolation. | `mikser-cloud` |

## Initial appliance set

Each is its own product (own repo, own README, own sample data, own support burden). Underestimating this is the easy mistake — five appliances = five products to maintain.

| appliance | plugin set | the problem it solves |
|---|---|---|
| `mikser-appliance-blog` | documents, files, layouts, front-matter, yaml, render-hbs, render-markdown, vector, api, mcp | personal/team blog with semantic search and AI agent integration |
| `mikser-appliance-invoices` | files, csv, ocr, extract, transformers, schemas, render-csv, api, mcp | drop PDF invoices → typed catalog → exportable CSV → agent answers questions |
| `mikser-appliance-photos` | files, assets, transformers (image embeddings), vector, api, mcp | drop photo folder → semantic search by description |
| `mikser-appliance-pkm` | documents, front-matter, yaml, json, layouts, render-markdown, render-hbs, vector, mcp | obsidian-shaped knowledge base with AI agent |
| `mikser-appliance-dms` | files, ocr, extract, transformers, schemas, vector, api, mcp | document management: drop arbitrary docs → typed extraction → searchable archive |

Each appliance is opinionated. The point of an appliance is "you don't configure plugins, you don't pick a layout engine, you just use it." Power users still get `mikser-io` standalone with full control; appliances are the easy path.

## Hard problems cloud forces us to confront

Not dealbreakers, but real. Each one needs a designed answer before cloud launches.

### Files-as-source-of-truth in a container

The whole `mikser-io` pitch is "drop files in a folder." In a container, where IS that folder?

Options (each with cost):

- **Mounted persistent volume (EBS / pd / etc.)** — simplest mental model. Files live on a real disk per appliance. User edits via web upload or sync agent. Cost: scales per-appliance, snapshot/backup is the platform's problem.
- **S3-backed FS (s3fs / goofys / mountpoint-s3)** — files live in object storage. Cheap, infinite, but file-system semantics are partial. Chokidar might not work cleanly; rename + metadata operations can be slow or non-atomic.
- **Git-synced** — appliance pulls from a user-provided git repo. File source-of-truth lives in git, not the container. Best for power users; weird for non-technical ones.
- **Web upload only** — appliance has a control-plane UI for managing files. No local "folder" per se. Cost: builds a CMS-shaped UI, which is a product surface unto itself.

Working assumption: **persistent volume + web upload UI for non-power-users, optional git sync for power users.** S3-backed FS isn't worth the file-system-semantics tax. **Decision deferred** until first appliance is built.

### Multi-tenancy in the party host

A central party host serving N tenants must route discovery + refs + subscribe per tenant. One user's appliances can't see another's, ever.

`party-mikser-io` itself doesn't need to know about tenants — it's per-process. The cloud's deployment is **one party-mikser-io process per tenant**, sitting in front of that tenant's appliance set. Cost: N processes for N tenants. At scale, that's a real ops bill.

Alternative: a multi-tenant party host with tenant-aware routing. Cost: complicates `party-mikser-io` with tenant-awareness it shouldn't have. Working bias: **per-tenant process** — keeps party-mikser-io clean. Revisit if economics force consolidation.

### Persistent state lifecycle

`runtime/mikser.sqlite` is the catalog cache. ADR-0002: files are truth, the cache is derived. But re-deriving 50k entities + refs + manifest on container restart takes minutes — that's a cold-start UX problem.

Cloud needs the cache to survive restarts. The container's persistent volume holds `runtime/` alongside the file folder. On restart, `mikser` reuses the cache and rebuilds incrementally. This already works in `mikser-io`; cloud just needs the volume mount.

The non-obvious bit: **`runtime/` is per-appliance, not per-tenant**. If a tenant has 3 appliances, that's 3 sqlite files in 3 volumes. Don't try to consolidate.

### Watch-mode vs push

Chokidar is right for a laptop. In cloud, file changes come from API uploads / git pulls / webhook syncs. The trigger model is different.

Easiest path: the sync layer drops files into the volume; chokidar sees them and triggers rebuild. Works out of the box. The sync layer is the cloud platform's problem, not the engine's.

Worth verifying once cloud starts: chokidar on a mounted volume behaves predictably across pod restarts.

### Billing surface

Per-appliance-hour? Per-entity? Per-render? Per-MCP-call?

Each metric is a different observability investment. Per-render and per-MCP-call require engine-side counters that don't exist today. Per-entity is weird (what's an entity, a row of a CSV?). Per-appliance-hour is the simplest honest unit and matches how the user thinks ("I have 3 appliances running").

Working assumption: **per-appliance-hour, with a generous free tier on the smallest plan size.** Per-call billing for the API tier comes later if usage patterns justify it.

### Open-core boundary

The standard hard question. Two cleanly defensible answers:

- **Convenience-only cloud (working bias).** Everything in OSS works standalone. Cloud sells hosting + the appliance catalog + the web UI + the hosted party-mikser-io. No engine feature is paid-only. The OSS substrate stays the same software cloud runs on; contributors stay aligned.
- **Open-core with paid features.** Some engine features (advanced auth, audit logging, SLA-level support) become cloud/enterprise-only. Cost: contributor alienation, harder to make external use feel first-class.

The convenience-only model has worked for many shops (Cloudron, PostHog, Plausible). The open-core model has worked for others (GitLab, Sentry). For mikser specifically — file-based, agent-native, small surface area — **convenience-only is probably right**, but the decision deserves a real conversation when cloud actually starts.

### Appliance lifecycle as a product surface

Each appliance is its own product. That means:

- Its own README + docs
- Sample folder structure shipped with the image
- Sample data for the demo experience
- Schema definitions (for OCR + extract appliances)
- Plugin pinning + version compatibility
- Security review per release
- Support tickets specific to that appliance's domain

Five appliances at launch = five product tracks. Realistically, **start with one or two** (probably `blog` and `invoices`), validate the appliance-shape pattern, then expand.

## What cloud needs from the substrate (forward-look only — no commit)

Things that *might* land in `mikser-io` or `party-mikser-io` to enable cloud. Each one passes the substrate test independently — they're not cloud-specific:

| candidate | substrate justification |
|---|---|
| `GET /api/health` endpoint in mikser-io-api | Operationally useful for any deployment, not just cloud. Probably trivial. |
| Env-var-based config overrides in mikser-io | Already useful for OSS users running in CI. Cloud just consumes the same surface. |
| `--rebuild` mode (one-shot rebuild on signal, no chokidar) | Useful for any CI / scheduled-build scenario. |
| Structured operation metrics (entities created/updated/rendered per cycle) — already partially via pino logs | Useful for any operator wanting observability. |
| `mikser.config.js` deriving from env vars cleanly | Already standard JS — no engine change needed. |
| `party-mikser-io` as a standalone server binary, not just a library | Useful for any self-hosted multi-mikser deployment, not just cloud. |

None of these get added pre-emptively for cloud. Each goes through the five-test framework on its own merits, and lands when an OSS user benefits.

## What cloud explicitly is NOT

- **Not an Anthropic / Notion / Glean clone.** Mikser cloud sells hosted mikser, with mikser's specific positioning (file-based, agent-native, OSS substrate). It's not a general note-taking SaaS.
- **Not a Backend-as-a-Service.** No exposed-to-end-users database API. Each tenant gets appliances, not raw catalog access (except via the appliance's own MCP + api surfaces).
- **Not a multi-tenant single mikser.** No shared substrate between tenants. Each tenant gets their own container(s); ADR-0002 (files-as-source-of-truth) means a shared catalog across tenants would conflate user data, which is operationally and legally fraught.
- **Not a competitor to plugin authors.** Anyone shipping a `mikser-io-<name>` plugin can also be an appliance author. The appliance catalog is open; we're not gatekeeping the ecosystem.

## Out of scope (defer until cloud actually starts)

- Pricing — every dimension of it. Tiers, free-tier limits, overages, enterprise contracts. Real numbers need real cost data, which we won't have until we run actual appliances.
- Compliance posture (SOC 2, GDPR, HIPAA) — depends on which markets cloud targets. Decided when go-to-market is real.
- Geographic regions — same.
- White-label / self-hosted cloud for enterprises — possible product variant, but premature.
- Marketplace for third-party appliances — possible, but starting with first-party only is the sane shape.

## When this stub becomes a real plan

When two things are true:

1. `mikser-io` 10.0 has shipped and has at least one real-world deployment that isn't a toy example.
2. `party-mikser-io` has shipped and someone outside the immediate dev circle has composed two miksers without help.

If both of those are true, the substrate is validated enough that cloud can build on it confidently. This stub becomes `CLOUD-PLAN.md` proper, with timelines, appliance prioritization, and pricing dimensions.

Until both are true, this document exists to keep cloud as a coherent direction without distorting current engine work. That's the whole purpose of the stub.
