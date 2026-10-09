import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	chatCompletion: vi.fn(),
	withInferenceSlot: vi.fn()
}));

vi.mock('#lib/api.ts', () => ({ chatCompletion: mocks.chatCompletion }));
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	withInferenceSlot: mocks.withInferenceSlot
}));
vi.mock('#lib/inference/descriptor.ts', () => ({
	resolveBackendDescriptor: () => ({ kind: 'local' })
}));
vi.mock('#lib/stores/settings.ts', () => ({
	getChatTemplateKwargs: (_d: unknown, thinking: boolean) => ({ enable_thinking: thinking }),
	getOpenRouterReasoningParam: () => null,
	getSamplingParams: () => ({ temperature: 0.7 })
}));
vi.mock('#lib/debug-log.ts', () => ({ logDebug: () => {} }));

import { cleanTitle, isSlashCommand, nameSession, titleFromMessage } from './sessionTitle';

beforeEach(() => {
	mocks.chatCompletion.mockReset().mockResolvedValue({ content: 'Fix the build' });
	mocks.withInferenceSlot
		.mockReset()
		.mockImplementation((_o: unknown, fn: () => Promise<unknown>) => fn());
});

describe('nameSession', () => {
	it('asks the session backend for a short title, queued, with reasoning off', async () => {
		const backend = { baseUrl: 'http://box:8080', modelId: 'qwen' };
		expect(await nameSession('the build fails on main', backend)).toBe('Fix the build');
		expect(mocks.withInferenceSlot).toHaveBeenCalledWith(
			{ consumer: 'code', backend },
			expect.any(Function)
		);
		const req = mocks.chatCompletion.mock.calls[0][0];
		expect(req.backend).toBe(backend);
		expect(req.tools).toBeUndefined();
		expect(req.max_tokens).toBeLessThanOrEqual(64);
		expect(req.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(req.messages.at(-1).content).toContain('the build fails on main');
	});

	it('uses Settings when the session has no backend of its own', async () => {
		await nameSession('x', null);
		expect(mocks.chatCompletion.mock.calls[0][0].backend).toBeUndefined();
	});

	it('falls back to the message when the call fails', async () => {
		mocks.chatCompletion.mockRejectedValueOnce(new Error('offline'));
		expect(await nameSession(`  fix   the\nbuild ${'x'.repeat(80)}`, null)).toBe(
			titleFromMessage(`fix the build ${'x'.repeat(80)}`)
		);
	});

	it('falls back to the message when the reply is empty', async () => {
		mocks.chatCompletion.mockResolvedValueOnce({ content: '<think>hmm</think>  ' });
		expect(await nameSession('add a readme', null)).toBe('add a readme');
	});
});

describe('cleanTitle', () => {
	it('strips reasoning, quotes, labels and the trailing period', () => {
		expect(cleanTitle('<think>a title?</think>\n"Fix the README typo."')).toBe(
			'Fix the README typo'
		);
		expect(cleanTitle('Title: “Add dark mode”')).toBe('Add dark mode');
		expect(cleanTitle("'Port the user's script'\nmore")).toBe("Port the user's script");
		expect(cleanTitle('<think>never closed')).toBe('');
	});

	it('keeps at most 60 characters', () => {
		expect(cleanTitle('word '.repeat(30))).toHaveLength(59);
	});
});

describe('isSlashCommand', () => {
	it('is a message that starts with a slash', () => {
		expect(isSlashCommand(' /init')).toBe(true);
		expect(isSlashCommand('fix /etc/hosts')).toBe(false);
	});
});
