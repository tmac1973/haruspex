/**
 * "Open in shell": create a shell session seeded with a chat conversation and
 * switch to it. See `chatHandoff.ts` for what happens to the thread on the
 * way over.
 *
 * Only the frontend session is created here — the PTY spawns when the pane's
 * Terminal mounts, which for a first-ever shell means after `+page.svelte`
 * lazily mounts ShellWorkspace on the tab switch below. `ensureShellSession`
 * in the workspace finds this session already active and doesn't add a second.
 */

import type { ChatMessage } from '$lib/api';
import { setActiveTab } from '$lib/stores/activeTab.svelte';
import { createShellSession, type ShellSession } from '$lib/stores/shell.svelte';
import { prepareChatHandoff, shellNameForConversation } from '$lib/shell/chatHandoff';

export interface ChatHandoffSource {
	title?: string;
	messages: ChatMessage[];
}

/**
 * Open a new shell tab carrying `conversation`'s thread. Always opens a shell,
 * even when the conversation has nothing to carry (an empty chat still wants a
 * terminal); it just arrives without a seeded thread.
 */
export function openShellFromChat(conversation: ChatHandoffSource): ShellSession {
	const session = createShellSession();
	const name = shellNameForConversation(conversation.title);
	if (name) session.name = name;
	const thread = prepareChatHandoff(conversation.messages);
	if (thread.length > 0) session.adoptChatThread(thread);
	else session.sidebarOpen = true;
	setActiveTab('shell');
	return session;
}
