/**
 * Notebook events for a client: `notebook-changed` whenever a notebook
 * changes anywhere in the app (the tab, an agent, a client), and
 * `notebook-chat` while a notebook's chat moves on (a message, a step, the
 * answer streaming). Main window only.
 */
import { onNotebookChanged } from '#lib/stores/notebooks.svelte.ts';
import { getNotebookChat } from '#lib/notebooks/notebookChat.svelte.ts';
import type { NotebookEvent } from '#lib/engine/types.ts';

export function watchNotebooks(
	sink: (e: NotebookEvent) => void,
	/** Which notebooks' chats to follow (those clients have open). */
	followed: () => string[] = () => []
): { stop: () => void } {
	let seq = 0;
	const off = onNotebookChanged((notebookId) => {
		sink({ type: 'notebook-changed', seq: ++seq, notebookId });
	});
	// Bookkeeping, never rendered.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const last = new Map<string, string>();
	const stopFx = $effect.root(() => {
		$effect(() => {
			for (const id of followed()) {
				const c = getNotebookChat(id);
				const sig = `${c.messages.length}|${c.busy}|${c.streaming.length}|${c.step}|${c.error}`;
				if (last.get(id) === sig) continue;
				const first = !last.has(id);
				last.set(id, sig);
				if (!first) sink({ type: 'notebook-chat', seq: ++seq, notebookId: id });
			}
		});
	});
	return {
		stop: () => {
			off();
			stopFx();
		}
	};
}
