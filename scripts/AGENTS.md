# Build, quality, release and setup scripts

Inherits [root AGENTS.md](../AGENTS.md).

- `quality/all_quality.sh` is the full repo gate: runs
  generators and autofixers before typecheck, tests and build.
  Inspect generated/format changes after executing it.
- Use narrower targeted commands for docs-only or minor edits
  unless the user explicitly asks for the full gate.
- `quality/e2e.sh` and `quality/extended_quality.sh`
  may require Docker or browser tooling; inspect prerequisites.
- `build/` handles publishing/release artifacts, images and
  tags; release side effects require explicit authorization.
- `setup/` can install/update a Linux service or fetch a
  prebuilt frontend fallback; preserve operator configuration.
- Validate shell syntax and exit codes, retain strict error
  handling where applicable; never claim checks passed without
  executing them.
- See [project reference](../docs/agent-guides/project-reference.md)
  for older setup/deployment information if necessary.
