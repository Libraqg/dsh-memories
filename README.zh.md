# dsh-memories

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/@libraqg/dsh-memories)](https://www.npmjs.com/package/@libraqg/dsh-memories) [![test](https://github.com/Libraqg/dsh-memories/actions/workflows/test.yml/badge.svg)](https://github.com/Libraqg/dsh-memories/actions/workflows/test.yml)

给 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（dsh）加上长期记忆。

**新会话一开始就知道你的偏好、你的项目，以及上次什么做法管用。**

dsh-memories 在后台读取你已经结束的会话，留下值得记住的内容，再把一份简短的记忆摘要交给每个新 agent，并提供查阅细节的工具。它移植自 [OpenAI Codex](https://github.com/openai/codex) 的记忆流水线，提示词、各项限制和文件结构都与 Codex 相同。

> [!WARNING]
> **测试版。** 这是早期版本，只由一个人在 macOS 上配合 dsh 的候选发布版测试过，可能会出现一些 bug，各版本之间的行为和设置也可能变化。遇到问题请到 [Issues](https://github.com/Libraqg/dsh-memories/issues) 反馈。

## 安装

需要 dsh 0.2.2-rc.1 或之后的 0.2.x 版本、Node.js 24.9 或更高版本（dsh 本身也需要），以及 `PATH` 里有 `git`。

```bash
dsh plugin --profile web add @libraqg/dsh-memories
```

也可以从 GitHub 源码安装：

```bash
dsh plugin --profile web add github:Libraqg/dsh-memories
```

或者从本地克隆安装：

```bash
git clone https://github.com/Libraqg/dsh-memories
cd dsh-memories && npm install
dsh plugin --profile web add link:/absolute/path/to/dsh-memories
```

桌面版请在应用的插件管理器里添加，桌面版的 profile 由应用自己管理。装好后重启 dsh。

## 使用

不需要做任何事，照常使用 dsh，记忆会自己积累。

1. 某个会话闲置 6 小时后，你在任意会话里开始下一轮对话时，插件会在后台从它提取记忆。每次最多处理 2 个会话。
2. 提取出的记忆由一个后台 agent 合并进同一个记忆文件夹，最多每 6 小时一次。
3. 每个新 agent 的系统提示里都有记忆摘要，也能用工具搜索和阅读完整记忆。你纠正它时（「以后都要……」），它会把纠正记成一条笔记，留给下次合并。

所以第一批记忆大约在你最初的几个会话结束 6 小时后才出现，不会立刻有。

### 选择模型

在插件管理器里打开本插件的设置。选一个**提取模型**（每个闲置的会话跑一次，快的模型就够）和一个**合并模型**（负责合并，强一些的模型效果更好）。改动不用重启就生效。

| 设置 | 默认值 |
|---|---|
| 提取模型 | `deepseek-official` / `deepseek-flash` |
| 合并模型 | `deepseek-official` / `deepseek-v4-pro` |

dsh 里配置过的任何 provider 都能用，包括已登录的订阅账号。

### `/memories` 命令

| 命令 | 作用 |
|---|---|
| `/memories` 或 `/memories status` | 查看模型、已存记忆数、失败的任务和上次合并情况 |
| `/memories path` | 查看记忆文件夹的位置 |
| `/memories model list` | 列出可选的 provider 和模型 |
| `/memories model set <extract\|consolidation> <provider> <model> [effort]` | 更换模型 |
| `/memories model clear <extract\|consolidation>` | 恢复默认模型 |
| `/memories reset --confirm` | 删除所有已存记忆 |

记忆文件夹里都是普通的 Markdown 文件，可以直接阅读，也可以删掉其中的文件。`memory_summary.md` 是新 agent 看到的内容，`MEMORY.md` 是完整的记忆手册。

## 配置

其他选项写在 profile 的 `cordis.patch.yml` 里本插件那一行。

| 选项 | 默认值 | 含义 |
|---|---|---|
| `memoryRoot` | `$DSH_HOME/memories`（`~/.dsh/memories`） | 记忆文件夹。必须是本插件专用的文件夹：插件会替换其中的 `.git`、删除符号链接，`/memories reset` 会清空它 |
| `stateDbPath` | 记忆文件夹旁边 | SQLite 状态数据库 |
| `generateMemories` | `true` | 提取和合并新记忆 |
| `useMemories` | `true` | 给 agent 提供摘要和记忆工具 |
| `externalKnowledge` | 关闭 | 把知识库挡在记忆之外，见下文 |
| `maxRolloutsPerStartup` | `2` | 每次提取的会话数 |
| `minRolloutIdleHours` | `6` | 会话闲置多久后才提取 |
| `maxRolloutAgeDays` | `10` | 更早的会话跳过 |
| `maxRawMemoriesForConsolidation` | `256` | 每次合并考虑的记忆条数 |
| `maxUnusedDays` | `30` | 超过这么多天没用到的记忆会被丢弃 |

### 把知识库挡在记忆之外

如果你的 agent 会读一个手工维护的笔记文件夹（比如 Obsidian vault），它的内容默认会被复制进记忆。把过滤器指向它：

```yaml
- id: memories
  name: '@libraqg/dsh-memories'
  config:
    externalKnowledge:
      root: ~/Documents/Notes
      sessionExcludedPaths:
        - personal
```

从 `root` 读到的内容在提取前会被替换成占位符。读过 `sessionExcludedPaths` 下任何文件的会话会被整个排除在记忆之外，它之前产生的记忆也会在下次合并时丢弃。

## 工作原理

| 部分 | 作用 |
|---|---|
| 提取 | 过滤并脱敏一个会话，然后让提取模型给出一条原始记忆和一份摘要；会话里没有值得长期保留的内容时什么也不给 |
| 合并 | 一个隐藏的 agent，只能用记忆文件夹内的五个文件工具，把上次合并以来的变化合并进 `MEMORY.md`、`memory_summary.md` 和 `skills/` |
| 读取 | 一段带摘要的系统提示（最多 2,500 token），加上工具 `memories_list`、`memories_read`、`memories_search`、`memories_add_ad_hoc_note` |
| 存储 | 记忆文件夹（Markdown，用一个私有的 git 基线跟踪变化）和一个 SQLite 任务数据库 |

设计和与 Codex 的每一处差异见 [docs/DESIGN.md](docs/DESIGN.md)（英文）。

## 权限与风险

- **会发送什么：** 会话内容会发给提取模型的 provider，提取出的记忆会发给合并模型的 provider。和 Codex 一样，看起来像 API key 和 token 的密钥会先被脱敏。子 agent 的会话和插件自己的会话会被跳过。
- **文件：** 只写记忆文件夹，外加它旁边的一个 `.lock` 文件，以及状态数据库和它的 `-wal`、`-shm` 文件。合并 agent 的文件工具会拒绝记忆文件夹以外的路径和其中 `.git` 里的路径，它的其他工具都被禁用。
- **命令：** 只在记忆文件夹上运行 `git`，不使用你的 git 配置和 hooks。
- **给 dsh 增加了什么：** 四个 agent 工具、一段系统提示、`/memories` 命令、一个设置页，以及每次合并留下的一个隐藏子 agent 会话。
- **模型用量：** 每个会话提取一次，即一次模型调用；每次合并是一次 agent 运行。不用 dsh 的时候什么都不会运行。

## 已知限制

- 记忆来自至少闲置 6 小时的会话，所以会有滞后。
- 决定保留哪些记忆的使用计数是近似的：只统计 agent 打开过的摘要，不统计搜索命中。
- 知识库过滤靠匹配路径，抓不到 agent 在回复里转述的笔记内容，也抓不到用 shell 变量拼出来的路径。
- 每次合并会在 dsh 的会话存储里留下一个隐藏的子 agent 会话。
- dsh 还是候选发布版。已在 macOS 上用 0.2.2-rc.1 测试。

## 开发

```bash
npm install
npm test
```

`core/` 不能依赖 dsh；`npm test` 会运行 `scripts/check-boundaries.js` 来检查这一点。

## 许可证

Apache-2.0。dsh-memories 移植自 [OpenAI Codex](https://github.com/openai/codex) 的记忆流水线，Copyright 2025 OpenAI；改动记录在 [NOTICE.md](NOTICE.md)。
