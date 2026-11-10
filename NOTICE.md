# Notice

dsh-memories is a port of the memory pipeline of **OpenAI Codex**
(<https://github.com/openai/codex>), Copyright 2025 OpenAI, licensed under
the Apache License 2.0. dsh-memories is distributed under the same licence;
see [LICENSE](LICENSE).

## Upstream base

Ported from Codex `main` at commit
`748ab55ca7de0b647d9a7a9d9a8e70e00f28666d`, memory version V1.

- `core/templates/` holds verbatim copies of the Codex prompt templates,
  together with Codex's own `LICENSE.codex` and `NOTICE.codex`.
  `core/templates/UPSTREAM.md` maps each file to its upstream path.
- The JavaScript under `core/` is a port of `codex-rs/memories/write`,
  `codex-rs/ext/memories`, `codex-rs/state/src/runtime/memories.rs`,
  `codex-rs/git-utils/src/baseline.rs`, `codex-rs/secrets` and
  `codex-rs/utils/string`.

## What changed (2026-11 onward, by libraqg)

- Rewritten from Rust in JavaScript and split into a harness-independent
  core and a DeepSeek Harness adapter (`adapters/dsh/`, `client.js`).
- Every behavioural difference from Codex is recorded as a numbered
  deviation, D1 to D15, in [docs/DESIGN.md](docs/DESIGN.md). The read-path
  template is edited at load time (D7, D8, D14); the other templates are used
  unchanged.

"Codex" and "OpenAI" are names of the upstream project and its owner.
dsh-memories is not affiliated with or endorsed by OpenAI.

## Third-party material

The runtime dependency `@deepseek-ai/schemastery` (MIT, Shigma) is installed
by npm and is not included in this repository. The DeepSeek Harness runtime and its packages are supplied by DeepSeek
Harness at run time and are not bundled here.
