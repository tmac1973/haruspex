import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '#lib/api.ts';

const mocks = vi.hoisted(() => ({
	chatCompletion: vi.fn(),
	resolveBackendDescriptor: vi.fn(),
	getChatTemplateKwargs: vi.fn()
}));

vi.mock('#lib/api.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/api.ts')>()),
	chatCompletion: mocks.chatCompletion
}));
vi.mock('#lib/inference/descriptor.ts', () => ({
	resolveBackendDescriptor: mocks.resolveBackendDescriptor
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getChatTemplateKwargs: mocks.getChatTemplateKwargs
}));

import {
	chooseCut,
	compactCodeThread,
	modelThread,
	renderForSummary,
	shouldCompactCode,
	summarizeTurns,
	summaryMaxTokens
} from '#lib/code/compaction.ts';
import { estimateMessagesTokens, resetTokenCalibration } from '#lib/agent/context-budget.ts';

const user = (content: string): ChatMessage => ({ role: 'user', content });
const answer = (content: string): ChatMessage => ({ role: 'assistant', content });
const call = (id: string, name = 'fs_read_text', args = '{"path":"src/a.ts"}'): ChatMessage => ({
	role: 'assistant',
	content: '',
	tool_calls: [{ id, type: 'function', function: { name, arguments: args } }]
});
const result = (id: string, content = 'ok'): ChatMessage => ({
	role: 'tool',
	tool_call_id: id,
	content
});

/** `n` turns, each a request, a call and its result, and an answer. */
function thread(n: number, size = 2000): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (let i = 0; i < n; i++) {
		out.push(user(`request ${i} ` + 'u'.repeat(size)));
		out.push(call(`c${i}`));
		out.push(result(`c${i}`, `result ${i} ` + 'r'.repeat(size)));
		out.push(answer(`answer ${i} ` + 'a'.repeat(size)));
	}
	return out;
}

beforeEach(() => {
	resetTokenCalibration();
	mocks.chatCompletion.mockReset();
	mocks.resolveBackendDescriptor.mockReset().mockReturnValue({ contextSize: 32768 });
	mocks.getChatTemplateKwargs.mockReset().mockReturnValue({ enable_thinking: false });
});

describe('modelThread', () => {
	it('is the thread itself without a compaction', () => {
		const messages = thread(2);
		expect(modelThread({ messages, compaction: null })).toBe(messages);
	});

	it('is the summary note, then the messages from the cut', () => {
		const messages = thread(3);
		const view = modelThread({
			messages,
			compaction: { at: 4, summary: 'Did 0.', summarizedAt: 1 }
		});
		expect(view[0].role).toBe('system');
		expect(String(view[0].content)).toContain('Did 0.');
		expect(view.slice(1)).toEqual(messages.slice(4));
	});
});

describe('shouldCompactCode', () => {
	it('fires at 75% of the window, counting the overhead', () => {
		const view = thread(4);
		// Calibration defaults to 1.5.
		const est = estimateMessagesTokens(view) * 1.5;
		expect(shouldCompactCode(view, Math.ceil(est / 0.7))).toBe(false);
		expect(shouldCompactCode(view, Math.floor(est / 0.76))).toBe(true);
		expect(shouldCompactCode(view, Math.ceil(est / 0.7), estimateMessagesTokens(view))).toBe(true);
	});

	it('never fires without a known window', () => {
		expect(shouldCompactCode(thread(50), 0)).toBe(false);
	});
});

describe('chooseCut', () => {
	it('lands on a turn opening and keeps the newest turns within a quarter of the window', () => {
		const messages = thread(20);
		const cut = chooseCut(messages, 0, 32768)!;
		expect(messages[cut].role).toBe('user');
		const kept = estimateMessagesTokens(messages.slice(cut)) * 1.5;
		expect(kept).toBeLessThanOrEqual(32768 * 0.25);
		// One more turn would not have fit.
		expect(estimateMessagesTokens(messages.slice(cut - 4)) * 1.5).toBeGreaterThan(32768 * 0.25);
	});

	it('keeps the last turn however big it is', () => {
		const messages = [...thread(3), user('now ' + 'x'.repeat(200_000))];
		expect(chooseCut(messages, 0, 32768)).toBe(messages.length - 1);
	});

	it('never cuts between a call and its results', () => {
		const messages = [
			user('go'),
			call('a'),
			result('a', 'x'.repeat(30_000)),
			call('b'),
			result('b', 'y'.repeat(30_000)),
			user('steer'),
			answer('done'),
			user('next')
		];
		const cut = chooseCut(messages, 0, 32768)!;
		expect(messages[cut].role).toBe('user');
		expect(cut).toBeGreaterThan(0);
	});

	it('is null when everything is recent, or nothing is past the current cut', () => {
		expect(chooseCut(thread(2, 100), 0, 32768)).toBeNull();
		expect(chooseCut([user('only')], 0, 32768)).toBeNull();
		const messages = thread(20);
		const cut = chooseCut(messages, 0, 32768)!;
		expect(chooseCut(messages, cut, 32768)).toBeNull();
	});
});

describe('renderForSummary', () => {
	it('gives one entry per turn, naming calls and clipping results', () => {
		const turns = renderForSummary([
			user('read it'),
			call('a', 'run_command', '{"command":"npm test"}'),
			result('a', 'x'.repeat(40_000)),
			answer('<think>hmm</think>Tests pass.'),
			user('thanks'),
			answer('ok')
		]);
		expect(turns).toHaveLength(2);
		expect(turns[0]).toContain('→ run_command(npm test)');
		expect(turns[0]).toContain('Assistant: Tests pass.');
		expect(turns[0]).not.toContain('hmm');
		expect(turns[0].length).toBeLessThan(2000);
	});
});

describe('renderForSummary and reasoning', () => {
	it('drops the reasoning of a reply that has an answer', () => {
		const [turn] = renderForSummary([user('how many?'), answer('<think>count them</think>W9.')]);
		expect(turn).toContain('Assistant: W9.');
		expect(turn).not.toContain('count them');
	});

	it('keeps an answer written wholly inside an unclosed think block', () => {
		const [turn] = renderForSummary([
			user('how many?'),
			answer('<think>Adding them up: W9 has 173, the most.')
		]);
		expect(turn).toContain('W9 has 173');
	});
});

describe('summarizeTurns', () => {
	it('makes one call when everything fits, against the session backend', async () => {
		mocks.chatCompletion.mockResolvedValue({ content: 'Summary.' });
		const backend = { baseUrl: 'http://box:8000', model: 'm' } as never;
		const out = await summarizeTurns({
			previous: null,
			turns: ['User: a', 'User: b'],
			backend,
			contextSize: 32768
		});
		expect(out).toBe('Summary.');
		expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
		const [req] = mocks.chatCompletion.mock.calls[0];
		expect(req.backend).toBe(backend);
		expect(req.max_tokens).toBe(summaryMaxTokens(32768));
		expect(mocks.resolveBackendDescriptor).toHaveBeenCalledWith(backend);
		expect(mocks.getChatTemplateKwargs).toHaveBeenCalledWith(expect.anything(), false);
	});

	it('rolls the summary forward over chunks that each fit the window', async () => {
		let n = 0;
		mocks.chatCompletion.mockImplementation(async () => ({ content: `Summary ${++n}.` }));
		const turns = renderForSummary(thread(40, 3000));
		const out = await summarizeTurns({
			previous: 'Before.',
			turns,
			backend: null,
			contextSize: 16384
		});
		expect(mocks.chatCompletion.mock.calls.length).toBeGreaterThan(1);
		expect(out).toBe(`Summary ${n}.`);
		mocks.chatCompletion.mock.calls.forEach(([req], i) => {
			const prompt = estimateMessagesTokens(req.messages) * 1.5;
			expect(prompt + req.max_tokens).toBeLessThanOrEqual(16384);
			// Each call carries the summary so far.
			expect(String(req.messages[1].content)).toContain(i === 0 ? 'Before.' : `Summary ${i}.`);
		});
	});

	it('clips a turn too big for a request on its own', async () => {
		mocks.chatCompletion.mockResolvedValue({ content: 'Summary.' });
		await summarizeTurns({
			previous: null,
			turns: ['User: ' + 'x'.repeat(500_000)],
			backend: null,
			contextSize: 16384
		});
		const [req] = mocks.chatCompletion.mock.calls[0];
		expect(estimateMessagesTokens(req.messages) * 1.5 + req.max_tokens).toBeLessThanOrEqual(16384);
	});

	it('throws on an empty reply, so the caller carries on without', async () => {
		mocks.chatCompletion.mockResolvedValue({ content: '<think>…</think>  ' });
		await expect(
			summarizeTurns({ previous: null, turns: ['User: a'], backend: null, contextSize: 32768 })
		).rejects.toThrow('empty summary');
	});

	it('passes on what the user asked to keep', async () => {
		mocks.chatCompletion.mockResolvedValue({ content: 'Summary.' });
		await summarizeTurns({
			previous: null,
			turns: ['User: a'],
			backend: null,
			contextSize: 32768,
			instructions: 'the API notes'
		});
		expect(String(mocks.chatCompletion.mock.calls[0][0].messages[1].content)).toContain(
			'The user asks you to keep: the API notes'
		);
	});
});

describe('compactCodeThread', () => {
	it('summarises from the current cut to a new one, carrying the old summary', async () => {
		mocks.chatCompletion.mockResolvedValue({ content: 'New summary.' });
		const messages = thread(30);
		const first = chooseCut(messages.slice(0, 40), 0, 32768)!;
		const out = await compactCodeThread({
			messages,
			compaction: { at: first, summary: 'Old summary.', summarizedAt: 1 },
			backend: null,
			contextSize: 32768
		});
		expect(out!.at).toBeGreaterThan(first);
		expect(out!.summary).toBe('New summary.');
		const sent = String(mocks.chatCompletion.mock.calls[0][0].messages[1].content);
		expect(sent).toContain('Old summary.');
		expect(sent).toContain(`request ${first / 4} `);
		expect(sent).not.toContain(`request ${first / 4 - 1} `);
	});

	it('is null, without a model call, when there is nothing to summarise', async () => {
		const out = await compactCodeThread({
			messages: thread(1),
			compaction: null,
			backend: null,
			contextSize: 32768
		});
		expect(out).toBeNull();
		expect(mocks.chatCompletion).not.toHaveBeenCalled();
	});
});
