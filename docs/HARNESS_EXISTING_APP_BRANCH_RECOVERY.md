# Existing-app branch continuity

Read-only production inspection on November 3 showed canonical requirement cron
execution with real tool receipts, but the attached tree contained the base
documentation scaffold instead of the existing application landing. The older
requirement status linked to the actual app branch with its slash percent-encoded.
The profile resolver did not decode this branch and only examined the first tree
link; a recent source-checkpoint commit URL could also mask valid older branches.

`/Users/prado/Desktop/Proyectos/Uncodie/Code/API/src/lib/harness/requirement-profile.ts`
now decodes historical branches, checks the same repository and requirement, skips
commit/checkpoint links and malformed or foreign links, and uses the latest matching
work branch within the existing bounded history query. It never resets a workspace,
switches an adopted dirty tree or mutates an existing session.

Regressions cover encoded refs, checkpoint-first history, tenant/runner query scope,
foreign repository/requirement rejection and an actual local Git checkout where the
existing landing differs from main. These are offline regressions, not live delivery
E2E. A successful exec or source checkpoint still cannot establish acceptance.

This code change requires deployment. An already-created session on the scaffold
does not automatically migrate to the recovered branch. Review its saved workspace,
pending operations and changes before any repair; do not delete it, reset the tree,
rewrite authorization receipts or restart execution merely to force a green test.

A live acceptance check for an existing app must independently establish the
baseline branch/tree, preservation of prior app files, a requested change on that
tree, and working UI/behavior after the change. Offline CI and liveness probes
do not substitute for that check. No deployment or remote mutation was performed
by this investigation.