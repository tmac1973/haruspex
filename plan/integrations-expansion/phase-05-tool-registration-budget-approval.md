# Phase 05 — Dynamic tool registration, tool budget, approval gate

**Depends on:** Phases 03, 04 · **Enables:** Phase 06.

## Goal

Make MCP tools appear to the model at runtime, keep the number of them from
wrecking a small model, and gate anything that isn't provably read-only behind a
user approval.

## Files touched

- **NEW** `src/lib/agent/tools/mcp.ts` — dynamic registration and the shared
  executor.
- **NEW** `src/lib/agent/tools/mcp.test.ts`.
- **NEW** `src/lib/stores/mcpApproval.svelte.ts` — the approval prompt store.
- **NEW** `src/lib/components/McpApprovalCard.svelte` — the prompt UI.
- **NEW** `src/lib/agent/mcp-budget.ts` — the model-scaled cap.
- **EDIT** `src/lib/agent/tools/registry.ts` — `unregisterTool`, the `mcp` filter
  arm, per-tool enablement, and the hard gate in `executeTool`.
- **EDIT** `src/lib/agent/tools/types.ts` — `'mcp'` in the `category` union.
- **EDIT** `src/lib/agent/tools/index.ts` — side-effect import.

## Implementation

### Dynamic registration into the existing registry

The registry is a static `Map` populated by `registerTool` at module load, and
`getToolSchemas` / `executeTool` / `getDisplayLabel` all read from it. MCP tools
join that same Map rather than living in a parallel list — which means
`coerceArgsToSchema` (absorbing stringified-JSON and wrong-typed args from small
models), the nearest-name suggestion for hallucinated calls, and display labels
all keep working with no duplication.

Two new registry functions:

```ts
export function registerMcpTools(serverId: string, tools: McpToolDescriptor[]): void;
export function unregisterMcpServer(serverId: string): void;
```

Called when a server reaches ready and when it stops or is disabled. All of them
share one executor that dispatches to the Phase 03 `tools/call` command.

**Naming.** `mcp__<serverId>__<toolName>`. Two servers exposing `search` must not
collide, and the prefix makes it obvious in the UI and in logs where a tool came
from. Keep the server's original name in the descriptor for display.

### Gating, twice

Per-tool enablement is persisted on the server config (Phase 04). A disabled tool
is filtered out of `getToolSchemas` **and** hard-gated in `executeTool`.

The second check is the one that actually protects the user. `executeTool`
resolves names against the full registry, so schema filtering alone does not stop
execution — a small model can emit a call from its training prior that it was
never offered. The existing sandbox and memory-write gates in `registry.ts`
document precisely this failure, and the MCP gate must follow them.

### Approval

`mcpApproval.svelte.ts` mirrors `codeCommandApproval.svelte.ts` exactly:
`askMcpApproval(...)` returns a Promise, a mounted card renders the pending
request, the user's choice resolves it, and a second overlapping request rejects
because the agent loop serializes tool calls.

Choices: `allow_once` · `allow_always` (remembered per tool, per server, persisted)
· `deny` (the tool returns a denial the model can act on, rather than throwing).

The decision rule:

- `annotations.readOnlyHint === true` → run without prompting.
- Anything else → prompt.
- **A missing annotation is treated as non-read-only.** Servers are third-party
  code; absence of a claim is not a claim of safety.

Show the user what they are approving: the server, the tool, its description,
its destructive/open-world hints, and the arguments the model actually passed.

### Tool budget

Every exposed tool's schema ships in **every** request, so a 30-tool server is a
permanent context tax and a tool-selection problem for a 9B model.

`mcp-budget.ts` computes the cap from the active model — small models get a
tighter one — and estimates the real cost of the enabled schemas with
`estimateTokens` from `src/lib/agent/context-budget.ts`, which is the same
byte-based heuristic the rest of the pipeline trusts.

Over the cap, the UI **warns** and points at the per-tool toggles. It never
auto-disables: a tool the user enabled silently vanishing is worse than a tool
that is merely inadvisable. The warning names the number of tools, the estimated
token cost, and the model it is judged against.

## Build gate

```bash
npm run check && npm run lint && npm run test
```

## Test plan

- **Unit (TS):**
  - Register two servers exposing the same tool name; both are callable and
    distinct.
  - `unregisterMcpServer` removes exactly its own tools.
  - A disabled tool is absent from schemas **and** refused by `executeTool`.
  - `readOnlyHint: true` does not prompt; `false`, `destructiveHint: true`, and
    **absent annotations** all prompt.
  - `allow_always` persists and suppresses the second prompt; `deny` returns a
    tool error, not an exception.
  - The budget warning triggers above the cap for a small model and not for a
    large one; enabling more tools raises the estimate.
- **Manual** — with a real multi-tool server on the 9B tier: confirm the warning
  appears, disable tools until it clears, and confirm the model's tool selection
  improves.

## Commit

`feat(mcp): register server tools dynamically with approval and a tool budget`

## Rollback

Revert. With no MCP tools registered the registry behaves exactly as before.
