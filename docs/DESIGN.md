# Design

dsh-memories ports the memory pipeline of [OpenAI Codex](https://github.com/openai/codex)
(commit `748ab55`, memory version V1) to DeepSeek Harness. The rule followed
throughout: do what Codex does, and deviate only where DSH makes it impossible.
Every deviation is listed below and referenced by its number in the code.

## Layers

```
core/              harness-independent memory pipeline (imports only node:*)
adapters/dsh/      DeepSeek Harness host plugin
client.js          DeepSeek Harness configuration page
```

The core reaches a harness only through four ports (`core/ports.js`):
`SessionSource`, `ModelClient`, `ConsolidationRunner`, and `Clock`/`Logger`.
`scripts/check-boundaries.js` runs in the test suite and fails if the core
imports anything else. The tests drive the core through in-memory doubles of
these ports, which is the second adapter that keeps the boundary honest.

## Pipeline

Triggered whenever a root session starts a turn, in the background, one pass at a time:

1. **Prune** stage-one outputs unused for 30 days that the last consolidation did not use.
2. **Phase 1, extract.** Claim up to 2 conversations that were updated within
   the last 10 days and have been idle for 6 hours, skipping those already
   processed at their current version. Each is filtered, redacted and sent to
   the extraction model with the Codex stage-one prompt, which returns a raw
   memory and a rollout summary, or nothing when the conversation holds no
   durable signal. Jobs are leased in SQLite and retried with backoff.
3. **Phase 2, consolidate.** Select the top 256 outputs by use and recency,
   write them to `raw_memories.md` and `rollout_summaries/`, and diff the
   memory folder against its last git baseline. With no changes it stops
   without a model call. Otherwise an isolated agent runs the Codex
   consolidation prompt over the diff and updates `MEMORY.md`,
   `memory_summary.md` and `skills/`. The artifacts are validated, then the
   baseline is reset. A 6-hour cooldown follows a success.
4. **Read path.** Each new agent gets the read-path instructions and
   `memory_summary.md` (truncated to 2,500 tokens) as a system-prompt section,
   frozen at creation. Tools let the model list, read and search the memory
   folder and record explicit corrections as ad-hoc notes.

## Deviations from Codex

| # | Codex | Here | Why |
|---|---|---|---|
| D1 | Rust | Node ESM with JSDoc, no build | DSH host plugins run in Node |
| D2 | Rollout JSONL of `ResponseItem`s | DSH session events mapped to the same item shape; inherited events, compaction replacements and injected instruction, skill, configuration and compaction messages are dropped; environment context is kept | Different log format; same filtering policy |
| D3 | Candidates come from Codex's `threads` table | The adapter lists threads; the core applies the same age, idle and enabled filters | DSH has no such table |
| D4 | Strict JSON output schema | The prompt asks for JSON; a fenced block is unwrapped; anything else fails the job and is retried | DSH model calls have no schema option |
| D5 | Internal ephemeral thread under an OS sandbox | `agents.create` as a hidden subagent session: all inherited tools masked, five file tools confined to the memory folder in code, `workspace-write` sandbox, `never` approvals, global workspace instructions removed | DSH has no ephemeral threads; tools live in presets on Web/desktop |
| D6 | Developer message at thread start | System-prompt section added when the agent is created | Closest instruction level available to a plugin; survives compaction |
| D7 | Usage counted from hidden citation markup | Usage counted when a rollout summary is read (memory tool or `read`), once per turn; the citation section of the read-path prompt is removed | DSH cannot hide markup from the user |
| D8 | Read path may grep raw rollout files | That step is removed | DSH logs are compressed |
| D9 | Summary file names use the UUIDv7 timestamp | Session creation time | DSH ids are UUIDv4 |
| D10 | OS file lock on the workspace | Exclusive lock file with dead-owner detection; the database lease stays the main guard | Node has no `flock` |
| D11 | Baseline via `gix` | Baseline via the `git` executable, without user config or hooks | No embedded git in Node |
| D12 | Model names | Routes `{provider, model, reasoningEffort?}`, chosen per phase | One DSH process hosts many providers |
| D13 | Rate-limit guard on Codex accounts | Skip before claiming when a route is unusable; release claims on credential errors; time out each call | No quota interface; avoids burning retries |
| D14 | Read path asks the model to write notes into the memory folder | It uses the ad-hoc note tool | The folder is outside a normal session's write sandbox |
| D15 | Only injected AGENTS.md and skill blocks are excluded | Optional `externalKnowledge`: content read from a configured knowledge base is replaced with a placeholder, and sessions that touch `sessionExcludedPaths` are excluded entirely (Codex's `polluted` mode) | Codex keeps human-maintained knowledge out of memory, but a knowledge base read through tools can only be recognized by path |

## Known limitations

- Usage is approximate: search hits and shell reads of summaries are not counted.
- The knowledge-base filter cannot remove paraphrases in assistant replies or paths built from variables.
- Each consolidation leaves one hidden subagent session in DSH's session store; DSH has no deletion interface.
- The first turn on an empty memory folder runs one consolidation over empty inputs, then the 6-hour cooldown applies, as in Codex.
- Tested on macOS with DSH 0.2.2-rc.1.
