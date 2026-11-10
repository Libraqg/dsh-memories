# Upstream provenance

The files under `memories/` are verbatim copies of prompt templates from
[openai/codex](https://github.com/openai/codex) at commit
`748ab55ca7de0b647d9a7a9d9a8e70e00f28666d`, licensed under Apache-2.0.
See `LICENSE.codex` and `NOTICE.codex`.

| Local file | Upstream path |
|---|---|
| `memories/stage_one_system.md` | `codex-rs/memories/write/templates/memories/stage_one_system.md` |
| `memories/stage_one_input.md` | `codex-rs/memories/write/templates/memories/stage_one_input.md` |
| `memories/consolidation.md` | `codex-rs/memories/write/templates/memories/consolidation.md` |
| `extensions/ad_hoc/instructions.md` | `codex-rs/memories/write/templates/extensions/ad_hoc/instructions.md` |
| `memories/read_path.md` | `codex-rs/ext/memories/templates/memories/read_path.md` (edited at load time by `core/read-path.js`, see D7, D8, D14) |

The JavaScript under `core/` is a port of `codex-rs/memories/write`,
`codex-rs/ext/memories`, `codex-rs/state/src/runtime/memories.rs`,
`codex-rs/git-utils/src/baseline.rs`, `codex-rs/secrets` and
`codex-rs/utils/string`. Modifications are the deviations D1-D15 listed in
`docs/DESIGN.md`.

Do not edit the templates in place. To change behaviour, record the deviation
in the design document first.
