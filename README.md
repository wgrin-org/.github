# wgrin-org coordination

This repository provides the organization-wide defaults for issue intake and coordination.

## Working across repositories

- Create work in the repository that owns the change.
- Use the **Cross-repository coordination** issue template when a deliverable or dependency spans repositories.
- Put every related issue URL in the `Related work` section and use GitHub task lists for dependencies.
- Keep the coordinating issue open until all linked repository issues are complete.
- Use the common labels defined in [LABELS.md](LABELS.md) without removing any project-specific labels.

## Claude Code handoff

Claude Code on Win11Dev is started manually by a person; this repository never starts it automatically. Before starting a session, select a scoped issue, ensure it has `status:ready`, add `claude:ready`, and record the issue URL in the handoff. During a manual session use `claude:working`; on completion remove that label and update the issue status and links to the resulting pull request or follow-up issue.

No centralized automation is implied by these conventions. Repository CI, deployments, and infrastructure remain owned by their existing repositories and operators.
