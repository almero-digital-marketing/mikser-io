# ADR-0006 — When to add to core

**Status:** Accepted
**Date:** 2026
**Supersedes:** —
**Superseded by:** —

## Context

Mikser's engine is small by design (ADR-0003) and gets smaller in spirit every time a plugin proves the lifecycle is open enough to host new capability without engine changes. Vector, decap, schemas all landed as plugins. The discipline is real: when a feature feels like it "needs" to be in core, the first instinct should be to try implementing it as a plugin and see whether the lifecycle stretches enough to host it.

But "no engine growth ever" is the wrong rule. Two infrastructure additions in this project's history have justifiably gone into core:

- **Express server bootstrap** — when `--server` is on, the engine creates an Express app and hands it to plugins via `runtime.options.app`. Plugins register routes; engine doesn't know what those routes do. This is *substrate*, not domain logic.
- **MCP server bootstrap** — same shape, different protocol. The engine creates an MCP server when `--mcp` is on and hands it to plugins via `runtime.options.mcp`. Plugins register tools and resources.

Both of these felt like "should they be plugins?" at first, and in both cases the answer turned out to be no — for the same set of reasons each time.

This ADR captures the reasoning chain that justifies a core addition, so future "should this go in core?" conversations don't re-litigate the same ground.

## Decision

A feature earns a place in the engine only if it passes all four of these tests:

**1. Is it protocol or substrate, not domain logic?**

Engine code should establish *how* things compose, not *what* they do. Express is substrate; routes are domain. MCP is substrate; tools are domain. Pino is substrate; what gets logged is domain. The lifecycle hook system itself is substrate. Anything that takes a position on what content looks like, how it should be rendered, or what business rules apply belongs in a plugin.

If you can describe the addition as "the engine provides X; plugins do Y on top of it," it's substrate. If the engine has to know things specific to a use case (rendering invoices, validating products, indexing certain fields), it's domain.

**2. Does it strengthen an existing strategic principle, or expand scope?**

Look at the live ADRs (content-layer-not-the-app, files-as-source-of-truth, plugins-independent, compose-via-protocols, engine-infrastructure-ready). A core addition should *reinforce* one or more of these — not undermine them, and not add a new strategic concern.

MCP in core strengthens AI-assisted development (a principle articulated in the README's "Built for AI-assisted development" section) by giving every plugin an AI-shaped surface for free. It doesn't add a new strategic concern; it makes an existing one operational.

If a proposed addition is shaped like "now mikser also does X," where X is a new category the project hasn't claimed, it's expanding scope. That fails the test — and the right answer is to either build X as a separate project (ADR-0004 territory) or leave it alone.

**3. Does the plugin alternative create a god-plugin or central-knowledge problem?**

The most common failure mode for "this should be a plugin" is the god-plugin: one plugin that has to know about every other plugin to do its job. The MCP example is sharp — if MCP were a plugin, it would need to know what tools to expose for the api plugin, the vector plugin, the schemas plugin, etc. That means either a central registry (which couples the MCP plugin to every other plugin's release cycle) or capability discovery via reflection (which is fragile).

Same for Express: a hypothetical "express plugin" would have to know to mount routes for api, vector, decap, etc. Cleanly avoiding this by having the engine provide the substrate and each plugin compose its own routes is what makes the architecture scale.

If the only way to make a feature a plugin is to give it knowledge of other plugins, it's a god-plugin and the substrate belongs in core.

**4. Can plugins compose into it independently?**

The good substrate-plugin pattern has these properties:
- A plugin can register on the substrate without knowing what other plugins are doing.
- Adding a new plugin automatically extends the substrate's surface.
- Removing a plugin removes its contributions cleanly.
- Two plugins can't accidentally collide unless they explicitly use the same namespace.

If a proposed addition has *any* of these failing — plugins need to coordinate, the substrate has ordering rules between plugins, adding a new plugin requires touching the substrate — it's not earning its place. Rework it until the four properties hold, or accept that it belongs as a plugin after all.

## All four, not three of four

The test is conjunctive. A feature that's substrate but expands strategic scope (1 yes, 2 no) is wrong. A feature that fits the strategy but is domain logic (1 no, 2 yes) is wrong. A feature that's substrate and strategic but where plugins can't compose cleanly (1 yes, 2 yes, 4 no) is wrong — refactor until all four hold or accept the plugin shape.

The bar is high on purpose. Mikser is six versions in and has had two engine additions that cleared it (Express, MCP). That's the rate we expect — rare, justified, documented.

## Consequences

**Easier:**
- Future "should this be in core?" conversations have a written test instead of relying on instinct.
- New engineers can reason about engine vs plugin choices without needing to absorb every past decision.
- The engine stays small even as the project grows, because the criteria for growth are clear and strict.

**Harder:**
- Features that *look* like they should be in core (because of "ergonomics" or "DRY") will get rejected. That's the intent — those usually become plugins or shared helpers (like `useSource`), not engine code.
- Genuinely good substrate ideas that fail one of the four tests will have to be refactored, sometimes substantially, before they can be accepted.

## Examples — past decisions revisited

**Express in core (passes all four).** Protocol substrate (HTTP); strengthens the run-anywhere CLI principle; "express plugin" would be a god-plugin; api/vector/decap/etc. compose routes independently. Earned its place.

**MCP in core (passes all four).** Protocol substrate (JSON-RPC over HTTP/stdio); strengthens AI-assisted-dev; "mcp plugin" would be a god-plugin; api/vector/schemas/etc. compose tools independently. Earns its place.

**useSource as core helper (debatable; passes 1, 2, 4; doesn't quite pass 3).** Helper code, not substrate (no, fails 1). But also not domain logic. The plugin alternative isn't a god-plugin; it's just code duplication. We added it as a core export because the duplication was real and the surface was small. This is the closest the rule has come to a borderline call. Living with the decision; would lean toward making it a separately-published `mikser-io-source-helper` package if we did it again.

**Vector store in core (would fail).** Vector storage is *domain* — embeddings + similarity search are specific decisions about a specific kind of data. Plugin is the right shape; the vector plugin's swap from sqlite-vec to pgvector with zero engine changes proves it.

**A formal admin UI in core (would fail).** Editorial UI is domain (specific decisions about UX, auth, workflows). Belongs as a plugin or as integration with an external tool (decap). The engine has no business knowing what an admin form looks like.

## Watch for drift

Most "let's add this to core" proposals will be:

- "It's just easier to put it in core" — ease alone never passes the test
- "Multiple plugins need this code" — that's what shared helpers are for, not core
- "It's only a few lines" — irrelevant; the cost is permanent surface, not LOC
- "It's hard to express as a plugin" — try harder, or accept that it's god-plugin territory
- "Users keep asking for it" — that's a plugin or an integration, not an engine concern

The drift looks like core slowly absorbing things "for convenience." The discipline is to keep saying no until the four tests genuinely pass. The ADR is the test.
