import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpecialistEntry } from './types';

const api = vi.hoisted(() => ({ chatCompletionStream: vi.fn() }));
vi.mock('#lib/api.ts', () => api);
const queue = vi.hoisted(() => ({
	withInferenceSlot: vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => fn())
}));
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => queue);
const descriptor = vi.hoisted(() => ({
	resolveBackendDescriptor: vi.fn(() => ({ baseUrl: 'http://compute:3000' }))
}));
vi.mock('#lib/inference/descriptor.ts', () => descriptor);
const probe = vi.hoisted(() => ({ probeInferenceServer: vi.fn() }));
vi.mock('#lib/inferenceProbe.ts', () => probe);
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => ({ specialists: [] })
	})
);

import '#lib/specialists/kinds/index.ts';
import { callOptionsFrom, callSpecialist, listSpecialistModels } from './call';
import { newSpecialistEntry } from './entries';

function entry(over: Partial<SpecialistEntry> = {}): SpecialistEntry {
	return {
		...newSpecialistEntry('text', []),
		name: 'Coder',
		url: 'http://asmodean:3000',
		model: 'small',
		...over
	};
}

function streamOf(...chunks: object[]) {
	return async function* () {
		for (const c of chunks) yield { delta: {}, finish_reason: null, ...c };
	};
}

const sent = () => api.chatCompletionStream.mock.calls[0][0];

beforeEach(() => {
	api.chatCompletionStream
		.mockReset()
		.mockImplementation(
			streamOf(
				{ delta: { reasoning_content: 'hmm' } },
				{ delta: { content: 'Hello' } },
				{ delta: { content: '!' }, finish_reason: 'stop', usage: { completion_tokens: 3 } }
			)
		);
	queue.withInferenceSlot.mockClear();
	descriptor.resolveBackendDescriptor.mockClear();
});

describe('callSpecialist', () => {
	it('sends the request with the entry backend and sampling', async () => {
		const answer = await callSpecialist(entry({ sampling: { top_k: 20 } }), 'Hi');
		expect(answer).toEqual({
			content: 'Hello!',
			reasoning: 'hmm',
			finishReason: 'stop',
			completionTokens: 3
		});
		expect(sent()).toMatchObject({
			messages: [{ role: 'user', content: 'Hi' }],
			backend: { baseUrl: 'http://asmodean:3000', modelId: 'small' },
			temperature: 0.7,
			top_k: 20,
			max_tokens: 4096
		});
		expect(sent()).not.toHaveProperty('chat_template_kwargs');
		expect(sent()).not.toHaveProperty('thinking');
	});

	it('sends a system prompt only when there is one', async () => {
		await callSpecialist(entry({ systemPrompt: 'Use three.' }), 'Hi');
		expect(sent().messages[0]).toEqual({ role: 'system', content: 'Use three.' });
	});

	it('sends enable_thinking only when thinking is set', async () => {
		await callSpecialist(entry({ sampling: { thinking: false } }), 'Hi');
		expect(sent().chat_template_kwargs).toEqual({ enable_thinking: false });
	});

	it('lets maxTokens replace the sampling budget', async () => {
		await callSpecialist(entry(), 'Hi', { maxTokens: 64 });
		expect(sent().max_tokens).toBe(64);
	});

	it('puts images before the text', async () => {
		const images = [{ path: 'ref.png', dataUrl: 'data:image/png;base64,AA' }];
		await callSpecialist(entry({ acceptsImages: true }), 'Like this', { images });
		expect(sent().messages[0].content).toEqual([
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
			{ type: 'text', text: 'Like this' }
		]);
	});

	it('refuses images for an entry that does not take them', async () => {
		const images = [{ path: 'ref.png', dataUrl: 'data:image/png;base64,AA' }];
		await expect(callSpecialist(entry(), 'Hi', { images })).rejects.toThrow(/doesn't take images/);
		expect(api.chatCompletionStream).not.toHaveBeenCalled();
	});

	it("queues on the specialist's own lane when it is on another server", async () => {
		await callSpecialist(entry(), 'Hi', { inTurn: true, runInSlot: vi.fn() });
		expect(queue.withInferenceSlot).toHaveBeenCalledOnce();
		expect(queue.withInferenceSlot.mock.calls[0][0]).toMatchObject({
			consumer: 'subagent',
			backend: { baseUrl: 'http://asmodean:3000' }
		});
	});

	it("shares the turn's slot when it is on the turn's server", async () => {
		const same = entry({ url: 'http://compute:3000/v1' });
		const runInSlot = vi.fn(async <T>(fn: () => Promise<T>) => fn());
		await callSpecialist(same, 'Hi', { inTurn: true, runInSlot: runInSlot as never });
		expect(runInSlot).toHaveBeenCalledOnce();
		expect(queue.withInferenceSlot).not.toHaveBeenCalled();

		// Tools one at a time: no lender, the call just uses the turn's slot.
		await callSpecialist(same, 'Hi', { inTurn: true });
		expect(queue.withInferenceSlot).not.toHaveBeenCalled();
	});

	it('queues a same-server call made outside a turn', async () => {
		await callSpecialist(entry({ url: 'http://compute:3000' }), 'Hi');
		expect(queue.withInferenceSlot).toHaveBeenCalledOnce();
	});

	it('reports progress with a token count', async () => {
		const onProgress = vi.fn();
		await callSpecialist(entry(), 'Hi', { onProgress });
		expect(onProgress).toHaveBeenCalledWith('Coder: 1 tokens');
	});

	it('returns a length finish rather than throwing', async () => {
		api.chatCompletionStream.mockImplementation(
			streamOf({ delta: { reasoning_content: 'thinking…' }, finish_reason: 'length' })
		);
		expect((await callSpecialist(entry(), 'Hi')).finishReason).toBe('length');
	});

	it('passes an abort through', async () => {
		api.chatCompletionStream.mockImplementation(async function* () {
			yield* [];
			throw new DOMException('Aborted', 'AbortError');
		});
		await expect(callSpecialist(entry(), 'Hi')).rejects.toThrow('Aborted');
	});
});

describe('listSpecialistModels', () => {
	it("lists the probed server's model ids, with the entry's key", async () => {
		probe.probeInferenceServer.mockResolvedValueOnce({ models: [{ id: 'a' }, { id: 'b' }] });
		const e = entry({ url: 'http://box:8080/v1/', keyId: 'k1' });
		expect(await listSpecialistModels(e)).toEqual(['a', 'b']);
		expect(probe.probeInferenceServer).toHaveBeenCalledWith('http://box:8080', 'k1');
	});
});

describe('callOptionsFrom', () => {
	it("takes the turn's signal, progress, backend and slot", () => {
		const ctx = {
			workingDir: null,
			signal: new AbortController().signal,
			onProgress: vi.fn(),
			backend: { baseUrl: 'http://compute:3000' },
			runInSlot: vi.fn()
		};
		expect(callOptionsFrom(ctx as never)).toEqual({
			signal: ctx.signal,
			onProgress: ctx.onProgress,
			inTurn: true,
			turnBackend: ctx.backend,
			runInSlot: ctx.runInSlot
		});
	});
});
