// Which packages the release tool ships, and why it leaves the rest.
//
// Testable at all because the decision is a pure function in its own module:
// publish.mjs ends in `await main()`, so importing it to check anything would
// run a release.
//
// The rule it enforces: a same-minor successor has to prove that something a
// consumer receives actually moved. Without it, one version bump across the
// family republished 36 packages that were byte-identical. With it, the tool
// has to be careful about the difference between "nothing moved" and "I could
// not tell" — reporting the second as the first is the one wrong answer here,
// because a dirty tree is invisible to `git diff <tag>..HEAD`.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { releaseDecision } from '../../tools/release-decision.mjs'

// Defaults describe the ordinary case: a fresh patch, in scope, committed, in
// a git repo, with something genuinely changed. Each test overrides the one
// fact it is about.
const decide = (overrides = {}) => releaseDecision({
    version: '11.3.2',
    latest: '11.3.1',
    isPublished: false,
    wanted: true,
    hasGit: true,
    changedSinceLatest: () => true,
    ...overrides,
})

describe('releaseDecision', () => {
    it('releases a patch that changed something a consumer receives', () => {
        assert.deepEqual(decide(), { skip: null, undetermined: false })
    })

    it('holds back a patch where nothing shipped moved', () => {
        const { skip } = decide({ changedSinceLatest: () => false })
        assert.match(skip, /unchanged since 11\.3\.1/)
    })

    it('does not ask what moved for a minor or major bump', () => {
        // A deliberate release decision. Diffing it would refuse the release
        // someone just chose to make — so the thunk must not even be called.
        for (const version of ['11.4.0', '12.0.0']) {
            let asked = false
            const { skip } = decide({ version, changedSinceLatest: () => { asked = true; return false } })
            assert.equal(skip, null, version)
            assert.equal(asked, false, `${version}: the gate does not apply, so it must not be asked`)
        }
    })

    it('--all releases a same-minor patch without asking what moved', () => {
        // The bug this test exists for. `--all` set the change answer to
        // "unknown" as a way of skipping the question, and the branch handling
        // "unknown" then left the package alone — printing "cannot tell what
        // changed ... left alone" beside the advice "Pass --all to release
        // them anyway". Both mikser-io 11.3.2 and mikser-io-assets 11.1.1 were
        // refused this way, and releasing them meant knowing not to pass the
        // flag whose whole purpose was this.
        let asked = false
        const { skip, undetermined } = decide({
            all: true,
            changedSinceLatest: () => { asked = true; return null },
        })
        assert.equal(skip, null, '--all must release it')
        assert.equal(undetermined, false, 'and not report it as undetermined')
        assert.equal(asked, false, '--all means stop asking, so the diff is never run')
    })

    it('leaves a package alone when it cannot tell what moved, and says so', () => {
        const { skip, undetermined } = decide({ changedSinceLatest: () => null })
        assert.match(skip, /cannot tell what changed since 11\.3\.1/)
        assert.equal(undetermined, true, 'the summary offers --all only for these')
    })

    it('names uncommitted changes as the reason it cannot tell', () => {
        // A dirty tree is invisible to `git diff <tag>..HEAD`, so this case
        // must never be reported as "unchanged". Distinguishing it also tells
        // the reader what to do about it.
        const { skip, undetermined } = decide({
            changedSinceLatest: () => null,
            isDirty: () => true,
        })
        assert.match(skip, /uncommitted changes/)
        assert.equal(undetermined, true)
    })

    it('reports a published version that has moved as needing a bump', () => {
        const { skip } = decide({
            isPublished: true,
            changedSinceOwn: () => true,
        })
        assert.match(skip, /changed since 11\.3\.2 — needs a bump/)
    })

    it('reports a published version that has not moved as already published', () => {
        const { skip } = decide({ isPublished: true, changedSinceOwn: () => false })
        assert.match(skip, /already published at 11\.3\.2/)
    })

    it('excludes a package outside --only before asking anything about it', () => {
        let asked = false
        const { skip, undetermined } = decide({
            wanted: false,
            changedSinceLatest: () => { asked = true; return null },
        })
        assert.equal(skip, 'not in --only')
        assert.equal(asked, false)
        assert.equal(undetermined, false,
            'a package nobody asked for is not an unanswered question')
    })

    it('refuses to tag a package with no git repository, unless publishing direct', () => {
        assert.match(decide({ hasGit: false }).skip, /no git repository/)
        assert.equal(decide({ hasGit: false, direct: true }).skip, null)
    })

    it('treats a first publish as a release, with no latest to compare against', () => {
        let asked = false
        const { skip } = decide({
            latest: '',
            changedSinceLatest: () => { asked = true; return null },
        })
        assert.equal(skip, null, 'nothing to be unchanged from')
        assert.equal(asked, false)
    })
})

// ── the concurrency helper the pre-flight runs on ───────────────────────────
//
// The release tool spent ten seconds before doing anything, and all of it was
// `npm pack --dry-run` — a 240ms subprocess the decision above needs per
// package, thirty-eight of them in a row. Prefetching them concurrently took
// that to two and a half seconds with byte-identical output.
//
// It had to be a PREFETCH. Wrapping the decision loop in a concurrent map
// changed the total by nothing, because `shippedFiles` is execFileSync and a
// synchronous subprocess blocks the event loop — async workers around it run
// strictly one after another. These pin the ordering guarantee the pre-flight
// depends on, since the result is zipped back against the topological order
// and everything downstream reads that order.

import { mapConcurrent } from '../../tools/concurrent.mjs'

describe('mapConcurrent', () => {
    it('returns results in INPUT order, not completion order', async () => {
        // The pre-flight builds `new Map(results)` keyed by package name and
        // the release loop walks the topological order. Results arriving in
        // completion order would silently reorder the release sequence, which
        // is the one thing the topological sort exists to get right.
        const out = await mapConcurrent([50, 10, 30, 0], 4, async (ms, i) => {
            await new Promise(r => setTimeout(r, ms))
            return i
        })
        assert.deepEqual(out, [0, 1, 2, 3])
    })

    it('never runs more than `limit` at once', async () => {
        let running = 0
        let peak = 0
        await mapConcurrent(Array.from({ length: 20 }, (_, i) => i), 5, async () => {
            running++
            peak = Math.max(peak, running)
            await new Promise(r => setTimeout(r, 5))
            running--
        })
        assert.ok(peak <= 5, `ran ${peak} at once, limit was 5`)
        assert.ok(peak > 1, 'it did actually run concurrently')
    })

    it('does the work exactly once per item', async () => {
        const seen = []
        await mapConcurrent(['a', 'b', 'c'], 2, async (item) => { seen.push(item) })
        assert.deepEqual(seen.sort(), ['a', 'b', 'c'])
    })

    it('handles an empty list and a limit above the item count', async () => {
        assert.deepEqual(await mapConcurrent([], 8, async () => 1), [])
        assert.deepEqual(await mapConcurrent([1, 2], 99, async (n) => n * 2), [2, 4])
    })
})
