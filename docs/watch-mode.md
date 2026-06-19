# Watch Mode

Watch mode enables incremental builds: Mikser runs the full pipeline once at startup, then watches source folders for changes and re-runs only the process → render → finalize cycle when something changes.

## Enabling Watch Mode

```bash
mikser --watch
# or
mikser -w
```

Programmatically:

```js
const runtime = await setup({ watch: true })
await runtime.start()
```

## How It Works

```
startup
  └── full run: initialize → load → import → process → render → finalize
                                                                    │
                                                    ┌───────────────┘
                                                    ▼
                                          chokidar watchers active
                                          cron tasks start
                                                    │
                                          file change detected
                                                    │
                                          sync hook fires
                                                    │
                                          returns true → debounce 1s
                                                    │
                                          runtime.process()
                                          └── process → render → finalize
                                                                    │
                                                         ┌──────────┘
                                                         ▼
                                               waiting for next change
```

The import phase runs **only once** at startup. Subsequent cycles start from `process()`, which re-reads whatever was changed in the journal by the sync handlers.

The journal is the `mikser_journal` table in `runtime/mikser.sqlite` — so a crash mid-cycle leaves an inspectable record of what hadn't finalized yet, and `--resume` (below) picks up where the prior run left off.

## Resuming an interrupted run

```bash
mikser --watch --resume
# or short:
mikser -w -R
```

`--resume` does two things at startup:

1. **Keeps the leftover journal entries.** Without `--resume`, mikser warns and discards any rows the prior run wrote but never finalized. With `--resume`, those rows stay and the next cycle picks them up.
2. **Skips the initial filesystem scan.** The startup `source.sweep` is bypassed, so a 110k-entity corpus doesn't pay another minute of scan time just to confirm everything's the same as it was.

This is the right shape for two scenarios in particular:

- **PM2 / systemd / container restart loops.** Process gets killed mid-cycle by a deploy or an OOM-kill; the restart picks up the in-flight work and continues without re-scanning every source folder.
- **CI checkpoint resume.** A timed-out CI job that wrote partial render output reattaches to its leftover journal on the retry instead of starting from scratch.

The chokidar watcher attaches normally after a `--resume` start, so any source change between the kill and the restart flows through the sync hook as a fresh journal entry.

If you're not in watch mode and not interrupted, you don't need `--resume`. The default warning + discard behaviour is the safe path for one-shot builds.

## File Watching

Plugins register folder watchers using the `watch()` function:

```js
import { watch } from 'mikser-io'

// In a plugin's onLoaded handler
onLoaded(() => {
  watch('documents', runtime.options.documentsFolder)
})
```

### `watch(name, folder, options?)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Collection name — passed to sync handlers |
| `folder` | string | Absolute path to watch |
| `options` | object | chokidar options (optional) |

**Default options:**
```js
{
  interval: 1000,
  binaryInterval: 3000,
  ignored: /[\/\\]\./,   // Ignore dotfiles
  ignoreInitial: true    // Don't fire for files that exist at startup
}
```

Watch events (add, change, unlink) are routed to the sync hook with:
- `action`: `ACTION.CREATE`, `ACTION.UPDATE`, or `ACTION.DELETE`
- `name`: the collection name
- `context`: `{ relativePath }` — path relative to the watched folder

## The Sync Hook

The sync hook is the bridge between a file system event and a journal entry. Each plugin registers a sync handler for its collection:

```js
import { onSync, createEntity, updateEntity, deleteEntity, ACTION } from 'mikser-io'

onSync('documents', async ({ action, name, context }) => {
  const { relativePath } = context
  if (!relativePath.endsWith('.md')) return false  // ignore non-markdown

  const id = `/documents/${relativePath}`

  switch (action) {
    case ACTION.CREATE:
    case ACTION.UPDATE:
      const entity = await buildEntity(id, relativePath)
      if (action === ACTION.CREATE) {
        await createEntity(entity)
      } else {
        await updateEntity(entity)
      }
      break
    case ACTION.DELETE:
      await deleteEntity({ id, collection: 'documents', type: 'document' })
      break
  }

  return true  // trigger a process() cycle
})
```

### Return Values

| Return value | Effect |
|-------------|--------|
| `true` | Change was handled → schedule `process()` after debounce |
| `false` | Change was explicitly ignored |
| `undefined` | Hook didn't handle this event |

When any sync hook returns `true`, `process()` is scheduled to run after a 1-second debounce. Multiple rapid file changes are coalesced into a single rebuild.

## Cleanup on delete and rename

Chokidar reports a file rename as `unlink(old)` followed by `add(new)`. The `unlink` runs through `runtime.sync({ action: DELETE })`; each collection plugin's `onSync` handler emits a sparse DELETE entry to the journal (id, collection, type).

After the next render cycle Mikser reconciles state:

- The render manifest (`mikser_snapshots` table) is consulted. Every snapshot whose `id` or `parent` matches a deleted source is unlinked from disk and dropped from the table. Paginated children are caught via `parent`.
- `mikser_entities` rows for the deleted ids are removed. `mikser_refs` cascades on the FK. There's no separate sitemap to maintain — the catalog itself is the sitemap, queried via the `meta_href` index.

The net effect: renaming `documents/foo.md` to `documents/bar.md` in watch mode unlinks `out/foo.html` and any `out/foo.<n>.html` pages on its own. One-shot builds (no watch) don't generate DELETE events — use `--clear` to start from a clean output tree.

## Cancellation

If a file changes while a `process()` cycle is already running, Mikser cancels the current run and starts a new one:

1. `runtime.cancel()` is called — sends an AbortSignal to all in-progress hooks
2. `onCancelled` hooks run — clean up state from the interrupted run
3. A fresh `process()` cycle starts

Plugins that do long-running work should check `signal.aborted` and throw `AbortError` to exit cleanly:

```js
import { AbortError } from 'mikser-io'

onRender(async (signal) => {
  for await (const entry of useJournal('Rendering', ['RENDER'], signal)) {
    if (signal?.aborted) throw new AbortError()
    // ... render
  }
})
```

## Scheduled Tasks

In watch mode, plugins can schedule recurring tasks using cron expressions:

```js
import { schedule } from 'mikser-io'

// In a plugin's onLoaded handler
onLoaded(() => {
  schedule('api-refresh', '*/15 * * * *', { source: 'external-api' })
})
```

### `schedule(name, expression, context?)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Task name — passed to sync handlers as `name` |
| `expression` | string | Cron expression (5-part standard format) |
| `context` | object | Optional context passed to sync handler |

When a scheduled task fires:
- A sync event is sent with `action: ACTION.TRIGGER`
- The matching `onSync` handler decides whether to trigger a rebuild

**Cron schedule lifecycle:**
- Cron tasks start after the first `finalize` phase
- Tasks are paused during `process` to prevent overlap
- Tasks resume after each `finalize` phase

**Example — refresh API data every 30 minutes:**

```js
// In a plugin
onLoaded(() => {
  watch('posts', runtime.options.postsFolder)
  schedule('posts', '*/30 * * * *', { trigger: 'cron' })
})

onSync('posts', async ({ action, context }) => {
  if (action === ACTION.TRIGGER) {
    await refreshFromAPI()
    return true
  }
  // Handle file system changes
  const { relativePath } = context
  await createEntity(buildEntity(relativePath))
  return true
})
```

## Common Watch Mode Patterns

### Debounced batch changes

When many files change at once (e.g. `git pull`), all changes are debounced into a single `process()` cycle. The 1-second debounce window collects all change events before triggering.

### Preventing watch in production

```js
onLoaded(() => {
  if (runtime.options.mode !== 'development') return
  watch('documents', runtime.options.documentsFolder)
})
```

### Only run a hook once (not on every change)

```js
onProcess(async (signal) => {
  // This runs on every rebuild — OK for incremental work
}, false)

onProcess(async (signal) => {
  // This runs only on the first process() call
}, true)
```

### Injecting external changes programmatically

```js
import { createdHook, updatedHook, deletedHook, triggeredHook } from 'mikser-io'

// Simulate a file change from outside the watcher
await updatedHook('documents', { relativePath: 'blog/new-post.md' })
```
