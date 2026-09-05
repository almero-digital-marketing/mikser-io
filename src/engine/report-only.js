// The report-and-exit commands — --explain, --audit-output, --tools, --tool,
// --fingerprint. One implementation, because a forwarded request answers
// through exactly this function and must not disagree with a local run.

import packageInfo from '../../package.json' with { type: 'json' }
import render from '../render.js'
import runtime from '../runtime.js'
import { useDatabase } from '../database/index.js'
import { fingerprintOutputs } from '../fingerprint.js'
import { invokeTool, toolResultFailed, toolResultText, toolSchemas } from '../tools.js'
import { useLogger } from '../use-logger.js'
import { reportBrokenReferences, reportMissingAssets, formatBytes } from './checks.js'

export async function runReportOnly(request = {}) {
    const logger = useLogger()
    const {
        tools = runtime.options.tools,
        tool = runtime.options.tool,
        toolArgs = runtime.options.toolArgs,
        json = runtime.options.json,
        explain = runtime.options.explain,
        auditOutput = runtime.options.auditOutput,
        fingerprint = runtime.options.fingerprint,
    } = request

    if (tools) {
        const schemas = toolSchemas()
        if (json) {
            process.stdout.write(JSON.stringify(schemas, null, 2) + '\n')
        } else if (!schemas.length) {
            logger.warn('No tools registered. The mcp plugin registers the standard set; '
                + 'this flag only lists and invokes what is registered.')
        } else {
            for (const schema of schemas) {
                process.stdout.write(`${schema.name}\n    ${String(schema.description).split('\n')[0]}\n`)
            }
        }
        return 0
    }

    if (tool) {
        // An empty catalog answers every question with a confident nothing —
        // `null`, `total: 0`, "no render claims this destination" — all of
        // which read as "the thing you asked about does not exist" when the
        // truth is "nothing has been built here yet". Said once, before the
        // answer, so it cannot be missed.
        const entityCount = (() => {
            try {
                return useDatabase().handle
                    .prepare('SELECT count(*) AS n FROM mikser_entities').get()?.n ?? 0
            } catch { return null }
        })()
        if (entityCount === 0 && !runtime.manifest?.size?.()) {
            logger.warn('The catalog and manifest are empty — no build has run in this working '
                + 'folder. Tools answer from what the last build recorded, so this one will '
                + 'report nothing found. Run a build first.')
        }

        let args = {}
        if (toolArgs) {
            try {
                args = JSON.parse(toolArgs)
            } catch (err) {
                logger.error('--tool-args is not valid JSON: %s', err.message)
                return 3
            }
        }
        let result
        try {
            result = await invokeTool(tool, args)
        } catch (err) {
            logger.error('%s', err.message)
            return 3
        }
        process.stdout.write(toolResultText(result) + '\n')
        // A tool that reports failure must not exit 0 — an agent reading CLI
        // output has only the exit code to branch on.
        return toolResultFailed(result) ? 1 : 0
    }

    if (explain) {
        // Exit codes:
        //   0 — the entity was found and described
        //   3 — not in the catalog (distinct from --audit-output's 1/2, which are
        //       about output drift; "no such entity" is neither clean nor
        //       corrupt, it is a question that could not be answered)
        const { explain: explainEntity, formatExplain } = await import('../explain.js')
        const report = await explainEntity(explain)
        process.stdout.write((json ? JSON.stringify(report, null, 2) : formatExplain(report)) + '\n')
        return report.found ? 0 : 3
    }

    if (fingerprint) {
        const result = await fingerprintOutputs()
        if (!result) {
            logger.error('No output folder — nothing to fingerprint.')
            return 2
        }
        if (json) {
            process.stdout.write(JSON.stringify({ version: packageInfo.version, ...result }, null, 2) + '\n')
        } else {
            logger.notice('Output %s — %d file(s), %s',
                result.output.hash, result.output.files, formatBytes(result.output.bytes))
            for (const [name, group] of Object.entries(result.trees)) {
                logger.info('  %s: %s — %d file(s), %s',
                    name, group.hash, group.files, formatBytes(group.bytes))
            }
        }
        return 0
    }

    if (auditOutput) {
        if (!runtime.manifest) {
            logger.error('Verify: no manifest available — nothing to check against')
            return 2
        }
        const { verdict, missing, mismatched, unverifiable, orphaned, collisions } =
            await runtime.manifest.auditOutput()
        const total = runtime.manifest.size()

        // The document, under --json.
        //
        // This is the check a deploy script wants and it was the one that
        // could not be read programmatically: it reported through the log and
        // wrote nothing to stdout, so `--audit-output --json` returned zero
        // bytes and exit 0 or 2 — a caller had to parse prose, or trust the
        // exit code and lose every detail behind it.
        //
        // Emitted here and returned immediately, because the log lines below
        // are the human rendering of exactly this and printing both would put
        // the prose on stderr for no one.
        if (json) {
            process.stdout.write(JSON.stringify({
                verdict,
                snapshots: total,
                summary: {
                    missing: missing.length,
                    mismatched: mismatched.length,
                    unverifiable: unverifiable.length,
                    orphaned: orphaned.length,
                    collisions: collisions.length,
                },
                missing, mismatched, unverifiable, orphaned, collisions,
            }, null, 2) + '\n')
            return verdict === 'FAIL' ? 2 : 0
        }

        for (const e of missing)      logger.error('Missing:    %s (entity %s)', e.destination, e.id)
        for (const e of mismatched)   logger.error('Mismatched: %s (entity %s)%s', e.destination, e.id,
            e.writtenBy ? ` — the bytes on disk are ${e.writtenBy}'s` : '')
        for (const e of unverifiable) logger.warn('No hash:    %s (entity %s)', e.destination, e.id)
        for (const e of orphaned)     logger.warn('Orphan:     %s', e.path)
        // Named per destination: "two entities write here" is only actionable
        // if you know which two.
        for (const c of collisions)   logger.warn('Collision:  %s ← %s', c.destination, c.entities.join(', '))

        // Level picked from the verdict, because the level IS the marker in
        // pino-pretty's messageFormat: notice renders 🟢, warn 🟡, error 🔴. A
        // fixed `notice` prints a green tick next to the word FAIL, which
        // reads as success at a glance even though the exit code is right.
        const report = verdict === 'FAIL' ? logger.error : verdict === 'WARN' ? logger.warn : logger.notice
        report.call(logger,
            'Audit %s: %d snapshots, %d missing, %d mismatched, %d unverifiable, %d orphaned, %d collisions',
            verdict, total, missing.length, mismatched.length, unverifiable.length, orphaned.length, collisions.length)

        // Say what a pass means, because the name promises more than the check
        // can deliver.
        //
        // This compares each output file against the hash its OWN render
        // recorded. Every render rewrites that snapshot, so a render whose
        // output changed records the new bytes and then matches them: a
        // rendering regression verifies clean, by construction, and no amount
        // of care in the comparison changes that. It is a tampering check —
        // files edited, truncated or removed outside mikser — not a
        // regression check.
        //
        // Said on a PASS only. On a failure the listed differences are the
        // message, and this would bury them.
        if (verdict === 'OK') {
            logger.info(
                'Audit compares each output against the hash its own render recorded, so it catches files '
                + 'changed or removed outside mikser — not a render that changed. A render that changed is '
                + 'reported as it happens, under `output-drift`.')
        }
        return verdict === 'FAIL' ? 2 : verdict === 'WARN' ? 1 : 0
    }

    return null   // not a report-only request
}
