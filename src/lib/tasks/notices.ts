/**
 * When a background task ends, the Chat conversation or Code session that
 * started it gets a follow-up turn saying how it went.
 *
 * The notice waits in the registry (Rust) until its owner takes it, so it
 * survives a reload and a restart. Each owner registers a handler; when one
 * of its tasks ends the handler is told, and the owner calls `takeNotices`
 * once it is idle. Chat conversations live only in the main window, so only
 * the Chat store there registers the `chat:*` handler. A Code session that
 * isn't loaded has no handler: its notices wait until it is opened.
 *
 * Deliberately free of store imports, like `#lib/shell/backgroundWatch.ts`,
 * so the stores can import it.
 */
import { invoke } from '@tauri-apps/api/core';
import { joinNotices } from '#lib/tasks/noticeText.ts';
import type { BackgroundTask } from '#lib/tasks/types.ts';

/** Told an owner's task ended; the task comes too, for what to call it. */
type Handler = (owner: string, task?: BackgroundTask) => void;

const handlers = new Map<string, Handler>();

/** The owner string a tool records for its turn: its Code session, or its chat. */
export function taskOwner(ctx: { conversationId?: string; codeSessionId?: string }): string {
	if (ctx.codeSessionId) return `code:${ctx.codeSessionId}`;
	if (ctx.conversationId) return `chat:${ctx.conversationId}`;
	return '';
}

/** A handler for an owner's notices; returns its unregister. */
export function setTaskHandler(owner: string, fn: Handler): () => void {
	handlers.set(owner, fn);
	return () => {
		if (handlers.get(owner) === fn) handlers.delete(owner);
	};
}

/** Every chat owner (`chat:…`) is handled by the one Chat store. */
export function setChatTaskHandler(fn: Handler): () => void {
	return setTaskHandler('chat:*', fn);
}

/** A task ended: tell its owner, if it is here to hear. */
export function noteEnded(t: BackgroundTask): void {
	if (!t.owner || t.noticeDelivered) return;
	const handler =
		handlers.get(t.owner) ?? (t.owner.startsWith('chat:') ? handlers.get('chat:*') : undefined);
	handler?.(t.owner, t);
}

/**
 * Take the owner's waiting notices, as one turn's message. Empty text when
 * there are none (another window, or an earlier take, had them).
 */
export async function takeNotices(owner: string): Promise<{ text: string; images: string[] }> {
	const tasks = await invoke<BackgroundTask[] | null>('task_take_notices', { owner }).catch(
		() => null
	);
	return joinNotices(Array.isArray(tasks) ? tasks : []);
}

export function _resetForTests(): void {
	handlers.clear();
}
