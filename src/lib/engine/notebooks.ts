/**
 * Notebooks for a client (Settings → Remote control's web page, and paired
 * computers): the `notebooks.*` operations over the same commands the
 * Notebooks tab uses. Changes made this way are stamped "Edited from Remote
 * control" on the card. Answered by the main window.
 */
import * as api from '#lib/notebooks/api.ts';
import type { NotebookSource } from '#lib/notebooks/api.ts';
import type { NotebookChatView, NotebookOp } from '#lib/engine/types.ts';
import { emitNotebookChanged } from '#lib/stores/notebooks.svelte.ts';
import {
	getNotebookChat,
	loadNotebookChat,
	sendNotebookChat,
	stopNotebookChat
} from '#lib/notebooks/notebookChat.svelte.ts';
import { getSettings } from '#lib/stores/settings.ts';

const REMOTE: NotebookSource = { kind: 'user', label: 'Remote control' };

/** Why notebooks can't be reached, or null when they can. */
export function notebooksRefusal(): string | null {
	const s = getSettings();
	if (s.leanMode) return 'Notebooks are off in lean mode.';
	if (!s.notebooksTab) return 'The Notebooks tab is off on this computer.';
	return null;
}

async function changed<T extends { notebook_id: string; id: string }>(card: T): Promise<T> {
	emitNotebookChanged(card.notebook_id, [card.id]);
	return card;
}

export async function chatView(notebookId: string): Promise<NotebookChatView> {
	await loadNotebookChat(notebookId);
	const c = getNotebookChat(notebookId);
	return {
		messages: c.messages.map((m) => ({ role: m.role, content: m.content })),
		busy: c.busy,
		streaming: c.streaming,
		step: c.step,
		error: c.error
	};
}

export async function dispatchNotebooks(op: NotebookOp): Promise<unknown> {
	const refusal = notebooksRefusal();
	if (refusal) throw new Error(refusal);
	switch (op.type) {
		case 'notebooks.list':
			return api.listNotebooks();
		case 'notebooks.get':
			return api.getNotebook(op.notebookId);
		case 'notebooks.rows':
			return api.getRows(op.cardId, op.offset, op.limit);
		case 'notebooks.search':
			return api.search(op.query, getSettings().notebooks.semanticSearch);
		case 'notebooks.create': {
			const nb = await api.createNotebook(op.title);
			emitNotebookChanged(nb.id);
			return nb;
		}
		case 'notebooks.card.add': {
			const blank =
				op.kind === 'table'
					? {
							meta: JSON.stringify({
								columns: [
									{ id: 'name', name: 'Name', type: 'text' },
									{ id: 'notes', name: 'Notes', type: 'text' }
								]
							}),
							rows: ['{}']
						}
					: op.kind === 'checklist'
						? { meta: '{}', rows: [JSON.stringify({ text: '', done: false })] }
						: { meta: '{}', rows: null };
			const card = await api.addCard(
				op.notebookId,
				{ kind: op.kind, title: op.title ?? '', body: op.body ?? '', ...blank },
				REMOTE,
				op.after ?? null
			);
			return changed(card);
		}
		case 'notebooks.card.update':
			return changed(
				await api.updateCard(
					op.cardId,
					op.expectedVersion,
					{ title: op.title, body: op.body },
					REMOTE
				)
			);
		case 'notebooks.rows.apply':
			return changed(await api.applyRows(op.cardId, op.expectedVersion, op.ops, REMOTE));
		case 'notebooks.card.delete': {
			const card = await api.getCard(op.cardId);
			await api.deleteCard(op.cardId);
			emitNotebookChanged(card.notebook_id, [card.id]);
			return { deleted: op.cardId };
		}
		case 'notebooks.card.history':
			return api.cardHistory(op.cardId);
		case 'notebooks.card.rollback':
			return changed(await api.rollbackCard(op.cardId, op.revisionId, REMOTE));
		case 'notebooks.chat.get':
			return chatView(op.notebookId);
		case 'notebooks.chat.send':
			// The turn runs on; the client follows it through `notebook-chat` events.
			void sendNotebookChat(op.notebookId, op.text);
			return { sent: true };
		case 'notebooks.chat.stop':
			stopNotebookChat(op.notebookId);
			return { stopped: true };
	}
}
