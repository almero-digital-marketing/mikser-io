# ADR-0002 — Files are the source of truth for content

**Status:** Accepted
**Date:** 2026

## Context

Vendor CMSes store content in their own database with their own schema. Migration off-platform is hard — export tooling is rarely lossless, schemas don't translate cleanly, embedded references break. Even where vendors offer "git-backed" content, the canonical state still lives in their database; the files are a mirror, not the source.

This creates an asymmetry: vendors win when content lives in their store (lock-in), and users lose when they need to leave (migration cost). The asymmetry is structural, not malicious — but it's still asymmetric.

The opposite end of the spectrum: content lives as files on disk, in standard formats (Markdown, YAML), with the build engine being the only consumer. Anyone with a text editor and a shell can read, modify, copy, archive, or migrate the content. The build engine is incidental.

This second model has trade-offs (no transactional writes, no high-frequency mutation), but it inverts the lock-in: the content is portable on day one and on year ten.

## Decision

All content sources are stored as plain files on disk:

- `.md` for prose with YAML front-matter
- `.yml` for structured records
- `.html` for rich documents
- Other formats via plugins (`.eta`, `.liquid`, etc. for templates; binary files for assets)

The rendered output is also plain files (HTML, PDF, JSON, etc.). The whole content tree is copyable, diffable, git-trackable.

No database holds primary content. The catalog (sqlite, under `runtimeFolder`) holds *derived* state for build performance — every entity in the catalog is rebuildable from the file tree.

## Consequences

**Easier:**
- Content is portable on day one and on year ten. `cp -r`, `git clone`, or `rsync` is the export.
- Version control of content is git, with all its tooling — blame, diff, branches, PRs.
- Migration off mikser is "find a build tool that reads markdown." No proprietary export step.
- Concurrent edits via git or via the Decap editorial workflow work naturally.
- Backup of content is the file tree. No DB dump pipeline.
- The shape of the content is visible to humans, grep, AI tools — see ADR-0001's framing on AI-assisted development.

**Harder:**
- No transactional guarantees on content writes. Sequential writes can race; we rely on the watcher for eventual consistency rather than a transactional substrate.
- Per-document updates rewrite the whole file. Fine for human-paced editing; wrong shape for telemetry or high-frequency mutation.
- Very large content sets (millions of documents) have filesystem limits. Sub-100k is comfortable; beyond that the filesystem becomes the bottleneck.

These costs are accepted because they're the right cost shape for *content-shaped* workloads (see ADR-0001). High-frequency mutation belongs in a different system entirely — not in mikser.

## Examples in the codebase

- Catalog (sqlite at `runtimeFolder/catalog.db`) holds derived metadata only — every row is rebuildable from files
- `--clear` wipes derived state; files are deliberately untouched
- Vector embeddings store the source object alongside the vector for fast retrieval, but the canonical source is always the file the embedding was derived from
- The `data` plugin writes JSON snapshots derived from files, never the reverse
- The `api` plugin's `update` / `delete` operations write through to the file, never around it (via `useCollection.write` / `useCollection.remove`)

## Watch for drift

The principle is violated when an API write persists content somewhere mikser knows but the file doesn't. Pressure-test phrasing to recognize:

- "Let's cache the user's edit in the catalog until they commit"
- "This metadata is too expensive to write to the file every time — let's keep it in the DB"
- "Users want to edit small things without round-tripping to a file write"

Each of these proposes a state that exists only in mikser's runtime. That state will get out of sync with files, will not survive a `--clear`, will not transfer to another machine, and will silently become the new source of truth — at which point the project has joined the CMSes it set out to replace.

The file is canonical. Writes go to the file first. The catalog reflects files, never overrides them.
