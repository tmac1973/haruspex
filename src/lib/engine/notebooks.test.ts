import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
	settings: { leanMode: false, notebooksTab: true, notebooks: { semanticSearch: true } },
	changed: vi.fn(),
	api: {
		listNotebooks: vi.fn(async () => [{ id: 'nb1' }]),
		getNotebook: vi.fn(),
		getRows: vi.fn(),
		search: vi.fn(async () => []),
		createNotebook: vi.fn(async (title: string) => ({ id: 'nb9', title })),
		// notebookId, card, source, after: the source and place are checked by the tests.
		addCard: vi.fn(async (...args: [string, object, unknown, string | null]) => ({
			id: 'c1',
			notebook_id: args[0],
			...args[1]
		})),
		updateCard: vi.fn(async (id: string) => ({ id, notebook_id: 'nb1' })),
		applyRows: vi.fn(async (id: string) => ({ id, notebook_id: 'nb1' })),
		getCard: vi.fn(async (id: string) => ({ id, notebook_id: 'nb1' })),
		deleteCard: vi.fn(async () => {}),
		cardHistory: vi.fn(async () => []),
		rollbackCard: vi.fn(async (id: string) => ({ id, notebook_id: 'nb1' }))
	},
	chat: {
		getNotebookChat: vi.fn(),
		loadNotebookChat: vi.fn(async () => {}),
		sendNotebookChat: vi.fn(async () => {}),
		stopNotebookChat: vi.fn()
	}
}));

vi.mock('#lib/stores/settings.ts', () => ({ getSettings: () => m.settings }));
vi.mock('#lib/stores/notebooks.svelte.ts', () => ({ emitNotebookChanged: m.changed }));
vi.mock('#lib/notebooks/api.ts', () => m.api);
vi.mock('#lib/notebooks/notebookChat.svelte.ts', () => m.chat);

import { chatView, dispatchNotebooks, notebooksRefusal } from './notebooks.ts';
import type { NotebookOp } from '#lib/engine/types.ts';

const REMOTE = { kind: 'user', label: 'Remote control' };
const op = (o: Record<string, unknown>) => dispatchNotebooks(o as NotebookOp);

beforeEach(() => {
	m.settings.leanMode = false;
	m.settings.notebooksTab = true;
	m.changed.mockReset();
	for (const f of Object.values(m.api)) f.mockClear();
	for (const f of Object.values(m.chat)) f.mockClear();
});

describe('notebooksRefusal', () => {
	it('refuses in lean mode, and when the tab is off', () => {
		expect(notebooksRefusal()).toBeNull();
		m.settings.notebooksTab = false;
		expect(notebooksRefusal()).toBe('The Notebooks tab is off on this computer.');
		m.settings.leanMode = true;
		expect(notebooksRefusal()).toBe('Notebooks are off in lean mode.');
	});

	it('stops every operation before it reaches a notebook', async () => {
		m.settings.leanMode = true;
		await expect(op({ type: 'notebooks.list' })).rejects.toThrow('lean mode');
		expect(m.api.listNotebooks).not.toHaveBeenCalled();
	});
});

describe('dispatchNotebooks', () => {
	it('searches with the semantic setting', async () => {
		await op({ type: 'notebooks.search', query: 'flights' });
		expect(m.api.search).toHaveBeenCalledWith('flights', true);
	});

	it('announces a new notebook', async () => {
		expect(await op({ type: 'notebooks.create', title: 'Trip' })).toMatchObject({ id: 'nb9' });
		expect(m.changed).toHaveBeenCalledWith('nb9');
	});

	it('adds a table with two text columns and one empty row', async () => {
		await op({ type: 'notebooks.card.add', notebookId: 'nb1', kind: 'table', title: 'People' });
		const [, card, source, after] = m.api.addCard.mock.calls[0];
		expect(
			JSON.parse((card as { meta: string }).meta).columns.map((c: { id: string }) => c.id)
		).toEqual(['name', 'notes']);
		expect(card).toMatchObject({ kind: 'table', title: 'People', body: '', rows: ['{}'] });
		expect(source).toEqual(REMOTE);
		expect(after).toBeNull();
		expect(m.changed).toHaveBeenCalledWith('nb1', ['c1']);
	});

	it('adds a checklist with one unticked item, and a note with no rows', async () => {
		await op({ type: 'notebooks.card.add', notebookId: 'nb1', kind: 'checklist', after: 'c0' });
		expect(m.api.addCard.mock.calls[0][1]).toMatchObject({
			meta: '{}',
			rows: [JSON.stringify({ text: '', done: false })]
		});
		expect(m.api.addCard.mock.calls[0][3]).toBe('c0');
		await op({ type: 'notebooks.card.add', notebookId: 'nb1', kind: 'note', body: 'Hi' });
		expect(m.api.addCard.mock.calls[1][1]).toMatchObject({ meta: '{}', rows: null, body: 'Hi' });
	});

	it('stamps edits as from Remote control and announces them', async () => {
		await op({
			type: 'notebooks.card.update',
			cardId: 'c2',
			expectedVersion: 3,
			title: 'T',
			body: 'B'
		});
		expect(m.api.updateCard).toHaveBeenCalledWith('c2', 3, { title: 'T', body: 'B' }, REMOTE);
		expect(m.changed).toHaveBeenCalledWith('nb1', ['c2']);
	});

	it('announces a deleted card under its own notebook', async () => {
		m.api.getCard.mockResolvedValueOnce({ id: 'c5', notebook_id: 'nb7' });
		expect(await op({ type: 'notebooks.card.delete', cardId: 'c5' })).toEqual({ deleted: 'c5' });
		expect(m.api.deleteCard).toHaveBeenCalledWith('c5');
		expect(m.changed).toHaveBeenCalledWith('nb7', ['c5']);
	});

	it('starts a chat turn without waiting for it', async () => {
		let finish = () => {};
		m.chat.sendNotebookChat.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
		expect(await op({ type: 'notebooks.chat.send', notebookId: 'nb1', text: 'hi' })).toEqual({
			sent: true
		});
		expect(m.chat.sendNotebookChat).toHaveBeenCalledWith('nb1', 'hi');
		finish();
	});

	it('stops a chat turn', async () => {
		expect(await op({ type: 'notebooks.chat.stop', notebookId: 'nb1' })).toEqual({ stopped: true });
		expect(m.chat.stopNotebookChat).toHaveBeenCalledWith('nb1');
	});
});

describe('chatView', () => {
	it('loads the chat and gives its state as plain data', async () => {
		m.chat.getNotebookChat.mockReturnValue({
			messages: [{ role: 'user', content: 'hi', extra: 1 }],
			busy: true,
			streaming: 'He',
			step: 'Read notebook Trip',
			error: null,
			abort: new AbortController()
		});
		expect(await chatView('nb1')).toEqual({
			messages: [{ role: 'user', content: 'hi' }],
			busy: true,
			streaming: 'He',
			step: 'Read notebook Trip',
			error: null
		});
		expect(m.chat.loadNotebookChat).toHaveBeenCalledWith('nb1');
	});
});
