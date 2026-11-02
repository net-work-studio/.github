# Opt-in release batches

Collect feature PRs into `staging-2026-W45-1`, publish manually, then start
`staging-2026-W45-2` from updated production. Monday rollover starts the next
week's `-1` and carries every unpublished change. Multiple publications per
week and isolated `hotfix/*` PRs are supported.

## Adopt

1. Copy `workflow-templates/release-batches.yml` into the adopting repository's
   `.github/workflows/`. Replace `$default-branch` and **both**
   `RELEASE_KIT_COMMIT` placeholders with the default branch and a reviewed,
   immutable 40-character commit of this repository. Supply a project CI job
   named `Project checks`, or pass its actual check names during adoption.
2. Run `bash release-batches/setup-access.sh owner/repository`. The wizard
   requests GitHub CLI `workflow`/`admin:org` access, registers the private
   organization App, and installs it on only the chosen repository. Its key
   stays in memory until piped into the selected-repository organization
   secret `RELEASE_APP_PRIVATE_KEY`; it is never printed or saved locally.
   `RELEASE_APP_ID` is stored as a selected-repository organization variable.
   Later adopters reuse this App and explicitly expand its installation.
3. Merge the reviewed shared implementation and the adopting repository's
   pinned caller first. The adoption tool rejects unreviewed shared pins or a
   caller that is missing from the production branch.
4. Preview the exact protections and repository IDs:

   ```sh
   bun release-batches/adopt.ts --repository owner/repository --source-ref REVIEWED_COMMIT
   ```

   Add `--apply` to install them, bootstrap existing `staging` into the first
   batch, and activate production checks after bootstrap succeeds. Optional
   `--checks 'Project checks,Another check'` specifies repository CI checks.

Organization rules use explicit repository IDs, never all repositories.
Adoption preserves other selected repositories and refuses to replace their
App, change their protection policy, or silently reactivate disabled rules
for them. Project CI requirements are repository-specific. Existing unrelated
rules continue to apply. The App bypasses batch/state maintenance only;
production reviews and checks have no bypass in these rules.

The reusable workflow is triggered only by a repository that installs the
caller and sets `RELEASE_BATCHES_ENABLED=true`. Sharing this code does not
subscribe other repositories or change their settings. Pin updates require
deliberately updating each caller's reviewed SHA.

## Release

Merge feature PRs into the active staging batch. Automation creates its draft
release PR once unpublished changes exist. Mark it ready for review to freeze
the batch, wait for checks and another person's approval, then squash or rebase
merge into production. Return the release PR to draft to resume collecting edits.

After publication, a fresh numbered batch starts from current production.
Pending feature PRs move to it; their branches are synchronized without force
pushes where possible. Conflicts require human resolution and renewed checks.
For a fix that must exclude other pending changes, use a `hotfix/*` PR directly
into production. It follows the same review and CI requirements.

## Recovery

The orphan `release-batch-state` branch journals each handover before mutations.
One repository ruleset freezes retiring branches, preventing both new edits
and automatic deletion while PRs move. Re-running the workflow resumes an
interrupted transfer instead of creating duplicate batches. Retired branches
remain frozen as recovery evidence.

A carryover conflict restores the previous active batch and permits a feature
PR containing a human resolution. Run Release batches with `reconcile` after
resolving it. Other failures keep the affected batches frozen and fail their
policy checks; inspect the journal and run log, then rerun reconciliation.
Unexpected unpublished commits after a release snapshot are retained and
require explicit reconciliation instead of being discarded.

Scheduled runs use the caller's timezone. Delayed/missed weekly handovers are
recovered by the next maintenance event after local Monday 07:15. GitHub can
delay schedules; this is a release grouping cadence, not a precise publication
scheduler.

## Hosting

Hosting remains repository-specific. For Netlify, keep staging eligible as a
PR preview base and skip duplicate branch builds with:

```toml
[context.branch-deploy]
  ignore = "exit 0"
```

Do not disable all branch eligibility if feature PR previews target staging.
The workflow never publishes through a hosting API; a reviewed production
branch merge follows the repository's existing hosting integration.

## Development

Use Bun 1.3.14: `bun install --frozen-lockfile`, `bun run check`, `bun test`.
The maintenance workflow checks out only this reviewed shared source; it
never executes a pull request's code with the App's credentials. Project CI
runs separately without the App secret.
