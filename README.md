# dsh-memories

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/@libraqg/dsh-memories)](https://www.npmjs.com/package/@libraqg/dsh-memories) [![test](https://github.com/Libraqg/dsh-memories/actions/workflows/test.yml/badge.svg)](https://github.com/Libraqg/dsh-memories/actions/workflows/test.yml)

Long-term memory for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (dsh).

**New sessions start knowing your preferences, your projects and what worked last time.**

dsh-memories reads your finished sessions in the background, keeps what is
worth remembering, and gives every new agent a short memory summary plus
tools to look up the details. It is a port of the memory pipeline in
[OpenAI Codex](https://github.com/openai/codex), with the same prompts, limits
and file layout.

## Install

Requires dsh 0.2.2 or later, Node.js 22.19 or later (the version dsh needs)
and `git` on your `PATH`.

```bash
dsh plugin --profile web add @libraqg/dsh-memories
```

From GitHub source instead of npm:

```bash
dsh plugin --profile web add github:Libraqg/dsh-memories
```

From a local checkout:

```bash
git clone https://github.com/Libraqg/dsh-memories
cd dsh-memories && npm install
dsh plugin --profile web add link:/absolute/path/to/dsh-memories
```

In the desktop app, add the plugin from its plugin manager instead; the
desktop profile is managed by the app. Restart dsh after installing.

## Use

Nothing to do: keep using dsh. Memory builds up on its own.

1. When a session has been idle for 6 hours, the next turn you start in any
   session extracts memories from it in the background. Up to 2 sessions are
   processed each time.
2. The extracted memories are merged into one memory folder by a background
   agent, at most once every 6 hours.
3. Each new agent gets the memory summary in its system prompt and can search
   and read the full memory with tools. When you correct it ("from now on,
   always …"), it saves the correction as a note for the next merge.

So the first memories appear about 6 hours after your first sessions, not
right away.

### Choose the models

Open the plugin's settings in the plugin manager. Pick an **extraction model**
(runs once per session, a fast model is enough) and a **consolidation model**
(runs the merge, a stronger model helps). Changes apply without a restart.

| Setting | Default |
|---|---|
| Extraction model | `deepseek-official` / `deepseek-flash` |
| Consolidation model | `deepseek-official` / `deepseek-v4-pro` |

Any provider configured in dsh works, including a signed-in subscription.

### The `/memories` command

| Command | What it does |
|---|---|
| `/memories` or `/memories status` | Models, number of stored memories, failed jobs and the last merge |
| `/memories path` | Where the memory folder is |
| `/memories model list` | Providers and models you can choose |
| `/memories model set <extract\|consolidation> <provider> <model> [effort]` | Change a model |
| `/memories model clear <extract\|consolidation>` | Go back to the default model |
| `/memories reset --confirm` | Delete every stored memory |

The memory folder is plain Markdown; you can read it and delete files in it.
`memory_summary.md` is what new agents see; `MEMORY.md` is the full handbook.

## Configuration

Other options go in the plugin's row of the profile's `cordis.patch.yml`.

| Option | Default | Meaning |
|---|---|---|
| `memoryRoot` | `$DSH_HOME/memories` (`~/.dsh/memories`) | Memory folder |
| `stateDbPath` | beside the memory folder | SQLite state database |
| `generateMemories` | `true` | Extract and merge new memories |
| `useMemories` | `true` | Give agents the summary and the memory tools |
| `externalKnowledge` | off | Keep a knowledge base out of memory, see below |
| `maxRolloutsPerStartup` | `2` | Sessions extracted per pass |
| `minRolloutIdleHours` | `6` | Idle time before a session is extracted |
| `maxRolloutAgeDays` | `10` | Older sessions are skipped |
| `maxRawMemoriesForConsolidation` | `256` | Memories considered by each merge |
| `maxUnusedDays` | `30` | Unused memories are dropped after this |

### Keeping a knowledge base out of memory

If your agents read a hand-maintained notes folder (an Obsidian vault, say),
its content would otherwise be copied into memory. Point the filter at it:

```yaml
- id: memories
  name: '@libraqg/dsh-memories'
  config:
    externalKnowledge:
      root: ~/Documents/Notes
      sessionExcludedPaths:
        - personal
```

Content read from `root` is replaced with a placeholder before extraction.
A session that reads anything under `sessionExcludedPaths` is left out of
memory entirely, and its earlier memories are dropped at the next merge.

## How it works

| Piece | What it does |
|---|---|
| Extraction | Filters and redacts a session, then asks the extraction model for a raw memory and a summary, or nothing if the session holds no lasting signal |
| Consolidation | A hidden agent, limited to five file tools inside the memory folder, merges the changes since the last merge into `MEMORY.md`, `memory_summary.md` and `skills/` |
| Read path | A system-prompt section with the summary (up to 2,500 tokens), plus the tools `memories_list`, `memories_read`, `memories_search`, `memories_add_ad_hoc_note` |
| Storage | The memory folder (Markdown, tracked by a private git baseline) and a SQLite job database |

See [docs/DESIGN.md](docs/DESIGN.md) for the design and every difference
from Codex.

## Permissions and risks

- **What is sent:** your session contents go to the extraction model's
  provider, and the extracted memories to the consolidation model's provider.
  Secrets that look like API keys and tokens are redacted first, as in Codex.
  Sessions of subagents and of the plugin itself are skipped.
- **Files:** writes only inside the memory folder and the state database. The
  consolidation agent's file tools refuse any path outside the memory folder;
  its other tools are disabled.
- **Commands:** runs `git` on the memory folder only, without your git
  config or hooks.
- **What it adds to dsh:** four agent tools, one system-prompt section, the
  `/memories` command, a settings page, and one hidden subagent session per
  merge.
- **Model usage:** each extraction is one model call per session; each merge
  is one agent run. Nothing runs while you are not using dsh.

## Known limitations

- Memory comes from sessions at least 6 hours old, so it lags behind.
- Usage counting, which decides what is kept, is approximate: it counts
  summaries the agent opens, not search hits.
- The knowledge-base filter matches paths. It cannot catch the agent
  paraphrasing a note in its reply, or a path built in a shell variable.
- Each merge leaves a hidden subagent session in dsh's session store.
- dsh is a release candidate. Tested on 0.2.2-rc.1, on macOS.

## Develop

```bash
npm install
npm test
```

`core/` must not depend on dsh; `npm test` runs `scripts/check-boundaries.js`
to enforce it.

## Licence

Apache-2.0. dsh-memories is a port of the memory pipeline of
[OpenAI Codex](https://github.com/openai/codex), Copyright 2025 OpenAI;
[NOTICE.md](NOTICE.md) records what changed.
