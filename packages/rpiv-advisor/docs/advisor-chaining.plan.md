# Plan: advisor chain walking

Implementation spec for adding optional depth/target chain walking to the
`advisor` tool. Branch: `feat/advisor-chaining`. Written from a design session;
implement in a fresh session against this doc.

## Goal

Today `advisor()` always makes exactly one escalation hop — executor → advisor
(per-executor route or global default). Extend it so the executor can optionally
walk a **chain of advisors** defined implicitly by the existing `perExecutor`
routing table: each model's `advisor` entry is the next node.

Concrete example:

```
perExecutor:
  sonnet → kimi
  kimi   → gpt
  gpt    → opus
```

Calling `advisor({ depth: 3 })` from sonnet walks sonnet→kimi→gpt→opus and
returns opus's response. Calling `advisor()` (no args) walks one hop to kimi —
exactly current behavior.

## Locked design decisions

1. **Backward compatibility is non-negotiable.** `advisor()` with no arguments
   MUST behave identically to today. `depth` and `target` are both optional.
2. **Chain topology comes from the existing `perExecutor` config — no new
   config structure.** Each node in the chain is resolved by looking up the
   next model via that tier's own `perExecutor` entry. No `chain: []` array,
   no separate chain config.
3. **User-directed depth, not framework-decided.** The executor passes
   `depth`/`target` because the user told it to ("escalate this to opus").
   We intentionally do NOT have the framework auto-decide depth based on
   response quality — that's unreliable. Autonomous executor judgment is a
   supported side-effect but not the design target.
4. **Both `depth` and `target` are accepted; `target` wins on conflict.** If
   both are supplied, walk until the target is reached OR depth is exhausted —
   whichever comes first.
5. **Context threading: each tier sees prior advisor responses.** Tier N
   receives the original executor branch plus all prior advisor responses
   prepended as context messages. The final tier's response is returned to
   the executor.
6. **Cycle detection: terminate, don't throw.** If a model key appears twice
   in the walk sequence, stop before revisiting it. Return the last completed
   tier's response and log a warning. Do not surface an error to the executor
   — the output is still useful.
7. **Target matching: partial name OR full colon-form key.** `"opus"` matches
   any model whose `name` field contains "opus" (case-insensitive). Full key
   `"anthropic:claude-opus-4-8"` also matches. First walk node whose model
   name OR key satisfies the match is the target.
8. **Tool description is updated dynamically on `model_select`.** Re-register
   the advisor tool (same name) when the executor model changes so the
   description reflects the chain available from the new executor. If no chain
   exists for the current executor, the description omits chain details.
9. **Effort per tier: inherit the call-site effort.** The effort used at depth
   1 (from `entry.effort ?? getAdvisorEffort()`) is reused for all deeper
   tiers. Each tier's entry's own `effort` override (if set) takes precedence
   over the inherited value, exactly as depth-1 resolution works today.

## Chain resolution algorithm

```
resolveChain(executor, depth, target, modelRegistry, perExecutorCache):
  nodes = []
  current = executor
  visited = { executor.key }

  loop up to depth times (or until target found):
    entry = findPerExecutorOverride(current)
    if no entry: break                          // chain ends here
    next = modelRegistry.find(entry.advisor)
    if no next: break                           // advisor not available
    if next.key in visited: warn + break        // cycle
    nodes.push({ model: next, effort: entry.effort })
    visited.add(next.key)
    if target and matchesTarget(next, target): break
    current = next

  return nodes  // may be empty (depth=0 result = no chain)
```

`resolveChain` returns a `ChainNode[]`. Empty → fall back to current
single-hop behavior (depth-1 is NOT a chain walk; it uses the existing
`resolveAdvisor` path unchanged to avoid regression).

Actually, simpler: depth=1 IS a chain walk of length 1. The existing
`resolveAdvisor` path is kept for the `no-args` default call and becomes
the depth-1 branch in the new logic. Both paths must produce identical
results for depth=1.

Revised approach — unify at depth=1:

```
if depth == 1 and no target:
  use existing resolveAdvisor() path  // zero regression risk
else:
  use resolveChain() and walkChain()
```

## Context threading

For a chain walk of N tiers, tier K receives:

1. The executor's conversation branch (same as today — `branchMessages`)
2. A synthetic `user` message prepended: prior advisor responses formatted as:

```
[Advisor 1 — kimi:response]
{tier-1 response text}

[Advisor 2 — gpt:response]
{tier-2 response text}
```

This keeps the context structure simple (user → assistant → user is the
standard pattern for `completeSimple`). Each tier's `onUpdate` emits a
`msgConsulting` notification for its own model.

## Tool input schema change

```typescript
// register.ts — was: Type.Object({})
const AdvisorParams = Type.Object({
  depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10,
    description: "Number of advisor tiers to walk (default: 1)" })),
  target: Type.Optional(Type.String({
    description: "Walk until this model name or key is reached (e.g. 'opus')" })),
});
```

`maximum: 10` is a safety rail — not a design limit.

## Tool description (dynamic)

**Static part** (always present):

```
Escalate to a stronger reviewer model for guidance. When you need stronger
judgment — a complex decision, an ambiguous failure, a problem you're circling
without progress — escalate to the advisor model for guidance, then resume.
Your entire conversation history is automatically forwarded. The advisor sees
the task, every tool call you've made, every result you've seen.
```

**Dynamic suffix** appended when a chain exists for the current executor:

```
Chain available from current executor: kimi → gpt → opus
Pass depth (e.g. depth:2) to walk N tiers, or target (e.g. target:"opus")
to walk until a specific model. Default: depth 1 (one hop to kimi).
```

**When no chain:** suffix omitted. Description says `Takes no parameters` as today.

**Update trigger:** re-register the tool inside `registerModelSelectHandler`
after `reconcileAdvisorTool` runs, only when the new description differs from
the registered one. Track the last-registered description in module state to
avoid churn.

Open question: confirm that `pi.registerTool` with the same `name` updates the
live definition mid-session. If not, the dynamic description must be deferred
to a future iteration and the description is static with generic chain mention.

## Current code (accurate sections)

### `advisor/execute.ts`
- `resolveAdvisor(ctx)` → `{ advisor, effort }` — single-hop resolution.
- `executeAdvisor(ctx, pi, signal, onUpdate)` → `AgentToolResult` — single call.
- **Change:** `executeAdvisor` receives `params: AdvisorParams` (depth, target).
  For default/depth-1: delegate to existing `resolveAdvisor` path.
  For depth>1 or target: call `resolveChain` then `walkChain`.

### `advisor/register.ts`
- `AdvisorParams = Type.Object({})` — zero params today.
- `ADVISOR_DESCRIPTION` is a module-level constant string.
- `registerAdvisorTool(pi)` called once at startup.
- **Change:** params get depth/target fields; description becomes a computed
  function; `registerAdvisorTool` is called again on model_select when needed.

### `advisor/handlers.ts`
- `registerModelSelectHandler(pi)` calls `reconcileAdvisorTool` on model change.
- **Change:** after reconcile, re-register the tool with updated description if
  the chain topology changed.

### `advisor/policy.ts`
- `findPerExecutorOverride(model)` — already used by `resolveAdvisor`.
- **New:** `resolveChain(executor, depth, target, registry)` added here or in
  execute.ts (co-locate with its consumer — execute.ts preferred since policy.ts
  is already slim).

### `advisor/messages.ts`
- **New:** `warnChainCycle(keys: string[])`, `msgChainWalking(tier, total, label)`,
  `errChainTargetNotFound(target)` (info-level — not an error, just reached end).
- The `msgConsulting` existing message is reused per-tier.

## Implementation outline

### 1. `messages.ts`
Add cycle warning, per-tier consulting message variant (or reuse existing),
and the `buildChainSuffix(chainLabels: string[])` string builder for the
dynamic description suffix.

### 2. `execute.ts`
- Add `ChainNode { model, effort }` type.
- Add `resolveChain(executor, depth, target, registry): ChainNode[]`.
- Add `walkChain(ctx, pi, nodes, branchMessages, signal, onUpdate): string`
  that walks nodes, threading prior responses as context, returns final
  tier's text.
- Update `executeAdvisor` signature to accept `params: { depth?: number,
  target?: string }`. Default path (no params) unchanged. Chain path:
  resolve → walk → build result envelope.

### 3. `register.ts`
- Widen `AdvisorParams` with optional `depth` / `target` fields.
- Extract description building into `buildAdvisorDescription(chainLabels?)`.
- Export `registerAdvisorTool` unchanged signature; it builds and registers
  the correct description for the current executor at call time.

### 4. `handlers.ts`
- In `registerModelSelectHandler`, after `reconcileAdvisorTool`, compute new
  chain labels for the new executor. If different from last registered, call
  `registerAdvisorTool(pi)` again (re-register updates description).
- Track last-registered description in module state to avoid redundant calls.

### 5. `policy.ts`
Add `resolveChainLabels(executor, registry): string[]` (model display names in
chain order) for use by description builder. Shares chain-walk logic with
execute.ts's `resolveChain` — factor a shared `walkChainNodes` if DRY matters;
otherwise keep them separate (one returns `ChainNode[]`, one returns `string[]`).

### 6. `index.ts`
Export any new public symbols (`resolveChain`, `walkChain`) if needed by tests.

## Tests

### `advisor.execute.test.ts` (extend)
- `depth: 1` matches existing single-hop behavior exactly.
- `depth: 2` calls completeSimple twice; second call receives prior response.
- `depth: 3` walks full chain; each tier gets accumulated context.
- `target: "gpt"` stops at gpt tier even if depth would go further.
- `target: "opus"` with chain that doesn't include opus → terminates at last
  available node (no error).
- Cycle in chain config → walk terminates before revisit; returns last result.
- Chain terminates when a tier's perExecutor entry is absent (no config for
  that model) — returns response from deepest reached tier.
- Chain terminates when a tier's advisor model is not in the registry —
  returns response from deepest reached tier.
- `depth` and `target` both specified → stops at whichever comes first.
- `no params` → unchanged single-hop path, no regression.
- Effort resolution: tier with explicit `entry.effort` uses it; tier without
  inherits the call-site effort.

### `advisor.command.test.ts` (extend for description update)
- After `model_select` to an executor that has a chain, tool description
  contains chain suffix.
- After `model_select` to an executor with no chain, description does NOT
  contain chain suffix.
- No redundant re-registration when description unchanged.

### `advisor.policy.test.ts` or new `advisor.chain.test.ts`
- `resolveChain` returns empty array for no chain.
- `resolveChain` stops at depth limit.
- `resolveChain` stops at target match (partial name, full key).
- `resolveChain` detects cycle and stops before revisit.
- `resolveChain` stops when registry can't find a model.

## Gotchas

- **Zero-regression for depth=1:** The existing `resolveAdvisor` path must be
  preserved as the default. Do NOT route the no-args case through the new chain
  walker — any regression there would break every existing advisor call.
- **`completeSimple` concurrency:** The chain walk is sequential (each tier
  awaits the previous). Do not parallelize — we need tier N's response to
  contextualize tier N+1.
- **Signal propagation:** The abort signal must be threaded through every
  `completeSimple` call in the walk. If the signal fires mid-walk, return
  the last completed tier's response (or the abort envelope if tier 1 aborted).
- **`onUpdate` per tier:** Each tier should emit a `msgConsulting` update so
  the user sees progress. The final `onUpdate` payload should reflect the
  terminal tier's model, not the first.
- **Context size:** Accumulating responses across N tiers grows the message list.
  For now, include all prior responses verbatim. A future iteration can
  summarize when total context exceeds a threshold.
- **Target matching ambiguity:** `"opus"` might match multiple chain nodes
  (e.g., `claude-opus-3` and `claude-opus-4-8` in the same chain). Match the
  FIRST occurrence in walk order. Document this.
- **Re-registration safety:** Only re-register if the description text actually
  changed. Unnecessary re-registrations may cause UI flicker or tool-list churn.

## Commit

Single commit on `feat/advisor-chaining`:
`feat(rpiv-advisor): chain walking for advisor tool (depth/target params)`
— code + tests. Run `vitest run packages/rpiv-advisor` before committing.
