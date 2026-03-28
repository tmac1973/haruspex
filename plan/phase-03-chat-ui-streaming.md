# Phase 3: Core Chat UI & Streaming

## Goal

Build the main chat interface with streaming responses from llama-server. Users can send messages and receive streamed responses in real-time. This phase establishes the core UX loop that everything else builds on.

## Prerequisites

- Phase 2 complete (server starts and reports ready)
- A working llama-server sidecar with a loaded model

## Deliverables

- **User-testable**: Open the app → type a message → see the response stream in token-by-token. Start a new conversation. Scroll through message history.

---

## Tasks

### 3.1 OpenAI-compatible API client (`src/lib/api.ts`)

Wrap llama-server's OpenAI-compatible `/v1/chat/completions` endpoint:

```typescript
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ChatCompletionOptions {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

interface StreamChunk {
  delta: { content?: string; tool_calls?: ToolCallDelta[] };
  finish_reason: string | null;
}
```

**Key implementation details:**

- Use `fetch()` with `ReadableStream` for SSE parsing (no external dependency).
- Parse `data: [DONE]` sentinel.
- Handle connection errors gracefully (server not ready, connection refused).
- Export an async generator: `chatCompletionStream(options): AsyncGenerator<StreamChunk>`
- Export a non-streaming variant for the first-run test message (Phase 4).

### 3.2 Chat store (`src/lib/stores/chat.ts`)

Manage conversation state with Svelte 5 runes:

```typescript
interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

// Reactive state
let conversations = $state<Conversation[]>([]);
let activeConversationId = $state<string | null>(null);
let isGenerating = $state(false);
```

**Functions:**

- `createConversation(): string` — returns new conversation ID
- `sendMessage(content: string): void` — appends user message, triggers generation
- `cancelGeneration(): void` — abort controller to cancel in-flight stream
- `deleteConversation(id: string): void`
- `clearAllConversations(): void`

**System prompt** (prepended to every conversation):

```
You are Haruspex, a helpful AI assistant running locally on the user's computer.
You are private — nothing the user says leaves their device.
Be concise, accurate, and helpful. If you don't know something, say so.
```

### 3.3 SSE stream parser

Implement robust SSE parsing for the `text/event-stream` response:

```typescript
async function* parseSSE(response: Response): AsyncGenerator<StreamChunk> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop()!; // keep incomplete line in buffer

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') return;
        yield JSON.parse(data);
      }
    }
  }
}
```

### 3.4 Chat page (`src/routes/+page.svelte`)

**Layout:**

```
┌────────────────────────────────────┐
│  Sidebar (conversations)  │ Chat  │
│  ┌──────────────────────┐ │       │
│  │ + New Chat            │ │       │
│  │ Conversation 1        │ │ msgs  │
│  │ Conversation 2        │ │       │
│  │ ...                   │ │       │
│  └──────────────────────┘ │       │
│                           │ input │
└────────────────────────────────────┘
```

- Sidebar: list of conversations, "New Chat" button, click to switch.
- Messages area: scrollable, auto-scroll during streaming (with "scroll to bottom" button if user scrolls up).
- Input area: textarea with Shift+Enter for newlines, Enter to send. Disabled while generating.
- Stop button: visible during generation, calls `cancelGeneration()`.

### 3.5 ChatMessage component (`src/lib/components/ChatMessage.svelte`)

- User messages: right-aligned or distinct styling.
- Assistant messages: left-aligned, with typing indicator during streaming.
- Render markdown in assistant messages (use `marked` or `markdown-it` — pick one lightweight lib).
- Code blocks with syntax highlighting (use `highlight.js` with a small subset of languages).
- Copy button on code blocks.

### 3.6 Auto-scroll behavior

- During streaming: auto-scroll to bottom on each chunk.
- If user scrolls up manually: stop auto-scrolling, show a "↓ New messages" pill.
- Clicking the pill or sending a new message re-enables auto-scroll.

### 3.7 Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Enter | Send message |
| Shift+Enter | Newline in input |
| Ctrl/Cmd+N | New conversation |
| Escape | Cancel generation |

### 3.8 Error handling

- Server not ready: disable input, show "Waiting for model to load..."
- Connection lost mid-stream: show error inline in the message, offer "Retry" button.
- Empty response: show "Model returned an empty response. Try rephrasing."

---

## Test Coverage

| Area | What to test | Tool |
|---|---|---|
| API client | SSE parsing handles chunked data, incomplete lines, `[DONE]` | Vitest |
| API client | Connection error produces a typed error, not an uncaught exception | Vitest |
| Chat store | `sendMessage` appends user message and triggers generation | Vitest |
| Chat store | `cancelGeneration` aborts the stream | Vitest |
| Chat store | `createConversation` generates unique IDs | Vitest |
| ChatMessage | Renders user vs assistant styling correctly | Vitest + testing-library |
| ChatMessage | Markdown rendering: headings, lists, code blocks, inline code | Vitest + testing-library |
| ChatMessage | Code block copy button triggers clipboard API | Vitest + testing-library |
| Auto-scroll | Scroll state transitions: auto → manual → auto on send | Vitest + testing-library |
| Input | Enter sends, Shift+Enter inserts newline | Vitest + testing-library |
| Error states | Displays correct error UI for each failure mode | Vitest + testing-library |

### Mock strategy

Mock `fetch` to return canned SSE streams for API client tests. Mock the Tauri invoke/event API for store tests.

---

## Definition of Done

- [ ] User can type a message and see a streamed response
- [ ] Streaming can be cancelled mid-response with the stop button or Escape
- [ ] Markdown renders correctly (headings, lists, code blocks with highlighting)
- [ ] Multiple conversations can be created and switched between
- [ ] Auto-scroll works correctly during streaming
- [ ] Error states display meaningful messages (server down, empty response)
- [ ] All unit tests pass
- [ ] No layout overflow or scroll jank
