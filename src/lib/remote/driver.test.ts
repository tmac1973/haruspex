import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	runEphemeralTurn: vi.fn(),
	withInferenceSlot: vi.fn(),
	resolveBackendDescriptor: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('$lib/agent/runEphemeralTurn', () => ({ runEphemeralTurn: mocks.runEphemeralTurn }));
vi.mock('$lib/agent/inferenceQueue.svelte', () => ({
	withInferenceSlot: mocks.withInferenceSlot
}));
vi.mock('$lib/inference/descriptor', () => ({
	resolveBackendDescriptor: mocks.resolveBackendDescriptor
}));

import { runRemoteTurn, cancelRemoteTurn, REMOTE_TOOLS } from '$lib/remote/driver';
import type { EphemeralTurnOptions } from '$lib/agent/runEphemeralTurn';

const prompt = { sessionId: 'guest1', turnId: 'guest1#0', message: 'what is a haruspex?' };

function turnOptions(): EphemeralTurnOptions {
	return mocks.runEphemeralTurn.mock.calls[0][0] as EphemeralTurnOptions;
}

function calls(command: string) {
	return mocks.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);
}

beforeEach(() => {
	mocks.invoke.mockReset().mockResolvedValue(undefined);
	mocks.runEphemeralTurn
		.mockReset()
		.mockResolvedValue({ finalText: 'an answer', rawText: 'an answer' });
	mocks.resolveBackendDescriptor.mockReturnValue({ contextSize: 8192 });
	mocks.withInferenceSlot
		.mockReset()
		.mockImplementation(async (opts: { onAdmitted?: () => void }, fn: () => Promise<unknown>) => {
			opts.onAdmitted?.();
			return fn();
		});
});

describe('the remote turn driver', () => {
	it('gives a guest web tools and nothing that touches the host', async () => {
		await runRemoteTurn(prompt);
		const options = turnOptions();
		expect(options.toolAllowlist).toBe(REMOTE_TOOLS);
		expect([...REMOTE_TOOLS]).toEqual(['web_search', 'fetch_url', 'research_url']);
		// The three that would make a guest dangerous, stated explicitly so
		// widening the list is a deliberate act rather than an accident.
		for (const forbidden of ['fs_write_text', 'run_command', 'fs_read_text']) {
			expect([...REMOTE_TOOLS]).not.toContain(forbidden);
		}
		expect(options.workingDir).toBeNull();
		expect(options.interactive).toBe(false);
	});

	it('queues like any other consumer, labelled with the guest session', async () => {
		await runRemoteTurn(prompt);
		const slotOptions = mocks.withInferenceSlot.mock.calls[0][0];
		expect(slotOptions.consumer).toEqual({ kind: 'remote', client: 'guest1' });
	});

	it('tells the client it is running only once it has a slot', async () => {
		let admit: (() => void) | null = null;
		mocks.withInferenceSlot.mockImplementationOnce(
			async (opts: { onAdmitted?: () => void }, fn: () => Promise<unknown>) => {
				admit = () => opts.onAdmitted?.();
				return fn();
			}
		);
		mocks.runEphemeralTurn.mockImplementationOnce(async () => {
			// Still waiting: nothing has told the client it started.
			expect(calls('remote_turn_running')).toHaveLength(0);
			admit?.();
			return { finalText: 'x', rawText: 'x' };
		});
		await runRemoteTurn(prompt);
		expect(calls('remote_turn_running')).toEqual([{ turnId: prompt.turnId }]);
	});

	it('streams the whole answer so far, so a dropped update loses nothing', async () => {
		mocks.runEphemeralTurn.mockImplementationOnce(async (options: EphemeralTurnOptions) => {
			options.onAssistantDelta?.('An');
			options.onAssistantDelta?.('An hars');
			options.onAssistantDelta?.('An haruspex');
			await new Promise((resolve) => setTimeout(resolve, 0));
			return { finalText: 'An haruspex', rawText: 'An haruspex' };
		});
		await runRemoteTurn(prompt);
		// Each update is cumulative, so intermediates may be coalesced away —
		// what must hold is that every one sent is a prefix-complete answer and
		// the last one is current.
		const texts = calls('remote_turn_delta').map((args) => args.text);
		expect(texts.length).toBeGreaterThan(0);
		expect(texts[0]).toBe('An');
		expect(texts[texts.length - 1]).toBe('An haruspex');
		expect(calls('remote_turn_done')).toEqual([{ turnId: prompt.turnId, text: 'An haruspex' }]);
	});

	it('keeps the partial answer when a guest stops the turn', async () => {
		mocks.runEphemeralTurn.mockImplementationOnce(async (options: EphemeralTurnOptions) => {
			options.onAssistantDelta?.('half an ans');
			cancelRemoteTurn(prompt.turnId);
			throw new Error('aborted');
		});
		await runRemoteTurn(prompt);
		// Not an error: the guest was already reading this, and throwing it away
		// would be the worse outcome.
		expect(calls('remote_turn_error')).toHaveLength(0);
		expect(calls('remote_turn_done')).toEqual([{ turnId: prompt.turnId, text: 'half an ans' }]);
	});

	it('reports a real failure as an error', async () => {
		mocks.runEphemeralTurn.mockRejectedValueOnce(new Error('model is not running'));
		await runRemoteTurn(prompt);
		expect(calls('remote_turn_error')).toEqual([
			{ turnId: prompt.turnId, message: 'model is not running' }
		]);
		expect(calls('remote_turn_done')).toHaveLength(0);
	});

	it('cancelling an unknown turn is a no-op, not a throw', () => {
		expect(() => cancelRemoteTurn('nobody#9')).not.toThrow();
	});

	it('survives a client that vanished mid-stream', async () => {
		mocks.invoke.mockImplementation(async (command: string) => {
			if (command === 'remote_turn_delta') throw new Error('gone');
		});
		mocks.runEphemeralTurn.mockImplementationOnce(async (options: EphemeralTurnOptions) => {
			options.onAssistantDelta?.('text');
			await new Promise((resolve) => setTimeout(resolve, 0));
			return { finalText: 'text', rawText: 'text' };
		});
		await expect(runRemoteTurn(prompt)).resolves.toBeUndefined();
	});
});
