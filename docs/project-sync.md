# Issues → Project sync (WGRIN Development)

Adds new Issues from every active `wgrin-org` repository to the organization project
[WGRIN Development](https://github.com/orgs/wgrin-org/projects/1). Files:
- `.github/workflows/project-sync.yml`: the scheduled workflow.
- `scripts/project-sync/sync.mjs`: the sync. It has no dependencies.
- `scripts/project-sync/config.json`: mapping and limits.
- `scripts/project-sync/sync.test.mjs`: tests.

**It never starts Claude Code.** `claude:ready` and `claude:working` are only read to choose a Status; Claude Code on
Win11Dev is started manually by the owner ([CLAUDE.md](../CLAUDE.md)).

## 0. Two-layer architecture (since 2026-10-09)

Issues reach the project through two mechanisms that share one GitHub App (`wgrin-project-sync`):

| Layer | Role | Where | Credentials |
|---|---|---|---|
| **1. Real-time webhook receiver** | **Primary.** Adds new Issues and keeps Status/Priority in step with label changes, close and reopen, within seconds (measured 2–4 s; about 7 s for the first event after a restart). | The WGRIN Verify backend in `wgrin-org/wgrin.org`. The App's webhook (**Issues** events only, signed with a webhook secret) is delivered to the backend's API. | Its **own private key** of the App, held in the backend's key store. Never in this repository. |
| **2. Scheduled reconciliation** (this repository) | **Fill-only fallback.** Adds open Issues that are missing from the project and fills empty Areas. It never changes Status or Priority, so it cannot fight layer 1. | `.github/workflows/project-sync.yml` | A **different private key** of the same App, stored as the Actions secret `PROJECT_SYNC_PRIVATE_KEY`. |

- The canonical operations documentation for layer 1 is **[wgrin.org `docs/operations/github-project-sync.md`](https://github.com/wgrin-org/wgrin.org/blob/main/docs/operations/github-project-sync.md)**
  (private repository). It covers the field rules, field ownership, observability, latency, configuration and rollback.
- Both layers use the same label → field mapping (`scripts/project-sync/config.json` here, pinned by a test in wgrin.org).
- **Keys:** the App has (at least) two private keys, one per layer. In the App settings → **Credentials → Private keys**,
  GitHub shows each key's SHA-256 fingerprint and creation date. The receiver's key was generated on 2026-10-09; its
  fingerprint is recorded in the canonical document. Before deleting any key, compare the fingerprint, because
  **deleting the wrong key stops the other layer**.
- **Suspending or uninstalling the App disables both layers at once.** For a single layer, use that layer's own rollback (§9).
- **Built-in project workflows:** while layer 1 is active, **"Item added to project" and "Pull request linked to issue"
  must stay Off**. The first set Backlog asynchronously and could overwrite a label-derived Status. The second set an
  Issue to In Progress when a pull request was linked, overriding its labels. "Item closed", "Auto-close issue",
  "Pull request merged" and "Auto-add sub-issues to project" stay On; they do not conflict.

## 1. Architecture decision

| Option | Assessment |
|---|---|
| **Scheduled reconciliation in `.github` + GitHub App token + GraphQL** (chosen on 2026-10-08; layer 2 since 2026-10-09) | One workflow in one repository, and new repositories are picked up automatically. It is idempotent (it compares with the project's current items), self-healing after missed events, and the code is small and tested. The cron asks for every 15 minutes, but GitHub's scheduling is best effort (see §6). |
| Event-driven (`on: issues`) in each repository, e.g. with `actions/add-to-project` | Near-instant, but needs a workflow file and a secret (or App token) in **all 9 repositories** plus every future one. Private-repository runs use the Free plan's 2,000 minutes, and it does not repair missed events. `actions/add-to-project` only adds items; Area, Status and Priority would still need custom code. |
| GitHub App webhook → own service | Excluded on 2026-10-08 (no server). **Adopted on 2026-10-09 as layer 1** after the owner required near-real-time updates: it reuses the existing WGRIN Verify backend, database and key store, so no new service or cost was added. |
| Projects built-in auto-add workflow | The Free plan allows **1** auto-add workflow (one repository filter). It does not cover 9 repositories and cannot set Area or Priority. |

**GitHub Free:** `wgrin-org/.github` is **public**. Standard GitHub-hosted runners are free for public repositories and
do not use the organization's 2,000 private-repository minutes.

**Estimated Actions usage:**
- A run takes about 20–40 s and is billed as 1 minute, rounded up per job.
- 96 runs/day × 30 days = **about 2,900 runner-minutes per month, all free (public repository)**.
- Runs skipped while the sync is disabled cost nothing.
- *If this repository ever becomes private*, the schedule would exceed the 2,000 free minutes. Change the cron to hourly (`7 * * * *`, about 720 minutes/month) first.

**API usage per run:**
- Roughly 12 GraphQL queries: the project, its items, repositories, and issues per repository (paginated by 100).
- Mutations only for new items: up to 4 per new Issue, capped at 300 per run (`limits.maxMutationsPerRun`; the rest are handled by the next run).
- A run stops before writing if fewer than 200 rate-limit points remain.

## 2. Behaviour

1. **Discovery.** All repositories of the organization are listed. Archived and disabled repositories, those without Issues, and `excludeRepositories` are skipped.
2. **Scope.** Open Issues are read (not pull requests). An Issue is added only if it is not yet in the project and was created on or after `addIssuesCreatedOnOrAfter` (set it to the activation date). History is never imported.
3. **No duplicates.** Existing items are loaded first, archived ones included, and `addProjectV2ItemById` is idempotent.
4. **Fields on a newly added item:**
   - **Area:** from `areaByRepository`, or an Area option with the repository's name. Otherwise it is left empty and counted as `areaUnmapped`.
   - **Status:** from the organization labels, first match wins:
     - `status:in-progress` or `claude:working` → In Progress;
     - `status:blocked` → Blocked;
     - `status:review` → In Review;
     - `status:ready` **and** `claude:ready` → Ready for Claude;
     - `status:triage` → Needs Analysis;
     - otherwise **Backlog**.
   - **Priority:** from `priority:P0`–`priority:P3`; the highest wins. Without a priority label it is left empty.
5. **Existing items:** Status and Priority are **never changed**, and labels are not re-applied. Only an **empty** Area is filled.
6. **Read-only on repositories.** Only the project is written. Issues, labels, pull requests and code are never modified.
7. **Logging.** Only counts are logged. This repository is public, so logs never contain repository names, titles, URLs or GraphQL error text.

**Cross-repository work:**
- Issues stay in their owning repositories, and their links and task lists are untouched.
- Coordination issues live in `wgrin-org/.github` (Area: Coordination).
- An Issue that affects several repositories is not duplicated; reference it from a coordination issue.

## 3. GitHub App (owner action)

Create a dedicated App: **Organization settings → Developer settings → GitHub Apps → New GitHub App**.

1. **Name:** `wgrin-project-sync` (or similar). **Homepage URL:** `https://github.com/wgrin-org/.github`.
2. **Webhook:** as originally created for this workflow, **Active was unticked**. Since 2026-10-09 the webhook is
   **Active** for layer 1 (Issues events only; configured as described in the canonical document). This workflow does
   not use the webhook.
3. **Permissions** (everything else: No access):
   - Repository permissions → **Issues: Read-only**
   - Repository permissions → **Metadata: Read-only** (mandatory)
   - Organization permissions → **Projects: Read and write**
4. **Where can this GitHub App be installed?** → **Only on this account**.
5. Create the App, then note its **Client ID** (shown on the App's page).
6. **Credentials → Private keys → Generate a private key.** A `.pem` file downloads. Store it only as the secret below, then delete the local file. This key belongs to this workflow only; layer 1 has its own key (§0).
7. **Install App** → `wgrin-org` → **All repositories**, so new repositories are discovered automatically. *Only select repositories* also works, but then each new repository must be added to the installation.

**Security notes:**
- With these permissions the App can read Issues (including private repositories) and edit organization projects. It **cannot** write Issues, labels, pull requests, code or settings.
- The workflow narrows its token to `issues: read`, `metadata: read` and `organization-projects: write` even if the App is later granted more.
- The token is short-lived (about 1 hour) and revoked when the job ends.

## 4. Configuration and secrets (owner action, `wgrin-org/.github` → Settings → Secrets and variables → Actions)

| Kind | Name | Value |
|---|---|---|
| Variable | `PROJECT_SYNC_CLIENT_ID` | The App's Client ID |
| Secret | `PROJECT_SYNC_PRIVATE_KEY` | The full contents of the `.pem` file |
| Variable | `PROJECT_SYNC_ENABLED` | `true` **only when activating**; without it, scheduled runs are skipped |

Set `addIssuesCreatedOnOrAfter` in `config.json` to the activation date, and add an `areaByRepository` entry when a new
repository should get a different Area than its own name.

**Why this is safe in a public repository:**
- Secrets are not exposed to workflows from forks, and this workflow has no `pull_request` trigger.
- Only people with write access to this repository can run it manually.
- Actions are pinned to commit SHAs, the default `GITHUB_TOKEN` has no permissions, and the checkout is limited to the script with no persisted credentials.

## 5. Activation (after owner approval)

1. Create and install the App, then set the variable and the secret (sections 3–4).
2. **Required while layer 1 is active:** the project's built-in workflows **"Item added to project"** and **"Pull request linked to issue"** are Off (Project → ⋯ → Workflows; §0).
3. **Actions → Project sync → Run workflow** with *dry run* ticked. The log should show a summary with `repositoryErrors: 0`. Today's expected result is `alreadyInProject: 30`, `added: 0`.
4. Set `PROJECT_SYNC_ENABLED=true`. Scheduled runs start; GitHub may delay them by several minutes.

## 6. Runbook

**Monitoring**
- Actions → Project sync. A failed run is red and GitHub emails the workflow's last editor.
- The log has one summary line: `added`, `alreadyInProject`, `areaUnmapped`, `repositoryErrors`, `stoppedEarly`.

**Failures**

| Symptom | Meaning / action |
|---|---|
| `failed (permission)` | The App is not installed, lacks a permission, or the key or Client ID is wrong. Check section 3; nothing was written (the check happens before any write). |
| `failed (transient)` | Network, 5xx or rate limit after retries. The next run reconciles, and no action is needed unless it repeats. |
| `repositoryErrors > 0` | One repository failed (the others were synced). Re-run; if it persists, check that the App's installation includes that repository. |
| `areaUnmapped > 0` | A new repository has no Area option. Add one in the project (named like the repository) or map it in `config.json`; fill the empty Areas by hand or let the next run fill them. |
| `stoppedEarly` | The mutation budget or rate limit was reached. The next run continues. |
| No runs at all | Check `PROJECT_SYNC_ENABLED`. In a public repository, GitHub **disables scheduled workflows after 60 days without repository activity**: re-enable the workflow under Actions. |
| Runs hours apart | Expected: GitHub Actions `schedule` is **best effort**. Although the cron asks for every 15 minutes, observed runs on 2026-10-08/09 started about 6 h after activation and then roughly every 3–5 h. Do not rely on this layer for timeliness; layer 1 is the timely path. To fill a gap now, run the workflow manually (dry run first, then with *dry run* unticked). |

**Recovery and changes**
- **Stop immediately:** delete `PROJECT_SYNC_ENABLED` or set it to `false` (or disable the workflow in Actions). Layer 1 is not affected.
- **Key compromise:** in the App settings → Credentials, revoke **this workflow's** key (compare fingerprints; §0) and generate a new one, then update the secret. Layer 1's key is not affected.
- **Removing an item:** **archive** it rather than deleting it; a deleted open Issue created after the cutoff is added again by the next run.
- **Remove everything:** disable the workflow, uninstall the App, and delete the variable and secret. Project data is kept.

## 7. Tests

```bash
node --test scripts/project-sync/sync.test.mjs
```

The tests use an in-memory fake of the GraphQL API, with no network or real data. They cover:
- new Issues in `wgrin.org`, `bohoty.cz` and another repository (including one without an Area option);
- archived repositories;
- existing items (no re-add; manual Status and Priority kept; empty Area filled);
- explicit priority labels and no labels;
- repeated runs (idempotent, no writes on the second run);
- the history cutoff, dry run, and a failing repository;
- missing permissions (fails before any write) and a low rate limit;
- the mutation budget;
- retries (network, 502, Retry-After, RATE_LIMITED);
- error messages that never echo GraphQL text.

A read-only dry run against the real organization is also possible with a token that can read the project
(`GH_TOKEN=… DRY_RUN=true node scripts/project-sync/sync.mjs`); it performs queries only.

## 8. Activation record

**Activated 2026-10-08 12:37 UTC** with owner approval:
- **GitHub App:** `wgrin-project-sync`, installed on all repositories with Issues read, Metadata read and Organization Projects read/write; no webhook at that time (layer 1 activated it on 2026-10-09).
- **Repository variables and secret:** `PROJECT_SYNC_CLIENT_ID` and `PROJECT_SYNC_ENABLED=true` (variables), `PROJECT_SYNC_PRIVATE_KEY` (secret).
- **Project:** the built-in workflow "Item added to project" is **off**.
- **Dry run** (run 37777600266) and **controlled live run** (run 37778269562):
  - 9 repositories, 30 open Issues, all already in the project;
  - 0 mutations and 0 errors;
  - all 30 items kept Status, Priority, Area and archive state (compared with a snapshot taken before activation);
  - the logs contain counts only.

**2026-10-09: layer 1 (real-time receiver) activated** in wgrin.org after staged dry-run and live tests; this workflow
became the fill-only fallback (details in the canonical document).
- Built-in workflows "Item added to project" and "Pull request linked to issue" are **Off**.
- The App webhook is **Active**, Issues events only; the App permissions did not change.
- Two Issues created shortly before the webhook existed were added by a **manual run** of this workflow (dry run
  37898988818, then live run 37899152995: `added: 2`, `alreadyInProject: 30`, 8 mutations, no errors).

## 9. Rollback

The two layers have separate, independent rollbacks. Project data is kept in every case.

**Layer 2: this scheduled reconciliation only** (layer 1 keeps working):
1. **Stop:** in `wgrin-org/.github` → **Settings → Secrets and variables → Actions → Variables**, delete
   `PROJECT_SYNC_ENABLED` or set it to `false` (scheduled runs are then skipped), *or* **Actions → Project sync → ⋯ →
   Disable workflow**.
2. **Revoke its access:** App settings → **Credentials → Private keys**, delete **this workflow's** key (check the
   fingerprint first; §0), and delete the secret `PROJECT_SYNC_PRIVATE_KEY`. The workflow then fails with
   `failed (permission)` and writes nothing.
3. **Remove:** revert the workflow file and delete `PROJECT_SYNC_CLIENT_ID`, `PROJECT_SYNC_ENABLED` and
   `PROJECT_SYNC_PRIVATE_KEY`. Do **not** delete or uninstall the App while layer 1 uses it.

**Layer 1: the real-time receiver only** (layer 2 keeps working). The owner of the wgrin.org backend follows the
canonical document's rollback. In short, from least to most invasive:
1. Stop project writes but keep receiving: the receiver's dry-run setting.
2. Stop receiving: disable the receiver. Deliveries fail and can be redelivered within 3 days.
3. Stop GitHub sending: App settings → **General → Webhook → untick Active**. Layer 2 does not use the webhook.
4. Revoke its access: delete **the receiver's** private key (check the fingerprint; §0) and its stored copy.

While layer 1 is stopped, Issues reach the project only through layer 2: hours late, and Status/Priority changes are
not applied. To restore the earlier built-in behaviour (Status Backlog on add, In Progress on a linked pull request),
switch "Item added to project" and/or "Pull request linked to issue" back **On** only **after layer 1 is fully off**.

**Both layers at once:** in Organization settings → GitHub Apps → `wgrin-project-sync`, **Suspend** (reversible) or
**Uninstall**. This **disables both layers immediately**: neither can obtain a token, and webhook deliveries stop.
Deleting the App removes it permanently, including both keys and the webhook configuration.

**Undo items added by a sync** (rarely needed):
- Both layers only add items for open Issues created on or after `addIssuesCreatedOnOrAfter` (2026-10-08). Archive
  them in the project (filter by `created:>=` that date) rather than deleting them; a deleted open Issue is added again.
- Issues, labels and repositories are never changed by either layer, so nothing needs restoring there.
