# MeetingStone · 集合石

**Give DeepSeek Harness a clear way to delegate work to the right AI CLI.**

Already using Codex, Claude Code, CodeBuddy, or DeepSeek Harness? Each has strengths, but coordinating them can mean repeatedly choosing models, remembering command-line entry points, and copying task context between tools.

**MeetingStone is a role-based, cross-CLI delegation plugin for DeepSeek Harness (DSH).** Configure roles once—what they do, which execution channel they use, and which model they should use—then delegate work by role from a DSH conversation. The CLIs and DSH retain responsibility for their native agent execution; MeetingStone handles the connection, dispatch, isolation, and result handoff.

> **Think of it this way:** DSH is your coordinator, your CLIs are the workers, and MeetingStone connects the two.

[简体中文](README.md) · [Quick start](docs/getting-started.en.md) · [Examples (中文)](docs/scenarios.zh-CN.md) · [FAQ (中文)](docs/faq.zh-CN.md)

**Current published package version: `0.1.1`.** Requires DSH `>=0.2.2-rc.1 <0.3.0-0`.

**Works out of the box**: three default roles (Implementer / Reviewer / Researcher) run on native DSH subagents, so you can delegate immediately without configuring any external CLI. They appear only when you have no roles of your own.

## What can you do with it?

| Goal | Example request in DSH | What MeetingStone adds |
| --- | --- | --- |
| Delegate everyday implementation | "Ask the implementer to build this endpoint and test it." | Route by role to a configured CLI/model |
| Request independent review | "Ask the reviewer to check this change for concurrency bugs." | Delegate a separate task to another role |
| Use existing CLI capabilities | "Have the Codex-backed role evaluate this design." | Invoke an installed and configured provider |
| Work on independent modules | "Have two workers handle separate modules." | Support task-level Git worktree isolation when concurrency is enabled |
| Find results | "Show the latest task outcome and artifacts." | Query task status, run records, and output artifacts |

These are usage examples, not promises of automatic multistep orchestration. Models, permissions, availability, and subscription usage depend on the underlying CLIs, accounts, and provider setup.

## MeetingStone vs. native DSH agents

**They complement each other.**

| Capability | Native DSH | MeetingStone |
| --- | --- | --- |
| Agent lifecycle, tools, permissions, task execution | **Owns** | Reuses |
| Agent Teams, team board, member messages | **Owns when enabled** | Optional integration, no hard dependency |
| One role mapped to a CLI, model and purpose | Manual setup across providers | **Core feature** |
| Discover local CLI readiness | Provider-specific | **Unified configuration and diagnostics** |
| Query results across delegated CLI work | Depends on native tools | **Run records and artifacts** |
| Independent Git worktrees for parallel writing | Workflow-dependent | **Task-level isolation option** |

MeetingStone is **not** a replacement for Codex, Claude Code, CodeBuddy, DSH Subagents, or Agent Teams. It deliberately avoids inventing another task board or agent runtime.

## Try it in three steps

1. **Install**: find `dsh-meetingstone` in your DSH plugin marketplace, or use the DSH CLI:
   ```powershell
   dsh plugin --profile desktop add dsh-meetingstone
   ```
   `desktop` is an example profile name—replace it with your own. See the [quick start](docs/getting-started.en.md) for details.
2. **Configure**: open **Settings → MeetingStone**, check CLI connections, and map your roles to available channels and models. External CLIs also require their corresponding DSH providers and valid sign-in.
3. **Delegate**: "Ask the implementer to inspect the authentication module, identify reproducible problems, and report evidence." Optionally delegate review to another role afterward.

The plugin ships with **three ready-to-use default roles** (Implementer / Reviewer / Researcher), all running on native DSH subagents. They work as soon as you install—no external CLI setup required. Edit them or add your own when you want a different CLI or model. Defaults appear **only when you have no roles of your own**; they never overwrite an existing configuration.

## Who is it for?

Developers using multiple AI CLIs; teams that reserve a stronger or more limited model for important reviews; and people who want role-based CLI dispatch without operating a custom multi-agent platform. If you only use one agent, native DSH capabilities may be enough.

## Boundaries that matter

- Parallel agents can consume **more**, not fewer, tokens. Prefer serial work for small tasks.
- Worktrees isolate default working directories, **not operating-system permissions**. Review and merge changes deliberately.
- A CLI that is installed is not necessarily authenticated or quota-available. Unknown quota is not reported as sufficient quota.
- Some external CLI task adjustments use **stop-and-restart with prior output**, not true in-session steering.
- Supported models depend on the actual provider, CLI and local configuration.

## Multi-agent cost warning

> **Multi-subagent mode substantially increases token consumption; enable it only for important, long-running tasks.**

Each subagent has to read the context again, so the more finely you split the work, the more the cost is amplified—and the wall-clock time saved usually does not make up for the extra tokens. Prefer serial dispatch by default.

## Documentation

- [Quick start](docs/getting-started.en.md)
- [Workflow examples in Chinese](docs/scenarios.zh-CN.md)
- [Frequently asked questions in Chinese](docs/faq.zh-CN.md)
- [Installation and CLI connections](docs/installation.md)
- [Configuration](docs/configuration.md)
- [Worktree isolation](docs/worktree-isolation.md) · [Security and permissions](docs/security.md)
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

MIT License. MeetingStone is an independent community project and is not affiliated with DeepSeek, OpenAI, Anthropic, or Tencent. The name is unrelated to the World of Warcraft addon of the same name.
