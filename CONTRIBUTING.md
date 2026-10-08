# Organization coordination defaults

These defaults apply when a repository does not define its own contribution guidance or issue templates. Repository-local instructions always take precedence.

1. Open an issue in the repository that owns the work.
2. Apply one `type:*` label, one `priority:P*` label where known, and one `status:*` label.
3. For work that spans repositories, create or link a coordinating issue in [`wgrin-org/.github`](https://github.com/wgrin-org/.github/issues/1), then list each owner-repository issue and dependency there.
4. Claude Code on Win11Dev is started manually only. The labels `claude:ready` and `claude:working` communicate human-managed handoff state; they trigger no automation.
5. Do not change CI, merge or deploy code, or modify Azure, Odin, or Cloudflare infrastructure unless a separate issue explicitly authorizes it.

See the [coordination guide](README.md), [common labels](LABELS.md), and [Claude Code rules](CLAUDE.md).
