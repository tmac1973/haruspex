# Phase 5: Agent Loop & Tool Call Parsing

## Goal

Implement the agentic tool-call loop that allows the model to invoke tools (web search, URL fetch) across multiple turns. This phase builds the loop infrastructure and tool-call parsing — including the Granite XML fallback parser — but uses mock tool implementations. Real web search comes in Phase 6.

## Prerequisites

- Phase 3 complete (streaming chat works)
- Understanding of Granite 4.0's tool-call output format (XML `<tool_call>` tags)

## Deliverables

- **User-testable**: Send a message like "Search the web for today's weather in Portland" → the UI shows a "Searching..." step indicator → the model receives mock search results → the model composes a final answer citing those results. The tool-call/result cycle is visible in the UI.

---

## Tasks

### 5.1 Tool definitions (`src/lib/agent/tools.ts`)

Define the tool schemas passed to llama-server:

```typescript
export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information. Use this when the user asks about recent events, facts you are unsure about, or anything that benefits from up-to-date information.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch and extract the text content from a web page URL. Use this to read full articles or pages found via web_search.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' }
        },
        required: ['url']
      }
    }
  }
];
```

### 5.2 Granite XML fallback parser (`src/lib/agent/parser.ts`)

Granite 4.0 may return tool calls as XML in the content rather than in the structured `tool_calls` field. Implement a fallback parser:

```typescript
export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export function extractToolCalls(content: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name && parsed.arguments) {
        calls.push(parsed);
      }
    } catch {
      // Skip malformed tool calls
    }
  }
  return calls;
}

export function hasToolCalls(content: string): boolean {
  return /<tool_call>/.test(content);
}

export function stripToolCallXml(content: string): string {
  return content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
}
```

### 5.3 Tool call normalization

Create a unified function that checks both the structured response and the content fallback:

```typescript
export function resolveToolCalls(response: ChatCompletionResponse): ResolvedToolCall[] {
  // Prefer structured tool_calls if present
  if (response.tool_calls && response.tool_calls.length > 0) {
    return response.tool_calls.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }));
  }

  // Fallback: parse XML from content
  if (response.content && hasToolCalls(response.content)) {
    return extractToolCalls(response.content).map((tc, i) => ({
      id: `call_${Date.now()}_${i}`,
      name: tc.name,
      arguments: tc.arguments,
    }));
  }

  return [];
}
```

### 5.4 Agent loop (`src/lib/agent/loop.ts`)

Implement the multi-turn agent loop:

```typescript
interface AgentLoopOptions {
  messages: ChatMessage[];
  onToolStart: (call: ResolvedToolCall) => void;
  onToolEnd: (call: ResolvedToolCall, result: string) => void;
  onStreamChunk: (chunk: StreamChunk) => void;
  onComplete: () => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
  maxIterations?: number; // default 5, safety limit
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
  const { messages, maxIterations = 5, signal } = options;
  let iteration = 0;

  while (iteration < maxIterations) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    iteration++;

    const response = await chatCompletion({
      messages,
      tools: AGENT_TOOLS,
      stream: false, // non-streaming for tool-call turns
    });

    const toolCalls = resolveToolCalls(response);

    if (toolCalls.length === 0) {
      // Final answer — stream it
      const streamResponse = await chatCompletionStream({
        messages,
        tools: AGENT_TOOLS,
      });
      for await (const chunk of streamResponse) {
        options.onStreamChunk(chunk);
      }
      options.onComplete();
      return;
    }

    // Append assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: response.content || '',
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
      }))
    });

    // Execute tools
    for (const call of toolCalls) {
      options.onToolStart(call);
      const result = await executeTool(call.name, call.arguments, signal);
      options.onToolEnd(call, result);

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  // Max iterations reached — request final answer without tools
  const finalResponse = await chatCompletionStream({ messages });
  for await (const chunk of finalResponse) {
    options.onStreamChunk(chunk);
  }
  options.onComplete();
}
```

### 5.5 Tool executor with mock implementations

```typescript
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> {
  switch (name) {
    case 'web_search':
      return executeWebSearch(args.query as string, signal);
    case 'fetch_url':
      return executeFetchUrl(args.url as string, signal);
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}
```

For this phase, `executeWebSearch` and `executeFetchUrl` return canned mock data. Phase 6 replaces them with real implementations.

### 5.6 Search step UI (`src/lib/components/SearchStep.svelte`)

Display tool-call activity inline in the chat:

```
┌─────────────────────────────────┐
│ 🔍 Searching: "portland weather" │ ← tool name + query
│   ⏳ Searching...               │ ← status spinner
│   ✓ Found 3 results             │ ← completion
│                                  │
│ 📄 Reading: oregonlive.com       │ ← fetch_url
│   ✓ Done                         │
└─────────────────────────────────┘
```

- Collapsible: click to expand and see raw tool results (for debugging).
- Animated transitions between states.
- Shows between the user message and the assistant's final answer.

### 5.7 Source chip component (`src/lib/components/SourceChip.svelte`)

When the agent uses web sources, display clickable source chips below the answer:

```
[1] oregonlive.com  [2] weather.gov  [3] accuweather.com
```

- Extract URLs from tool results.
- Clicking opens the URL in the system browser (`tauri::shell::open`).

### 5.8 Chat store integration

Update the chat store to support the agent loop:

- `sendMessage` detects whether to use simple chat or agent loop (always use agent loop when tools are available — the model decides whether to invoke them).
- Tool-call messages and tool-result messages are stored in the conversation history.
- Search steps are tracked as transient UI state (not persisted).

### 5.9 Thinking indicator (`src/lib/components/ThinkingIndicator.svelte`)

Show a "Thinking..." indicator while the model is processing (before any tokens arrive):

- Animated dots or subtle pulse.
- Appears immediately when a message is sent.
- Disappears when the first stream chunk or tool call arrives.

---

## Test Coverage

| Area | What to test | Tool |
|---|---|---|
| XML parser | Extracts single tool call from content | Vitest |
| XML parser | Extracts multiple tool calls from content | Vitest |
| XML parser | Handles malformed JSON inside tool_call tags | Vitest |
| XML parser | Returns empty array when no tool calls present | Vitest |
| XML parser | `stripToolCallXml` removes tags, preserves other content | Vitest |
| Tool call normalization | Prefers structured `tool_calls` over XML fallback | Vitest |
| Tool call normalization | Falls back to XML when no structured calls present | Vitest |
| Agent loop | Executes tools and appends results to messages | Vitest |
| Agent loop | Stops after max iterations | Vitest |
| Agent loop | Respects abort signal | Vitest |
| Agent loop | Calls onToolStart/onToolEnd callbacks in order | Vitest |
| Agent loop | Streams final answer after tool calls | Vitest |
| Tool executor | Routes to correct tool implementation | Vitest |
| Tool executor | Returns error JSON for unknown tool names | Vitest |
| SearchStep | Renders running/done states | Vitest + testing-library |
| SourceChip | Renders URLs and handles click | Vitest + testing-library |

---

## Definition of Done

- [ ] Send a message that triggers tool use → model invokes `web_search` (visible in UI)
- [ ] Search step shows "Searching..." then "Done" with results
- [ ] Model receives mock tool results and composes a final answer
- [ ] Multi-tool sequences work (search → fetch → answer)
- [ ] Max iteration limit prevents infinite loops
- [ ] Generation can be cancelled during tool execution
- [ ] Thinking indicator shows while model is processing
- [ ] Source chips display and open URLs in system browser
- [ ] All unit tests pass, especially the XML parser edge cases
