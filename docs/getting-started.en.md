# Get started with MeetingStone

MeetingStone lets you map a role to a CLI, model and responsibility in DeepSeek Harness. Installing the plugin does **not** install, authenticate or fund your external AI CLIs.

## 1. Install

The easiest path is to search for `dsh-meetingstone` in your DSH plugin marketplace, confirming that the source points to [Railly1983/dsh-meetingstone](https://github.com/Railly1983/dsh-meetingstone).

For a DSH Desktop setup using the `desktop` profile, the published npm package can be added with:

```powershell
dsh plugin --profile desktop add dsh-meetingstone
```

`desktop` is an example profile name—replace it with your own. Restart DSH if the settings entry is not yet visible. The published manifest declares DSH compatibility `>=0.2.2-rc.1 <0.3.0-0`. If your marketplace provides a different source coordinate, follow that listing.

## 2. Verify your CLI connections

Open **DSH Settings → MeetingStone**. Make sure your desired CLI is installed, its DSH provider is configured, and its account is signed in. Installation, authentication, available models and remaining quota are different things. MeetingStone does not claim a balance that the provider cannot verify.

See [installation and CLI connections](installation.md) for provider-specific details. Old examples may contain a developer's local Windows paths; replace them with your own.

## 3. Configure a role

The plugin ships with **three default roles** (Implementer / Reviewer / Researcher) that work immediately on native DSH subagents—no CLI setup needed. They appear only when you have no roles of your own and never overwrite an existing configuration. Edit them if you want a different CLI or model:

- Responsibility: implement and test changes within the approved scope; report modified files and evidence.
- CLI and model: choose ones already available on your machine.
- Reasoning effort: choose only a setting supported by that provider.

Optionally create a **Reviewer** role mapped to a different CLI/model for independent review.

## 4. Delegate

Try this in a DSH conversation:

> Ask Implementer to examine the README and startup scripts for inconsistencies. Report exact files and evidence; do not modify anything.

The DSH agent can use MeetingStone's dispatch tool to route this work. Query the run result afterward and delegate a separate review if needed.

**Permission note:** Text instructions are not an enforceable read-only sandbox. Configure actual restrictions through the underlying CLI/provider and operating system (see [security](security.md)).

## 5. Parallel work

Prefer a single worker for short tasks. Use parallel instances only for independent, nonoverlapping work that benefits from reduced wall-clock time; review and merge individual worktrees manually. Multi-subagent mode substantially increases token consumption because each subagent re-reads its context.

See [FAQ (中文)](faq.zh-CN.md) and [configuration](configuration.md) for limitations and troubleshooting.
