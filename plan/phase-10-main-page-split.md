# Phase 10 — `routes/+page.svelte` split

**Severity addressed:** 7 · **Effort:** ~4 hours · **Risk:** Low

Resolves complexity-audit C-10 (1 041-line main chat page; 295 script + 499 style).

## Goal

Extract two components and one Svelte action from the main chat page. The route becomes a thin shell that wires them together.

## Files touched

- **EDIT** `src/routes/+page.svelte`
- **NEW** `src/lib/components/ConversationSidebar.svelte`
- **NEW** `src/lib/components/MessageScrollHost.svelte`
- **NEW** `src/lib/actions/keyboardShortcuts.ts`

## Implementation

### Step 1 — `keyboardShortcuts` Svelte action

```ts
// src/lib/actions/keyboardShortcuts.ts
type Combo = string;     // e.g. 'cmd+k', 'ctrl+enter', 'esc'
type Handler = (e: KeyboardEvent) => void;

function matchCombo(e: KeyboardEvent, combo: Combo): boolean {
	const parts = combo.toLowerCase().split('+');
	const key = parts.pop()!;
	const needCmd = parts.includes('cmd') || parts.includes('meta');
	const needCtrl = parts.includes('ctrl');
	const needShift = parts.includes('shift');
	const needAlt = parts.includes('alt');
	if (needCmd  && !(e.metaKey || e.ctrlKey)) return false;
	if (needCtrl && !e.ctrlKey) return false;
	if (needShift && !e.shiftKey) return false;
	if (needAlt && !e.altKey) return false;
	return e.key.toLowerCase() === key;
}

export function shortcuts(node: HTMLElement, map: Record<Combo, Handler>) {
	function onKeydown(e: KeyboardEvent) {
		for (const [combo, handler] of Object.entries(map)) {
			if (matchCombo(e, combo)) {
				e.preventDefault();
				handler(e);
				return;
			}
		}
	}
	node.addEventListener('keydown', onKeydown);
	return {
		destroy() { node.removeEventListener('keydown', onKeydown); },
		update(next: Record<Combo, Handler>) { map = next; }
	};
}
```

Use:

```svelte
<svelte:window use:shortcuts={{
    'cmd+k':     () => focusComposer(),
    'cmd+enter': () => handleSend(),
    'esc':       () => cancelGeneration()
}} />
```

Note: Svelte 5 actions on `<svelte:window>` aren't supported directly — attach to a focusable wrapper `<div use:shortcuts={…} tabindex="-1">` or use `onMount` to add the listener manually. Pick whichever shape your existing keyboard handling already uses.

### Step 2 — `ConversationSidebar.svelte`

Pulls in:
- Current conversation list rendering (whatever the existing markup is)
- Rename inline editor (lines 45–67 of `+page.svelte`: `startRename`, `finishRename`, `handleRenameKeydown`)
- Click-to-activate
- Delete button per conversation

Receives nothing as props; reads from the chat store directly. Emits no events — calls store functions (`setActiveConversation`, `renameConversation`, `deleteConversation`) directly.

### Step 3 — `MessageScrollHost.svelte`

Owns:
- The scrollable message list element
- The `scrollToBottom` / `handleScroll` / `handleScrollToBottom` behaviour (currently lines 130–148)
- The "stuck-to-bottom" state
- The "scroll to bottom" floating button

Renders messages via a `{#each}` over the active conversation's messages, delegating to `<ChatMessage>` for each. Props: none needed if it reads from the store; alternatively pass `messages: ChatMessage[]` for testability.

### Step 4 — slim `+page.svelte`

```svelte
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import ConversationSidebar from '$lib/components/ConversationSidebar.svelte';
	import MessageScrollHost from '$lib/components/MessageScrollHost.svelte';
	import { shortcuts } from '$lib/actions/keyboardShortcuts';
	import { sendMessage, cancelGeneration } from '$lib/stores/chat.svelte';
	// … remaining imports
</script>

<svelte:head><title>Haruspex</title></svelte:head>

<div class="app-root" use:shortcuts={{
    'cmd+k':     focusComposer,
    'cmd+enter': handleSend,
    'esc':       cancelGeneration
}}>
	<ConversationSidebar />
	<main>
		<header><!-- model name, server badge, working dir button --></header>
		<MessageScrollHost />
		<Composer onsend={handleSend} bind:value={inputText} />
		<FileConflictModal />
		<SandboxApprovalModal />
		<GpuWarningDialog />
	</main>
</div>
```

Page-level script keeps only what's truly page-scoped: `handleSend`, `handleKeydown`, the CPU-fallback dismissal, the GPU-restart action, drag-and-drop wiring.

## Build gate

```bash
npm run check
npm run lint
npm run build
```

## Test plan

### Smoke

1. App launches. Main chat view renders. Sidebar shows existing conversations.

### Targeted — sidebar

2. **Create:** click "New chat". A new conversation appears at the top of the sidebar; the main pane is empty.
3. **Activate:** click an existing conversation. Its messages appear in the main pane.
4. **Rename:** double-click (or whatever the rename gesture was) a sidebar entry. Inline editor appears. Type a new title. Press Enter. Title persists across app restart.
5. **Rename cancel:** start rename, press Escape. Title reverts.
6. **Delete:** click the delete button on a conversation. It disappears from the sidebar.

### Targeted — scroll host

7. **Send a long message** (one that takes multiple screens to render). The view should auto-scroll to the bottom as content streams in.
8. **Scroll up** while a generation is in flight. The auto-scroll should pause (sticky-to-bottom flag flips off).
9. **"Scroll to bottom" button:** the floating button should appear when not at the bottom. Click it; view scrolls and the button hides.
10. **New conversation:** switching conversations should snap the scroll to the bottom of the new one.

### Targeted — keyboard shortcuts

11. **Cmd+K** (or Ctrl+K on Linux): focuses the composer.
12. **Cmd+Enter** in the composer: triggers send.
13. **Esc** during generation: cancels.

### Targeted — modals still mount

14. Trigger a file conflict (write the same file twice with a workdir set). The modal still appears and works (Phase 03 path).
15. Trigger a sandbox approval (run a Python snippet with sandbox enabled). Modal works.

If 2–15 pass, commit:

```
refactor: split routes/+page.svelte into sidebar + scroll host + shortcuts (#TBD)

1041-line page split into ConversationSidebar, MessageScrollHost,
and a reusable keyboardShortcuts action. The route is now a thin
orchestrator that wires the stores to the components.

Resolves audits/code-complexity-2026-05-14.md C-10.
```
