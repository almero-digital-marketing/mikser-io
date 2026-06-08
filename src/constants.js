export const OPERATION = {
    CREATE: 'create',
    UPDATE: 'update',
    DELETE: 'delete',
    RENDER: 'render',
    POSTPROCESS: 'postprocess',
}

export const ACTION = {
    CREATE: 'create',
    UPDATE: 'update',
    DELETE: 'delete',
    TRIGGER: 'trigger',
}

// Render / postprocess dispatch modes. Set per-entity via
// `meta.task: 'inline' | 'serial' | 'worker'`, or per-task by a plugin.
//
//   INLINE  — runs the render/postprocess in the main event loop via
//             `await`. The outer dispatcher iterates with concurrency =
//             runtime.options.threads (default 4), so multiple inline
//             tasks can be in-flight at once; but they share the main
//             thread, so CPU-bound work doesn't actually run in
//             parallel. Right default for cheap renders (HTML / md /
//             yaml templating) where IPC overhead would dominate.
//
//   SERIAL  — runs in the main event loop too, but via p-queue with
//             concurrency 1. One at a time, no interleaving. Right
//             choice for tasks that touch a shared, non-reentrant
//             resource (a single browser instance, a sequential
//             encoder, etc.).
//
//   WORKER  — runs on a real OS thread via the Piscina pool sized to
//             runtime.options.threads. True parallelism. Right choice
//             for expensive CPU-bound renders (PDF via headless
//             Chromium, MJML compilation, image compose) where the
//             render cost amortizes the IPC overhead.
export const TASKS = {
    INLINE: 'inline',
    SERIAL: 'serial',
    WORKER: 'worker',
}