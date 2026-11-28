import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotebookDetail } from '#lib/ipc/gen/NotebookDetail.ts';
import type { ChatMessage } from '#lib/api.ts';

const m = vi.hoisted(() => ({
	stored: new Map<string, unknown[]>(),
	turn: vi.fn(),
	prepare: vi.fn(),
	changed: vi.fn(),
	detail: null as unknown
}));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({
		notebook_conversation: (a) => `notebook-${String(a?.notebookId)}`
	})
);
vi.mock('#lib/stores/db.ts', () => ({
	dbLoadMessages: vi.fn(async (id: string) => [...(m.stored.get(id) ?? [])]),
	dbSaveMessage: vi.fn(async (id: string, msg: unknown) => {
		m.stored.set(id, [...(m.stored.get(id) ?? []), msg]);
	}),
	dbReplaceMessages: vi.fn(async (id: string, msgs: unknown[]) => {
		m.stored.set(id, [...msgs]);
	})
}));
vi.mock('#lib/notebooks/api.ts', () => ({ getNotebook: vi.fn(async () => m.detail) }));
vi.mock('#lib/stores/notebooks.svelte.ts', () => ({ emitNotebookChanged: m.changed }));
vi.mock('#lib/agent/runEphemeralTurn.ts', () => ({ runEphemeralTurn: m.turn }));
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	withInferenceSlot: (_opts: unknown, fn: (slot: unknown) => Promise<unknown>) => fn({})
}));
vi.mock('#lib/remote/conversation.ts', () => ({ prepareHistory: m.prepare }));
vi.mock('#lib/inference/descriptor.ts', () => ({
	resolveBackendDescriptor: () => ({ contextSize: 32768, calibrationKey: 'k' })
}));
vi.mock('#lib/agent/tools/_notebookFormat.ts', () => ({
	cardOutline: (c: { title: string }) => `- ${c.title}`
}));
vi.mock('#lib/stores/settings.ts', () => ({
	getSettings: () => ({ notebooks: {} }),
	notebookChatMaxIterations: () => 10
}));

import {
	clearNotebookChat,
	getNotebookChat,
	notebookContext,
	sendNotebookChat,
	stopNotebookChat,
	visibleMessages
} from './notebookChat.svelte.ts';

function detail(titles: string[], title = 'Trip'): NotebookDetail {
	return {
		notebook: { id: 'nb', title },
		cards: titles.map((t) => ({ title: t }))
	} as unknown as NotebookDetail;
}

/** A fresh notebook id per test: the chats are module state. */
let n = 0;
const nextId = () => `nb${++n}`;

beforeEach(() => {
	m.stored.clear();
	m.turn.mockReset();
	m.turn.mockResolvedValue({ finalText: 'Done.' });
	m.prepare.mockReset();
	m.prepare.mockImplementation(async (history: ChatMessage[]) => ({
		messages: history,
		rewritten: false
	}));
	m.changed.mockReset();
	m.detail = detail(['Flights']);
});

describe('visibleMessages', () => {
	it('keeps the user and assistant turns that say something', () => {
		const out = visibleMessages([
			{ role: 'system', content: 'rules' },
			{ role: 'user', content: 'Plan day one' },
			{ role: 'assistant', content: '   ' },
			{ role: 'tool', content: '{"ok":true}' },
			{ role: 'assistant', content: [{ type: 'text', text: 'parts' }] },
			{ role: 'assistant', content: 'Here it is.' }
		] as ChatMessage[]);
		expect(out).toEqual([
			{ role: 'user', content: 'Plan day one' },
			{ role: 'assistant', content: 'Here it is.' }
		]);
	});
});

describe('notebookContext', () => {
	it('names the notebook and lists its cards', () => {
		const text = notebookContext(detail(['Flights', 'Hotels'], 'Japan'));
		expect(text).toContain('"Japan" (id nb)');
		expect(text).toContain('- Flights\n\n- Hotels');
	});

	it('says when there are no cards', () => {
		expect(notebookContext(detail([]))).toContain('(no cards yet)');
	});

	it('cuts a long outline and points at notebook_read', () => {
		const text = notebookContext(detail(Array.from({ length: 400 }, (_, i) => `Card ${i}`)));
		expect(text).toContain('…(more: use notebook_read)');
		expect(text).not.toContain('Card 399');
	});
});

describe('sendNotebookChat', () => {
	it('loads the chat, runs the turn and keeps both sides', async () => {
		const id = nextId();
		await sendNotebookChat(id, 'What is booked?');
		const conv = `notebook-${id}`;
		expect(m.stored.get(conv)).toEqual([
			{ role: 'user', content: 'What is booked?' },
			{ role: 'assistant', content: 'Done.' }
		]);
		const chat = getNotebookChat(id);
		expect(chat.messages.map((x) => x.content)).toEqual(['What is booked?', 'Done.']);
		expect(chat.busy).toBe(false);
		expect(m.turn.mock.calls[0][0]).toMatchObject({
			userMessage: 'What is booked?',
			conversationId: conv,
			keepFamilies: ['notebooks'],
			notebookChat: { notebookId: id, title: 'Trip' }
		});
		expect(m.changed).toHaveBeenCalledWith(id);
	});

	it('ignores a blank message', async () => {
		await sendNotebookChat(nextId(), '   ');
		expect(m.turn).not.toHaveBeenCalled();
	});

	it('ignores a second message while a turn runs', async () => {
		const id = nextId();
		let finish: (v: unknown) => void = () => {};
		m.turn.mockImplementationOnce(() => new Promise((r) => (finish = r)));
		const first = sendNotebookChat(id, 'one');
		await vi.waitFor(() => expect(m.turn).toHaveBeenCalledTimes(1));
		await sendNotebookChat(id, 'two');
		finish({ finalText: 'ok' });
		await first;
		expect(m.turn).toHaveBeenCalledTimes(1);
		expect(getNotebookChat(id).messages.map((x) => x.content)).toEqual(['one', 'ok']);
	});

	it('saves the history the turn compacted', async () => {
		const id = nextId();
		m.stored.set(`notebook-${id}`, [{ role: 'user', content: 'old' }]);
		m.prepare.mockResolvedValueOnce({
			messages: [{ role: 'system', content: 'summary' }],
			rewritten: true
		});
		await sendNotebookChat(id, 'new');
		expect(m.stored.get(`notebook-${id}`)?.slice(0, 2)).toEqual([
			{ role: 'system', content: 'summary' },
			{ role: 'user', content: 'new' }
		]);
	});

	it('keeps the partial answer of a stopped turn, with no error', async () => {
		const id = nextId();
		m.turn.mockImplementationOnce(async (opts: { onAssistantDelta: (s: string) => void }) => {
			opts.onAssistantDelta('Half an ans');
			stopNotebookChat(id);
			throw new DOMException('Aborted', 'AbortError');
		});
		await sendNotebookChat(id, 'go');
		const chat = getNotebookChat(id);
		expect(chat.messages.at(-1)).toEqual({ role: 'assistant', content: 'Half an ans' });
		expect(chat.error).toBeNull();
		expect(chat.streaming).toBe('');
	});

	it('says why a turn failed', async () => {
		const id = nextId();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		m.turn.mockRejectedValueOnce(new Error('server went away'));
		await sendNotebookChat(id, 'go');
		expect(getNotebookChat(id).error).toBe('server went away');
		expect(getNotebookChat(id).busy).toBe(false);
		warn.mockRestore();
	});
});

describe('clearNotebookChat', () => {
	it('empties the conversation', async () => {
		const id = nextId();
		await sendNotebookChat(id, 'hello');
		await clearNotebookChat(id);
		expect(m.stored.get(`notebook-${id}`)).toEqual([]);
		expect(getNotebookChat(id).messages).toEqual([]);
	});
});
