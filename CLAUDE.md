# Claude Code coordination rules

These are organization coordination rules. They are a reference for repositories and manual Claude Code sessions; this file does not start or schedule Claude Code.

1. Work from a GitHub issue with a clear owner repository and acceptance criteria.
2. For work spanning repositories, open or link a coordinating issue in this repository and list every affected issue and dependency.
3. Use `status:ready` plus `claude:ready` only when the issue can be picked up without further clarification.
4. A person starts Claude Code manually on Win11Dev. Never invoke, schedule, or install an automated Claude Code runner.
5. A manual session marks the issue `claude:working`; it removes that label when it stops and records the outcome in the issue.
6. Claude Code must not change CI, merge or deploy code, or modify Azure, Odin, or Cloudflare infrastructure unless a separate explicitly authorized issue says otherwise.
7. Preserve repository-local instructions and workflows. They take precedence for that repository.
