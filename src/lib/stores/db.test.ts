import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	logDebug: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: mocks.invoke
}));

vi.mock('$lib/debug-log', () => ({
	logDebug: mocks.logDebug
}));

const MM_PREFIX = '\x00MM\x00';

// `available` is module-level state set by initDb — re-import fresh per
// test so the available/unavailable paths don't bleed into each other.
async function freshDb() {
	return import('$lib/stores/db');
}

/** Import the module and run a successful initDb so `available` is true. */
async function availableDb(summaries: unknown[] = []) {
	const db = await freshDb();
	mocks.invoke.mockResolvedValueOnce(summaries);
	await db.initDb();
	mocks.invoke.mockClear();
	return db;
}

beforeEach(() => {
	vi.resetModules();
	mocks.invoke.mockReset();
	mocks.logDebug.mockReset();
});

describe('initDb', () => {
	it('marks the store available and returns summaries on success', async () => {
		const db = await freshDb();
		expect(db.isDbAvailable()).toBe(false);

		const summaries = [{ id: 'c1', title: 'Chat', created_at: 1, updated_at: 2 }];
		mocks.invoke.mockResolvedValueOnce(summaries);

		const result = await db.initDb();

		expect(mocks.invoke).toHaveBeenCalledWith('db_list_conversations');
		expect(result).toEqual({ available: true, summaries });
		expect(db.isDbAvailable()).toBe(true);
	});

	it('falls back to unavailable (with a debug log) when the backend fails', async () => {
		const db = await freshDb();
		mocks.invoke.mockRejectedValueOnce(new Error('schema mismatch'));

		const result = await db.initDb();

		expect(result).toEqual({ available: false, summaries: [] });
		expect(db.isDbAvailable()).toBe(false);
		expect(mocks.logDebug).toHaveBeenCalledWith(
			'db',
			'initDb failed',
			expect.objectContaining({ error: expect.stringContaining('schema mismatch') })
		);
	});
});

describe('no-op behavior when the store is unavailable', () => {
	it('every writer returns without touching invoke', async () => {
		const db = await freshDb();

		await db.dbSaveMessage('c1', { role: 'user', content: 'hi' });
		await db.dbUpdateLastMessageSteps('c1', '[]');
		await db.dbCreateConversation('c1', 'Title');
		await db.dbRenameConversation('c1', 'Renamed');
		await db.dbDeleteConversation('c1');
		await db.dbClearAll();
		await db.dbReplaceMessages('c1', [{ role: 'user', content: 'hi' }]);

		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('readers return empty values without touching invoke', async () => {
		const db = await freshDb();

		expect(await db.dbLoadMessages('c1')).toEqual([]);
		expect(await db.dbLoadMessageSteps('c1')).toEqual({});
		expect(mocks.invoke).not.toHaveBeenCalled();
	});
});

describe('dbSaveMessage', () => {
	it('maps the message onto the invoke payload', async () => {
		const db = await availableDb();
		mocks.invoke.mockResolvedValueOnce(undefined);

		const toolCalls = [
			{ id: '1', type: 'function' as const, function: { name: 'web_search', arguments: '{}' } }
		];
		await db.dbSaveMessage(
			'c1',
			{ role: 'assistant', content: 'hi', tool_calls: toolCalls },
			'[{"toolName":"web_search"}]'
		);

		expect(mocks.invoke).toHaveBeenCalledWith('db_save_message', {
			conversationId: 'c1',
			role: 'assistant',
			content: 'hi',
			toolCalls: JSON.stringify(toolCalls),
			toolCallId: null,
			steps: '[{"toolName":"web_search"}]'
		});
	});

	it('defaults steps to null and serializes multimodal content with the marker prefix', async () => {
		const db = await availableDb();
		mocks.invoke.mockResolvedValueOnce(undefined);

		const content = [{ type: 'text' as const, text: 'look at this' }];
		await db.dbSaveMessage('c1', { role: 'user', content });

		const payload = mocks.invoke.mock.calls[0][1] as { content: string; steps: string | null };
		expect(payload.steps).toBeNull();
		expect(payload.content).toBe(MM_PREFIX + JSON.stringify(content));
	});

	it('swallows an invoke rejection with a debug log instead of throwing', async () => {
		const db = await availableDb();
		mocks.invoke.mockRejectedValueOnce(new Error('disk full'));

		await expect(db.dbSaveMessage('c1', { role: 'user', content: 'hi' })).resolves.toBeUndefined();
		expect(mocks.logDebug).toHaveBeenCalledWith(
			'db',
			'dbSaveMessage failed',
			expect.objectContaining({ conversationId: 'c1' })
		);
	});
});

describe('dbReplaceMessages', () => {
	it('sends per-index steps JSON when given a stepsByIndex map and null otherwise', async () => {
		const db = await availableDb();
		mocks.invoke.mockResolvedValueOnce(undefined);

		const steps = [{ toolName: 'run_python', status: 'done' }];
		await db.dbReplaceMessages(
			'c1',
			[
				{ role: 'user', content: 'run it' },
				{ role: 'assistant', content: 'done' }
			],
			{ 1: steps }
		);

		expect(mocks.invoke).toHaveBeenCalledWith('db_replace_messages', {
			conversationId: 'c1',
			messages: [
				{ role: 'user', content: 'run it', tool_calls: null, tool_call_id: null, steps: null },
				{
					role: 'assistant',
					content: 'done',
					tool_calls: null,
					tool_call_id: null,
					steps: JSON.stringify(steps)
				}
			]
		});
	});

	it('sends null steps for every message when stepsByIndex is omitted', async () => {
		const db = await availableDb();
		mocks.invoke.mockResolvedValueOnce(undefined);

		await db.dbReplaceMessages('c1', [
			{ role: 'user', content: 'a' },
			{ role: 'assistant', content: 'b' }
		]);

		const payload = mocks.invoke.mock.calls[0][1] as { messages: { steps: string | null }[] };
		expect(payload.messages.map((m) => m.steps)).toEqual([null, null]);
	});

	it('swallows an invoke rejection with a debug log', async () => {
		const db = await availableDb();
		mocks.invoke.mockRejectedValueOnce(new Error('locked'));

		await expect(
			db.dbReplaceMessages('c1', [{ role: 'user', content: 'a' }])
		).resolves.toBeUndefined();
		expect(mocks.logDebug).toHaveBeenCalledWith(
			'db',
			'dbReplaceMessages failed',
			expect.objectContaining({ conversationId: 'c1' })
		);
	});
});

describe('dbLoadMessageSteps', () => {
	const row = (steps: string | null) => ({
		role: 'assistant',
		content: '',
		tool_calls: null,
		tool_call_id: null,
		steps
	});

	it('maps steps JSON into an index-keyed record, ignoring corrupt or non-array rows', async () => {
		const db = await availableDb();
		mocks.invoke.mockResolvedValueOnce({
			id: 'c1',
			title: 'Chat',
			created_at: 0,
			updated_at: 0,
			messages: [
				row('[{"toolName":"web_search"}]'),
				row('not json {'),
				row(null),
				row('{"toolName":"not-an-array"}'),
				row('[]')
			]
		});

		const out = await db.dbLoadMessageSteps('c1');

		expect(mocks.invoke).toHaveBeenCalledWith('db_get_conversation', { id: 'c1' });
		expect(out).toEqual({
			0: [{ toolName: 'web_search' }],
			4: []
		});
	});

	it('returns an empty record (with a debug log) when the invoke fails', async () => {
		const db = await availableDb();
		mocks.invoke.mockRejectedValueOnce(new Error('row gone'));

		expect(await db.dbLoadMessageSteps('c1')).toEqual({});
		expect(mocks.logDebug).toHaveBeenCalledWith(
			'db',
			'dbLoadMessageSteps failed',
			expect.objectContaining({ id: 'c1' })
		);
	});
});

describe('dbLoadMessages', () => {
	it('deserializes rows back into ChatMessages, including multimodal content', async () => {
		const db = await availableDb();
		const multimodal = [{ type: 'text', text: 'see attachment' }];
		mocks.invoke.mockResolvedValueOnce({
			id: 'c1',
			title: 'Chat',
			created_at: 0,
			updated_at: 0,
			messages: [
				{
					role: 'user',
					content: MM_PREFIX + JSON.stringify(multimodal),
					tool_calls: null,
					tool_call_id: null,
					steps: null
				},
				{
					role: 'assistant',
					content: 'plain',
					tool_calls: '[{"id":"1"}]',
					tool_call_id: null,
					steps: null
				},
				{
					role: 'tool',
					content: 'result',
					tool_calls: 'corrupt {',
					tool_call_id: 'call_1',
					steps: null
				}
			]
		});

		const messages = await db.dbLoadMessages('c1');

		expect(messages[0]).toEqual({ role: 'user', content: multimodal });
		expect(messages[1]).toEqual({ role: 'assistant', content: 'plain', tool_calls: [{ id: '1' }] });
		// Corrupt tool_calls JSON is dropped; tool_call_id still mapped.
		expect(messages[2]).toEqual({ role: 'tool', content: 'result', tool_call_id: 'call_1' });
	});

	it('returns [] (with a debug log) when the invoke fails', async () => {
		const db = await availableDb();
		mocks.invoke.mockRejectedValueOnce(new Error('gone'));

		expect(await db.dbLoadMessages('c1')).toEqual([]);
		expect(mocks.logDebug).toHaveBeenCalledWith(
			'db',
			'dbLoadMessages failed',
			expect.objectContaining({ id: 'c1' })
		);
	});
});

describe('conversation CRUD wrappers', () => {
	it.each([
		['dbCreateConversation', 'db_create_conversation', { id: 'c1', title: 'T' }],
		['dbRenameConversation', 'db_rename_conversation', { id: 'c1', title: 'T' }],
		['dbDeleteConversation', 'db_delete_conversation', { id: 'c1' }]
	] as const)('%s forwards to %s', async (fnName, command, payload) => {
		const db = await availableDb();
		mocks.invoke.mockResolvedValueOnce(undefined);

		if (fnName === 'dbDeleteConversation') {
			await db.dbDeleteConversation('c1');
		} else {
			await db[fnName]('c1', 'T');
		}

		expect(mocks.invoke).toHaveBeenCalledWith(command, payload);
	});

	it('dbClearAll forwards to db_clear_all_conversations and swallows failures', async () => {
		const db = await availableDb();
		mocks.invoke.mockRejectedValueOnce(new Error('nope'));

		await expect(db.dbClearAll()).resolves.toBeUndefined();
		expect(mocks.invoke).toHaveBeenCalledWith('db_clear_all_conversations');
		expect(mocks.logDebug).toHaveBeenCalledWith('db', 'dbClearAll failed', expect.anything());
	});
});
