# Polylog

**One git log across every repository in your workspace.**

Search commits by message across all of your repos at once, and see the changed files
without switching repositories.

---

## Status

**Design complete, implementation not started.** The full design is in
[`docs/superpowers/specs/2026-09-23-polylog-design.md`](docs/superpowers/specs/2026-09-23-polylog-design.md).

## The problem

Multi-root and sibling-repo workspaces are ordinary — polyrepo services, a vendored library
beside its consumer, a docs repo next to the product. Every VS Code git extension handles
them the same way: a repository **picker**. You read one repo's history at a time.

So the question "which repos did this ticket touch?" means opening each repository in turn.

JetBrains IDEs merge all VCS roots into one filterable log. Polylog brings that single
capability to VS Code.

## How it works

`git log` runs once per repository with your filters passed straight through as flags, and
the results are merged by date. There is no index and no cache — measured across a
68-repository, 16,000-commit workspace, the full fan-out takes **25 ms**, so there is
nothing for a database to improve on.

## License

MIT
