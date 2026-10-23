# Historical technical references for coding agents

Root and component `AGENTS.md` guides are concise, **active**
instructions loaded according to the directory hierarchy. The files
here preserve the full former monolithic instructions as detailed
on-demand architecture references. They are not automatically discovered
by AGENTS.md agents. Some older inventories and relative paths may be
stale: trust current code, tests and local AGENTS.md first.

| Reference | Former file | Read selectively for |
| --- | --- | --- |
| [Project reference](project-reference.md) | `/AGENTS.md` | API inventory, environment and product concepts |
| [Backend reference](backend-reference.md) | `/app/AGENTS.md` | radio/ACK/repository/router/scheduler history |
| [Frontend reference](frontend-reference.md) | `/frontend/AGENTS.md` | TanStack behavior, UI flow and testing history |

Specialized live references remain in place and are intentionally
linked by the scoped guides:
- [Fanout architecture](../../app/fanout/AGENTS_fanout.md), from [app/fanout/AGENTS.md](../../app/fanout/AGENTS.md).
- [Visualizer architecture](../../frontend/src/components/visualizer/AGENTS_packet_visualizer.md), from [visualizer/AGENTS.md](../../frontend/src/components/visualizer/AGENTS.md).

## Maintenance

Update the nearest scoped `AGENTS.md` whenever a changed invariant
affects agent work. Update a relevant historical section if its factual
content changes. Do not copy large inventories into parent guides.
Only add new nested guides for substantial, distinct local behavior.
See [agents.md](https://agents.md/) for the portable format and precedence;
different clients differ in initial discovery of nested guidance.
