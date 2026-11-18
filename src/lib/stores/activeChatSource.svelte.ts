/**
 * Which conversations the Chat view shows: this computer's (the chat store's
 * active one), or a chat on another computer (plan/instance-sync/). Showing
 * another's leaves the local active conversation as it was, so going back
 * resumes it.
 */
import type { ChatSource } from '#lib/chat/source.ts';
import { localChatSource } from '#lib/stores/chat.svelte.ts';

let active = $state.raw<ChatSource>(localChatSource);

export function getActiveChatSource(): ChatSource {
	return active;
}

/** Another computer's chat is on screen. */
export function showChatSource(source: ChatSource): void {
	active = source;
}

/** Back to this computer's conversations. */
export function showLocalChat(): void {
	active = localChatSource;
}
