# Phase 08 — `sendMessage` decomposition

**Severity addressed:** 9 · **Effort:** ~4 hours · **Risk:** Medium

Resolves complexity-audit C-3 (258-line orchestration function, cyclomatic ≈48) and design-pattern P-3 (implicit Chain of Responsibility in message preprocessing).

**Prerequisite:** Phase 07 complete. `runAgentLoop`'s shape is stable.

## Goal

Split `sendMessage` in `src/lib/stores/chat.svelte.ts:499-756` into:
- `ensureActiveConversation` — input validation + conversation creation
- `buildApiPrompt(conv, content)` — prompt assembly, lastTurnTools splice, hint injection
- `streamCallbacks(conv, stats)` — onDelta / onToolCall / onToolResult / onCallStats wiring
- `commitAssistantMessage(conv, stats)` — post-loop bookkeeping
- `handleTurnError(conv, e)` — error mapping + UI state cleanup

`sendMessage` ends up ≤ 50 LOC orchestrating these.

Decide while implementing whether to introduce `MessageMiddleware` formally (design-pattern P-3 / M-2). The minimum win is the function decomposition; middleware is optional polish.

## Files touched

- **EDIT** `src/lib/stores/chat.svelte.ts`
- **NEW (optional)** `src/lib/agent/middleware.ts` — only if you choose to formalize the chain

## Implementation

### Step 1 — extract pure functions first

These are the safest. Each is a single-purpose helper.

```ts
// chat.svelte.ts (top-of-file or just above sendMessage)

function ensureActiveConversation(): Conversation | null {
	if (!activeConversationId) createConversation();
	const conv = getActiveConversation();
	return conv ?? null;
}

function finalizeUserTurn(conv: Conversation, content: string): void {
	if (conv.messages.length === 0) {
		const title = generateTitle(content);
		conv.title = title;
		dbRenameConversation(conv.id, title);
	}
	const userMessage: ChatMessage = { role: 'user', content: content.trim() };
	conv.messages.push(userMessage);
	conv.updatedAt = Date.now();
	dbSaveMessage(conv.id, userMessage);
}

function buildApiPrompt(conv: Conversation, content: string, workdir: string | null): ChatMessage[] {
	const historyMessages = conv.messages.filter((m) => m.role !== 'tool' && !m.tool_calls);
	let messages: ChatMessage[] = [buildSystemPrompt(workdir), ...historyMessages];

	const keepRecentTools = getSettings().keepRecentToolResults;
	if (keepRecentTools && conv.lastTurnTools && conv.lastTurnTools.length > 0) {
		const insertIdx = messages.length - 2;
		if (insertIdx >= 0 && messages[insertIdx].role === 'assistant') {
			messages = [
				...messages.slice(0, insertIdx),
				...conv.lastTurnTools,
				...messages.slice(insertIdx)
			];
		}
	}

	return injectMessageHints(messages, {
		workingDir: workdir,
		exhaustiveResearch: getExhaustiveResearch()
	});
}
```

### Step 2 — extract the stream-callback wiring

This block (`chat.svelte.ts:~595-720` — onDelta, onToolStart, onToolResult, onCallStats, onSearchStep) is the longest cohesive chunk in `sendMessage`. Extract it as a function that **returns** the callback object passed to `runAgentLoop`:

```ts
function buildStreamCallbacks(
	conv: Conversation,
	statsRef: { last: { durationMs: number; completionTokens: number } | null }
): Partial<AgentLoopOptions> {
	return {
		onDelta: (text) => { streamingContent += text; },
		onToolStart: (call) => { /* push searchStep */ },
		onToolResult: (call, result) => { /* update searchStep, track sourceUrls */ },
		onCallStats: (s) => { statsRef.last = s; },
		// …
	};
}
```

### Step 3 — extract commit and error helpers

```ts
function commitAssistantMessage(conv: Conversation, computeStats: () => MessageStats | null): void {
	const assistant: ChatMessage = {
		role: 'assistant',
		content: streamingContent,
		stats: computeStats() ?? undefined
	};
	conv.messages.push(assistant);
	conv.updatedAt = Date.now();
	dbSaveMessage(conv.id, assistant);
	streamingContent = '';
}

function handleTurnError(conv: Conversation, e: unknown): void {
	if (e instanceof DOMException && e.name === 'AbortError') {
		// existing abort-cleanup branch
		return;
	}
	errorMessage = e instanceof Error ? e.message : String(e);
	errorTurnId = currentTurnId;
	// existing error-cleanup branch
}
```

### Step 4 — slim `sendMessage`

```ts
export async function sendMessage(content: string): Promise<void> {
	if (!content.trim() || isGenerating || isCompacting) return;

	const conv = ensureActiveConversation();
	if (!conv) return;

	await compactIfNeeded();
	finalizeUserTurn(conv, content);

	isGenerating = true;
	streamingContent = '';
	errorMessage = null;
	errorTurnId = null;
	currentTurnId = beginTurn();
	conv.searchSteps = [];
	conv.sourceUrls = [];
	abortController = new AbortController();

	const statsRef: { last: { durationMs: number; completionTokens: number } | null } = { last: null };
	const computeStats = (): MessageStats | null => { /* unchanged */ };

	try {
		const workdir = workingDir;
		const expectsFileOutput = !!workdir && looksLikeFileOutputRequest(content);
		const messagesForApi = buildApiPrompt(conv, content, workdir);
		await runAgentLoop({
			messages: messagesForApi,
			signal: abortController.signal,
			workingDir: workdir,
			contextSize: getContextSize(),
			deepResearch: getExhaustiveResearch(),
			expectsFileOutput,
			visionSupported: getVisionSupported(),
			...buildStreamCallbacks(conv, statsRef)
		});
		commitAssistantMessage(conv, computeStats);
	} catch (e) {
		handleTurnError(conv, e);
	} finally {
		isGenerating = false;
	}
}
```

### Step 5 (optional) — `MessageMiddleware`

If `buildApiPrompt` ends up needing to grow (e.g. token-budget trimming, follow-up citation injection), formalize it as a middleware chain. **Skip if buildApiPrompt is ≤ 30 LOC** — the abstraction isn't justified yet.

```ts
// src/lib/agent/middleware.ts
export interface MessageMiddleware {
	name: string;
	process(messages: ChatMessage[], ctx: TurnContext): Promise<ChatMessage[]> | ChatMessage[];
}

export async function applyMiddleware(
	initial: ChatMessage[],
	middlewares: MessageMiddleware[],
	ctx: TurnContext
): Promise<ChatMessage[]> {
	let msgs = initial;
	for (const m of middlewares) msgs = await m.process(msgs, ctx);
	return msgs;
}
```

## Build gate

```bash
npm run check
npm run lint
npm run test
```

## Test plan

### Smoke

1. App launches.

### Targeted — sendMessage happy paths

2. **First message in fresh conversation:**
   - Click "New chat"; send *"Hello"*. Verify the conversation title gets generated and the sidebar entry shows it.
3. **Follow-up:** ask a second question. Verify the previous user/assistant pair is still in the API prompt (visible via the App log if you have request logging on).
4. **Abort mid-stream:** send *"Write a long essay about dogs."*; hit stop after ~3 seconds. Confirm:
   - The partial assistant content is preserved (not blown away).
   - `isGenerating` returns to false.
   - No error toast appears.
5. **Compaction trigger:** open Settings → set a small context window if available, or build up a long conversation. When compaction fires, the assistant should produce a coherent reply that references the compacted summary.
6. **`keepRecentToolResults` on:** ask a research question; on the follow-up, the agent should reference the previous turn's tools without re-running them.
7. **Error path:** kill the llama-server (or set an invalid remote backend URL) and send a message. The error banner should appear with a sensible message; `isGenerating` should clear.

### Targeted — concurrent send blocked

8. Send a long-running message. While it's generating, type a second message and hit send. The second send must be a **no-op** (the function early-returns when `isGenerating === true`).

### Targeted — sandbox-replay path (`restoreSandboxSession`)

9. With sandbox enabled, run a Python tool call. Quit the app, relaunch. Open the same conversation. Send a follow-up that references the sandbox state. The sandbox session should restore correctly (this is `restoreSandboxSession`, called from `setActiveConversation` — verify it didn't regress).

If 2–9 pass, commit:

```
refactor: decompose sendMessage into focused helpers (#TBD)

258-line orchestration split into ensureActiveConversation,
finalizeUserTurn, buildApiPrompt, buildStreamCallbacks,
commitAssistantMessage, and handleTurnError. sendMessage is now
≤50 LOC. No behavioural change. MessageMiddleware skipped —
not justified at current buildApiPrompt size.

Resolves audits/code-complexity-2026-05-14.md C-3 and
design-patterns-2026-05-14.md P-3 (partial — middleware
deferred).
```
