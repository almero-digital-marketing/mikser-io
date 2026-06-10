// Engine-level database substrate. One connection per mikser process,
// shared across subsystems (catalog, refs, manifest in later phases) and
// available to plugins via `useDatabase()`. Driver picked from
// `runtime.config.database.driver` — defaults to sqlite via
// better-sqlite3 (matches mikser-io-vector's choice; consistent install
// story across the codebase).
//
// Phase 1 lands the substrate only — `runtime.database` is set, plugins
// can `registerSchema(name, sql)` + `useDatabase()`, but no subsystem
// uses it yet. Catalog/refs/manifest migrations land in Phase 2-5.

import runtime from '../runtime.js'
import { useLogger } from '../engine.js'
import { onLoaded } from '../lifecycle.js'
import { createSqliteDriver } from './sqlite.js'
import packageInfo from '../../package.json' with { type: 'json' }

// Schemas registered by subsystems and plugins. Map<name, sqlScript>.
// Idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
// scripts applied at driver.open(). Naming convention:
//   - `catalog_*`   — engine-owned (catalog tables in Phase 2/4)
//   - `manifest_*`  — engine-owned (manifest tables in Phase 5)
//   - `<plugin>_*`  — plugin-owned (e.g. vector_<store>)
const schemas = new Map()

// Active driver. Set during the first onLoaded; persists across cycles
// (sqlite stays open for the lifetime of the process). Public API
// readers see null only before the first onLoaded fires.
let driver = null

// Register an idempotent schema script with the engine. Subsystems
// call this at module-import time (top-level side effect) or during
// onInitialize. The driver applies all registered scripts at open().
//
// `name` is the schema's identifier — used in debug logs and for
// duplicate detection. Same name twice = the later registration wins
// (with a warning). Convention: `<owner>` matching the table
// prefix (`catalog`, `manifest`, `vector`, etc.).
export function registerSchema(name, sqlScript) {
    if (typeof name !== 'string' || !name.length) {
        throw new Error('registerSchema: name must be a non-empty string')
    }
    if (typeof sqlScript !== 'string' || !sqlScript.length) {
        throw new Error('registerSchema: sqlScript must be a non-empty string')
    }
    if (schemas.has(name)) {
        // Late registration overrides — useful for tests that swap
        // schemas; loud so accidental collisions are visible.
        try {
            useLogger().warn('registerSchema: "%s" already registered, overwriting', name)
        } catch { /* logger may not exist yet at module-import time */ }
    }
    schemas.set(name, sqlScript)
}

// Return the active driver. Hot-path callers (catalog, refs, manifest
// in later phases) should cache the reference once at onLoaded rather
// than calling per-operation.
//
// Returns null before the first onLoaded fires (e.g., during plugin
// onInitialize). Plugins that need persistence should defer their DB
// work until onLoaded.
export function useDatabase() {
    return driver
}

function pickDriverFactory(name) {
    switch (name) {
        case 'sqlite':
        case undefined:
        case null:
            return createSqliteDriver
        case 'postgres':
            throw new Error(
                'postgres driver not yet implemented (planned for Phase 6 of the engine/database migration)',
            )
        default:
            throw new Error(
                `Unknown database driver: "${name}". Supported: "sqlite" (postgres planned).`,
            )
    }
}

onLoaded(async () => {
    if (driver?.isOpen) return  // multi-cycle watch mode — keep the open connection

    const logger = useLogger()
    const driverName = runtime.config?.database?.driver ?? 'sqlite'
    const driverConfig = runtime.config?.database?.[driverName] ?? {}

    const factory = pickDriverFactory(driverName)
    driver = factory({
        runtimeFolder: runtime.options.runtimeFolder,
        version: packageInfo.version,
        logger,
        config: driverConfig,
        schemas,
    })

    driver.open()

    // Expose on the runtime singleton so plugins can read it as a
    // property (mirrors runtime.catalog / runtime.refs pattern). Same
    // value as useDatabase() — both kept for ergonomics.
    runtime.database = driver

    logger.info(
        'Database ready: %s at %s (schemas: %s)',
        driver.kind,
        driver.path,
        schemas.size ? [...schemas.keys()].join(', ') : 'none',
    )
})
