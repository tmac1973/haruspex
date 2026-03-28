# Phase 7: Settings, Persistence & UI Polish

## Goal

Add persistent user settings, the advanced configuration panel, conversation persistence across app restarts, and UI polish. After this phase, Haruspex feels like a finished application rather than a prototype.

## Prerequisites

- Phase 6 complete (full chat + search flow works)

## Deliverables

- **User-testable**: Conversations survive app restarts. Settings panel allows changing model, context length, temperature, search provider. Advanced users can view llama-server logs. UI has a cohesive visual design with light/dark theme support.

NOTE: This phase uses "Haruspex" for all user-facing branding (window title, about page, etc.).

---

## Tasks

### 7.1 Settings persistence (`src/lib/stores/settings.ts`)

Persist settings to a JSON file in Tauri's app data directory:

```typescript
interface AppSettings {
  // General
  theme: 'light' | 'dark' | 'system';

  // Model
  activeModel: string;            // model ID
  contextLength: number;          // 2048 – 32768, default 16384
  temperature: number;            // 0.0 – 2.0, default 0.7
  topP: number;                   // 0.0 – 1.0, default 0.9
  maxTokens: number;              // max response length

  // Server
  serverPort: number;             // default 8765
  gpuLayers: number;              // -1 = auto (99), 0 = CPU only
  flashAttention: boolean;        // default true

  // Search
  searchProvider: 'duckduckgo' | 'tavily';
  tavilyApiKey?: string;

  // UI
  sidebarCollapsed: boolean;
  fontSize: 'small' | 'medium' | 'large';
}
```

**Implementation:**

- Use Tauri's `app_data_dir()` / `Store` plugin, or a simple JSON file with `fs` plugin.
- Load on app start; write on change (debounced, 500ms).
- Merge saved settings with defaults (forward-compatible with new settings added in future versions).
- Export reactive Svelte 5 runes-based store.

### 7.2 Conversation persistence (SQLite)

Persist conversations and messages to a SQLite database at `appDataDir/haruspex.db`. Use the `tauri-plugin-sql` plugin (SQLite variant) or `rusqlite` on the Rust side with Tauri commands.

**Schema:**

```sql
CREATE TABLE conversations (
    id TEXT PRIMARY KEY,           -- UUID
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,   -- Unix timestamp ms
    updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,             -- 'system', 'user', 'assistant', 'tool'
    content TEXT NOT NULL,
    tool_calls TEXT,                -- JSON array, nullable
    tool_call_id TEXT,             -- for tool-result messages
    created_at INTEGER NOT NULL,
    sort_order INTEGER NOT NULL    -- preserves message ordering
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, sort_order);
```

**Tauri commands:**

```rust
#[tauri::command]
fn list_conversations() -> Vec<ConversationSummary>;  // id, title, updated_at

#[tauri::command]
fn get_conversation(id: String) -> Conversation;      // with all messages

#[tauri::command]
fn create_conversation(title: String) -> String;      // returns id

#[tauri::command]
fn save_message(conversation_id: String, message: Message) -> Result<(), String>;

#[tauri::command]
fn rename_conversation(id: String, title: String) -> Result<(), String>;

#[tauri::command]
fn delete_conversation(id: String) -> Result<(), String>;

#[tauri::command]
fn clear_all_conversations() -> Result<(), String>;
```

**Implementation details:**

- Initialize DB and run migrations on app startup (create tables if not exist).
- Messages are written immediately on send/receive (no debounce needed — SQLite handles this fine).
- Conversation list loads summaries only; full messages loaded lazily on selection.
- Conversation title: auto-generate from first user message (truncated to 50 chars). Allow user rename.
- `PRAGMA journal_mode=WAL` for concurrent read/write performance.
- `PRAGMA foreign_keys=ON` so cascade deletes work.

### 7.3 Settings page (`src/routes/settings/+page.svelte`)

Organize into sections:

**General:**
- Theme toggle (light / dark / system)
- Font size selector

**Model:**
- Active model dropdown (shows downloaded models)
- Download additional models button → links to model selection UI
- Delete model button (with confirmation)
- Context length slider (2048 – 32768)
- Temperature slider (0.0 – 2.0) with presets: Precise (0.3), Balanced (0.7), Creative (1.2)
- Top-P slider (0.0 – 1.0)

**Search:**
- Provider selector (DuckDuckGo / Tavily)
- Tavily API key input (masked, with test button)

**Advanced** (collapsed by default):
- GPU layers override (-1 = auto, 0 = CPU, custom number)
- Flash attention toggle
- Server port
- llama-server log viewer

**About:**
- Version number
- Links: GitHub repo, license, acknowledgments

### 7.4 Log viewer component

Tail llama-server's stdout/stderr output:

- Ring buffer in Rust (keep last 1000 lines).
- Tauri command `get_server_logs() -> Vec<String>`.
- Frontend polls every 2 seconds when the log viewer is open.
- Auto-scroll, monospace font, copy-all button.
- Filter by log level if parseable.

### 7.5 Theme system

- CSS custom properties for all colors.
- Light and dark themes.
- System theme detection via `prefers-color-scheme` media query.
- Theme class on `<html>` element, toggled by settings.
- Smooth transitions on theme change.

Design tokens:

```css
:root {
  --bg-primary: ...;
  --bg-secondary: ...;
  --bg-chat: ...;
  --text-primary: ...;
  --text-secondary: ...;
  --accent: ...;
  --border: ...;
  --code-bg: ...;
  --user-bubble: ...;
  --assistant-bubble: ...;
}
```

### 7.6 UI polish

- **Typography**: Clean sans-serif for UI, monospace for code. Comfortable line heights.
- **Animations**: Subtle transitions on message appear, sidebar toggle, settings panels.
- **Responsive sidebar**: Collapsible with hamburger toggle. Remembers state.
- **Empty state**: When no conversations exist, show a welcome message with suggested prompts.
- **Loading states**: Skeleton loaders where appropriate.
- **Keyboard navigation**: Tab order, focus styles, arrow keys in sidebar.
- **Accessibility**: ARIA labels, semantic HTML, sufficient color contrast in both themes.

### 7.7 Server restart on settings change

When the user changes model-related settings (active model, context length, GPU layers):

1. Show confirmation: "Changing this setting requires restarting the AI model. Continue?"
2. Stop current llama-server instance.
3. Start new instance with updated configuration.
4. Show status indicator during restart.

### 7.8 Conversation management UI

- Rename conversation (double-click title in sidebar, or context menu).
- Delete conversation (context menu or swipe on mobile).
- "Clear all conversations" in settings (with confirmation dialog).
- Search/filter conversations in sidebar.

---

## Test Coverage

| Area | What to test | Tool |
|---|---|---|
| Settings store | Loads defaults when no file exists | Vitest |
| Settings store | Merges saved settings with defaults (forward-compat) | Vitest |
| Settings store | Debounced save writes to file | Vitest |
| Settings store | Invalid saved JSON falls back to defaults | Vitest |
| SQLite DB | Schema migrations run on fresh DB | cargo test |
| SQLite DB | Save and load conversation round-trip | cargo test |
| SQLite DB | Cascade delete removes messages when conversation deleted | cargo test |
| SQLite DB | `list_conversations` returns ordered summaries | cargo test |
| SQLite DB | `save_message` appends with correct sort_order | cargo test |
| SQLite DB | Handles concurrent reads/writes (WAL mode) | cargo test |
| Theme | System theme detection applies correct class | Vitest + testing-library |
| Theme | Manual theme override persists and applies | Vitest + testing-library |
| Settings page | All controls render and are interactive | Vitest + testing-library |
| Settings page | Changing model triggers restart confirmation | Vitest + testing-library |
| Log viewer | Renders log lines and auto-scrolls | Vitest + testing-library |
| Sidebar | Collapse/expand persists across sessions | Vitest + testing-library |
| Conversation mgmt | Rename updates title in sidebar and index | Vitest + testing-library |
| Conversation mgmt | Delete removes from sidebar and disk | Vitest + testing-library |

---

## Definition of Done

- [ ] Settings page accessible from sidebar or header menu
- [ ] All settings persist across app restarts
- [ ] Conversations persist across app restarts (SQLite database in app data dir)
- [ ] Theme switching works (light / dark / system) with smooth transitions
- [ ] Changing the active model restarts llama-server correctly
- [ ] Log viewer shows llama-server output in real-time
- [ ] Conversations can be renamed and deleted
- [ ] Empty state shows suggested prompts
- [ ] Font size setting changes the chat font size
- [ ] Tavily API key can be entered and tested
- [ ] UI is keyboard-navigable with visible focus indicators
- [ ] All unit tests pass
