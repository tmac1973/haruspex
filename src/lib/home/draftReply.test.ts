import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeRouter } from '#lib/testing/invoke.ts';
import type { EmailAccount } from '#lib/stores/settings.ts';
import type { EphemeralTurnOptions } from '#lib/agent/runEphemeralTurn.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

const m = vi.hoisted(() => ({
	runEphemeralTurn: vi.fn(),
	slotOptions: [] as unknown[]
}));
vi.mock('#lib/agent/runEphemeralTurn.ts', () => ({ runEphemeralTurn: m.runEphemeralTurn }));
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	withInferenceSlot: async <T>(opts: unknown, fn: (slot: unknown) => Promise<T>) => {
		m.slotOptions.push(opts);
		return fn({ held: true });
	}
}));
vi.mock('#lib/inference/descriptor.ts', () => ({
	resolveBackendDescriptor: () => ({ contextSize: 8192 })
}));

import { draftReply } from './draftReply';

const account = { id: 'w', label: 'Work', sendEnabled: true } as EmailAccount;
const REPLY = {
	to: ['dana@example.com'],
	ccAll: ['lee@example.com'],
	subject: 'Re: Invoice overdue',
	inReplyTo: '<a1@example.com>',
	references: ['<a0@example.com>', '<a1@example.com>'],
	quoted: 'On Mon, Dana wrote:\n> Please pay by Friday.'
};

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	vi.mocked(invoke).mockImplementation(
		invokeRouter({ email_reply_context: REPLY, email_cancel: null })
	);
	m.runEphemeralTurn.mockReset();
	m.slotOptions = [];
});

describe('draftReply', () => {
	it('passes the threading through to the draft, with the model’s text as the body', async () => {
		m.runEphemeralTurn.mockImplementation(async (opts: EphemeralTurnOptions) => {
			opts.onAssistantDelta?.('Paid');
			return { finalText: ' Paid today. \n', rawText: '' };
		});
		const deltas: string[] = [];
		const draft = await draftReply({
			account,
			messageId: '7:1',
			instruction: 'say it is paid',
			onDelta: (t) => deltas.push(t),
			signal: new AbortController().signal
		});
		expect(draft).toEqual({
			accountId: 'w',
			to: ['dana@example.com'],
			cc: [],
			subject: 'Re: Invoice overdue',
			body: 'Paid today.',
			quoted: REPLY.quoted,
			inReplyTo: '<a1@example.com>',
			references: ['<a0@example.com>', '<a1@example.com>']
		});
		expect(deltas).toEqual(['Paid']);
		const turn = m.runEphemeralTurn.mock.calls[0][0] as EphemeralTurnOptions;
		expect(turn.userMessage).toContain('How to reply: say it is paid');
		expect(turn.userMessage).toContain('> Please pay by Friday.');
		expect(turn.toolAllowlist).toEqual([]);
		expect(m.slotOptions[0]).toMatchObject({ consumer: { kind: 'home', label: 'Draft reply' } });
	});

	it('hands the abort signal to the turn, so Stop stops it', async () => {
		const abort = new AbortController();
		m.runEphemeralTurn.mockImplementation(async (opts: EphemeralTurnOptions) => {
			abort.abort();
			if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
			return { finalText: 'x', rawText: 'x' };
		});
		await expect(
			draftReply({
				account,
				messageId: '7:1',
				instruction: '',
				onDelta: () => {},
				signal: abort.signal
			})
		).rejects.toThrow('Aborted');
	});
});
