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
