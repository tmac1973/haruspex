import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '#lib/api.ts';
import { resetTokenCalibration, type ContextManagedInfo } from '#lib/agent/contextBudget.ts';
import type { LoopContext } from './context';
import { applyContextGuard, raceWithAbort, samplingOptionsFor } from './modelCall';

vi.mock('#lib/debugLog.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/debugLog.ts')>()),
	logDebug: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn().mockRejectedValue(new Error('not available'))
}));

describe('raceWithAbort', () => {
	it('returns the promise untouched without a signal', async () => {
		const p = Promise.resolve(1);
		expect(raceWithAbort(p)).toBe(p);
		await expect(raceWithAbort(p)).resolves.toBe(1);
	});

	it('rejects with AbortError when the signal is already aborted', async () => {
		const ac = new AbortController();
		ac.abort();
		const err = await raceWithAbort(Promise.resolve(1), ac.signal).catch((e) => e);
		expect(err).toBeInstanceOf(DOMException);
		expect(err.name).toBe('AbortError');
	});

	it('rejects with AbortError when aborted before the promise settles', async () => {
		const ac = new AbortController();
		let resolve!: (v: number) => void;
		const pending = new Promise<number>((r) => (resolve = r));
		const raced = raceWithAbort(pending, ac.signal);
		ac.abort();
		resolve(5);
		await expect(raced).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('resolves with the value when the promise settles first', async () => {
		const ac = new AbortController();
		await expect(raceWithAbort(Promise.resolve('ok'), ac.signal)).resolves.toBe('ok');
		// A later abort has no effect on the settled result.
		ac.abort();
	});

	it('passes a rejection through unchanged', async () => {
		const ac = new AbortController();
		const boom = new Error('boom');
		await expect(raceWithAbort(Promise.reject(boom), ac.signal)).rejects.toBe(boom);
	});
});

function ctxWith(over: Record<string, unknown>): LoopContext {
	return {
		messages: [],
		codeMode: false,
		thinkingEnabled: null,
		samplingSource: 'profile',
		samplingParams: null,
		contextSize: 0,
		descriptor: { calibrationKey: 'test' },
		options: {},
		...over
	} as unknown as LoopContext;
}

describe('samplingOptionsFor', () => {
	const pythonTurn: ChatMessage[] = [
		{ role: 'user', content: 'plot it' },
		{
			role: 'assistant',
			content: '',
			tool_calls: [{ id: 'a', type: 'function', function: { name: 'run_python', arguments: '{}' } }]
		}
	];

	it('copies the turn sampling fields', () => {
		const params = { temperature: 0.2 } as LoopContext['samplingParams'];
		const ctx = ctxWith({
			thinkingEnabled: false,
			samplingSource: 'custom',
			samplingParams: params
		});
		expect(samplingOptionsFor(ctx, [{ role: 'user', content: 'hi' }])).toEqual({
			codeContext: false,
			thinkingEnabled: false,
			samplingSource: 'custom',
			samplingParams: params
		});
	});

	it('uses the coding profile in code mode regardless of messages', () => {
		expect(samplingOptionsFor(ctxWith({ codeMode: true }), []).codeContext).toBe(true);
	});

	it('detects Python work from the messages outside code mode', () => {
		expect(samplingOptionsFor(ctxWith({}), pythonTurn).codeContext).toBe(true);
	});
});

describe('applyContextGuard', () => {
	beforeEach(() => resetTokenCalibration());

	function bigConversation(): ChatMessage[] {
		return [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'old question' },
			{ role: 'assistant', content: 'a'.repeat(40_000) },
			{ role: 'user', content: 'latest question' }
		];
	}

	it('does nothing when the context size is unknown', () => {
		const events: ContextManagedInfo[] = [];
		const messages = bigConversation();
		const snapshot = structuredClone(messages);
		applyContextGuard(
			ctxWith({
				messages,
				contextSize: 0,
				options: { onContextManaged: (i: ContextManagedInfo) => events.push(i) }
			}),
			512
		);
		expect(messages).toEqual(snapshot);
		expect(events).toEqual([]);
	});

	it('does nothing when the prompt already fits', () => {
		const events: ContextManagedInfo[] = [];
		const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
		applyContextGuard(
			ctxWith({
				messages,
				contextSize: 32_768,
				options: { onContextManaged: (i: ContextManagedInfo) => events.push(i) }
			}),
			512
		);
		expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
		expect(events).toEqual([]);
	});

	it('shrinks an oversized prompt and reports what it did', () => {
		const events: ContextManagedInfo[] = [];
		const messages = bigConversation();
		const before = JSON.stringify(messages).length;
		applyContextGuard(
			ctxWith({
				messages,
				contextSize: 4096,
				options: { onContextManaged: (i: ContextManagedInfo) => events.push(i) }
			}),
			1024
		);
		expect(JSON.stringify(messages).length).toBeLessThan(before);
		expect(events).toHaveLength(1);
		expect(events[0].afterEst).toBeLessThan(events[0].beforeEst);
		// The newest user message survives.
		expect(messages.at(-1)).toEqual({ role: 'user', content: 'latest question' });
	});

	it('still shrinks without an onContextManaged listener', () => {
		const messages = bigConversation();
		const before = JSON.stringify(messages).length;
		applyContextGuard(ctxWith({ messages, contextSize: 4096 }), 1024);
		expect(JSON.stringify(messages).length).toBeLessThan(before);
	});
});
