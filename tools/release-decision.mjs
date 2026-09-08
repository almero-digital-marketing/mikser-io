// Whether one package releases, and if not, why not.
//
// Its own module, and pure, for two reasons. publish.mjs ends in `await
// main()`, so importing it to test anything would run a release — and every
// fact this needs (what is published, what moved, whether the tree is dirty)
// costs a network call, a git diff or an `npm pack`. Passed in as values and
// thunks, the decision is testable without a registry, a repository or a
// package on disk, and the thunks keep the expensive answers unasked until
// they can change the outcome.

/**
 * @param {object} input
 * @param {string}  input.version      the version in package.json
 * @param {string}  input.latest       `latest` on the registry, or ''
 * @param {boolean} input.isPublished  this exact version is already published
 * @param {boolean} input.wanted       included by --only (true when absent)
 * @param {boolean} input.hasGit       the package directory is a git repo
 * @param {boolean} [input.all]        --all: release without asking what moved
 * @param {boolean} [input.direct]     --direct: publish here instead of tagging
 * @param {() => (boolean|null)} [input.changedSinceLatest] - did anything a
 *        consumer receives move since `latest`? null = could not tell.
 * @param {() => (boolean|null)} [input.changedSinceOwn] - the same question
 *        against `version` itself, for a package already published at it.
 * @param {() => boolean} [input.isDirty] - uncommitted changes present.
 * @returns {{ skip: string|null, undetermined: boolean }}
 */
export function releaseDecision({
    version,
    latest,
    isPublished,
    wanted,
    hasGit,
    all = false,
    direct = false,
    changedSinceLatest = () => null,
    changedSinceOwn = () => null,
    isDirty = () => false,
}) {
    const keep = (skip, undetermined = false) => ({ skip, undetermined })

    if (isPublished) {
        // Published at this number, but has the code moved since? That is a
        // package waiting for someone to decide what kind of release it is —
        // the judgement this tool deliberately does not make.
        return keep(changedSinceOwn() === true
            ? `changed since ${version} — needs a bump (npm version patch) before it can release`
            : `already published at ${version}`)
    }
    if (!wanted) return keep('not in --only')
    if (!hasGit && !direct) return keep('no git repository — cannot tag')

    // The change check only governs a PATCH. A major or minor bump is a
    // deliberate release decision — it is how the family aligned on 11 — and
    // second-guessing it by diffing would refuse the very release someone just
    // chose to make. Only same-major.minor successors have to prove they
    // changed something, which is the churn this prevents: 36 republishes
    // because one number moved.
    const line = (v) => String(v ?? '').split('.').slice(0, 2).join('.')
    const samePatchLine = Boolean(latest) && line(version) === line(latest)

    // Whether the gate APPLIES, kept separate from what it answers.
    //
    // Conflating the two is what broke --all. The flag set the answer to
    // "unknown" as a way of skipping the question, and a later branch read
    // "unknown" as "could not tell what moved" and left the package alone —
    // refusing the release the flag had just asked for, with the message
    // "Pass --all to release them anyway" printed beside it.
    if (all || !samePatchLine) return keep(null)

    const touched = changedSinceLatest()
    if (touched === false) {
        return keep(`unchanged since ${latest} — nothing a consumer receives moved`)
    }
    if (touched === null) {
        // Undetermined, which is NOT the same as unchanged: a dirty tree is
        // invisible to `git diff <tag>..HEAD`, so reporting "unchanged" here
        // would be the one wrong answer this must never give.
        return keep(isDirty()
            ? 'uncommitted changes — commit them, then this can tell what moved'
            : `cannot tell what changed since ${latest} — left alone`, true)
    }
    return keep(null)
}
