# rpiv-advisor

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor">
    <picture>
      <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-advisor/docs/cover.png" alt="rpiv-advisor cover" width="50%">
    </picture>
  </a>
</div>

Let the model ask a stronger model for a second opinion before it acts. `rpiv-advisor` adds the `advisor` tool and `/advisor` slash command to [Pi Agent](https://github.com/badlogic/pi-mono) - the working model can hand the full conversation to a reviewer (e.g. Opus) and resume with its plan, correction, or stop signal.

![Advisor model selector](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-advisor/docs/advisor.jpg)

## Features

- **Reviewer model selector** - `/advisor` opens a picker over any model in Pi's registry, plus a reasoning-effort picker for reasoning-capable models. Start typing to fuzzy-filter the list by model name or `provider:id`.
- **Persisted across sessions** - selection saved at `~/.config/rpiv-advisor/advisor.json` (chmod 0600).
- **Off by default** - the `advisor` tool is excluded until you pick a model; choose "No advisor" to disable.
- **Per-executor blocklist** - list executor models in `disabledForModels` (in `advisor.json`) to strip the `advisor` tool when those models drive the session. Entries can be plain strings (block at any effort) or `{ "model": "<provider:id>", "minEffort": "<level>" }` to block only when the executor's effort meets or exceeds the threshold. Available levels, lowest to highest: `minimal`, `low`, `medium`, `high`, `xhigh`.
- **Per-executor advisor routing** - list `{ "executor": "<provider:id>", "advisor": "<provider:id>", "effort"?: "<level>" }` entries in `perExecutor` (in `advisor.json`) to route specific executors to specific advisor models. Use it to pair models that critique each other well (e.g. opus reviews gpt-5.5, gpt-5.5 reviews opus) without re-picking via `/advisor` between sessions. Optional `effort` falls back to the top-level `effort`; on no-match or registry-miss the default advisor is used. `disabledForModels` still wins — a blocked executor never reaches routing.
- **Per-executor guidance** - list `{ "models": ["<provider:id>", ...], "guidance": { "promptSnippet"?: string, "promptGuidelines"?: string[] } }` entries in `perExecutorGuidance` (in `advisor.json`) to override the injected `advisor` tool guidance for specific executors. Group several model keys under one block so variant families (e.g. `gpt-5.6-sol`/`terra`/`luna`) share one policy. Resolution is field-level and three-tiered, highest first: the matched per-executor block, the global `guidance` field, then the built-in defaults — so a block that sets only `promptGuidelines` still inherits the global-or-default `promptSnippet`. The active override follows the executor: it is re-applied on `model_select` and at agent start. Use it to tell eager instruction-followers to never call the advisor as a first step while keeping it available on complex work.
- **Advisor chain walking** - the `perExecutor` table also defines a chain: each model's `advisor` is the next hop. Call `advisor({ depth: N })` to walk up to N tiers, or `advisor({ target: "opus" })` to walk until a model matching that name or `provider:id` key is reached (target wins, bounded by depth). Each tier sees the conversation branch plus prior advisor responses; the final tier's reply is returned. Cycles and dead-ends terminate gracefully. `advisor()` with no arguments stays a single hop.
- **Zero-parameter handoff** - calling `advisor()` with no arguments forwards the full serialized conversation branch; no manual prompt needed (chain walking via `depth`/`target` is opt-in).

## Install

```bash
pi install npm:@juicesharp/rpiv-advisor
```

Then restart your Pi session.

## Usage

Configure an advisor model with `/advisor` - the command opens a selector for
any model registered with Pi's model registry, plus a reasoning-effort picker
for reasoning-capable models. Selection persists across sessions at
`~/.config/rpiv-advisor/advisor.json` (chmod 0600).

The `advisor` tool is registered at load but excluded from active tools by
default; selecting a model via `/advisor` enables it. Choose "No advisor" to
disable.

Calling `advisor()` forwards the full serialized conversation branch to the
advisor model, which returns guidance (plan, correction, or stop signal) that
the executor consumes. The default call is a single hop; pass `depth` or
`target` to walk the chain configured in `perExecutor` (see Features).

## Tool

- **`advisor`** - escalate the current conversation branch to the configured reviewer model. Inactive until a model is selected via `/advisor`.

### Schema

```ts
advisor()                       // single hop (default, unchanged)
advisor({ depth: 3 })           // walk up to 3 advisor tiers along the chain
advisor({ target: "opus" })     // walk until a model named/keyed "opus" is reached
```

- `depth?: integer` (1–10) - number of advisor tiers to walk along the `perExecutor` chain. Default 1.
- `target?: string` - walk until a model whose name (case-insensitive partial) or `provider:id` key matches. Wins over `depth`; still bounded by it.

The full conversation branch is auto-serialized from `ctx.sessionManager` - the LLM does not (and cannot) pass it explicitly.

Returns:

```ts
{
  content: [{ type: "text", text: string }], // reviewer's guidance, or error message
  details: {
    advisorModel?: string,        // "<provider>:<modelId>"
    effort?: ThinkingLevel,       // reasoning effort, when applicable
    usage?: Usage,                // token usage from the side-call
    stopReason?: StopReason,      // pi-ai stop reason
    errorMessage?: string,        // populated on auth/abort/error/empty paths
  }
}
```

## License

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-advisor.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-advisor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MIT
