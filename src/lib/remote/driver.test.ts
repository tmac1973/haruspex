import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	runEphemeralTurn: vi.fn(),
	withInferenceSlot: vi.fn(),
	resolveBackendDescriptor: vi.fn(),
	dbCreateConversation: vi.fn(),
	dbLoadMessages: vi.fn(),
	dbSaveMessage: vi.fn(),
	dbReplaceMessages: vi.fn(),
	noteExternalConversation: vi.fn()
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
vi.mock('$lib/stores/db', () => ({
	dbCreateConversation: mocks.dbCreateConversation,
	dbLoadMessages: mocks.dbLoadMessages,
	dbSaveMessage: mocks.dbSaveMessage,
	dbReplaceMessages: mocks.dbReplaceMessages
}));
vi.mock('$lib/stores/chat.svelte', () => ({
	noteExternalConversation: mocks.noteExternalConversation
}));

import {
	runRemoteTurn,
	cancelRemoteTurn,
	deliverAnswer,
	describeToolCall,
	REMOTE_TOOLS
} from '$lib/remote/driver';
import type { EphemeralTurnOptions } from '$lib/agent/runEphemeralTurn';

const prompt = { sessionId: 'guest1', turnId: 'guest1#0', message: 'what is a haruspex?' };

function saved(role: string) {
	return mocks.dbSaveMessage.mock.calls
		.filter(([, message]) => message.role === role)
		.map(([id, message]) => ({ id, content: message.content }));
}

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
	mocks.dbCreateConversation.mockReset().mockResolvedValue(undefined);
	mocks.dbLoadMessages.mockReset().mockResolvedValue([]);
	mocks.dbSaveMessage.mockReset().mockResolvedValue(undefined);
	mocks.dbReplaceMessages.mockReset().mockResolvedValue(undefined);
	mocks.noteExternalConversation.mockReset();
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
		expect([...REMOTE_TOOLS]).toEqual([
			'web_search',
			'fetch_url',
			'research_url',
			'ask_user_question'
		]);
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

describe('a guest’s conversation', () => {
	it('is a real conversation row the host can see', async () => {
		await runRemoteTurn({ ...prompt, clientLabel: 'Dave' });
		expect(mocks.dbCreateConversation).toHaveBeenCalledWith(
			'remote-guest1',
			'Dave: what is a haruspex?'
		);
		// And it shows up in the host's own sidebar rather than only after a
		// restart.
		expect(mocks.noteExternalConversation).toHaveBeenCalledWith(
			'remote-guest1',
			'Dave: what is a haruspex?'
		);
	});

	it('keeps two guests in two threads', async () => {
		await runRemoteTurn(prompt);
		await runRemoteTurn({ sessionId: 'guest2', turnId: 'guest2#0', message: 'and me?' });

		const ids = mocks.dbCreateConversation.mock.calls.map(([id]) => id);
		expect(new Set(ids)).toEqual(new Set(['remote-guest1', 'remote-guest2']));
		// Neither guest's message was written into the other's thread.
		expect(saved('user')).toEqual([
			{ id: 'remote-guest1', content: 'what is a haruspex?' },
			{ id: 'remote-guest2', content: 'and me?' }
		]);
	});

	it('carries earlier turns into the next one', async () => {
		const earlier = [
			{ role: 'user' as const, content: 'what is a haruspex?' },
			{ role: 'assistant' as const, content: 'a reader of entrails' }
		];
		mocks.dbLoadMessages.mockResolvedValue(earlier);

		await runRemoteTurn({ ...prompt, message: 'and where did they work?' });
		expect(turnOptions().history).toEqual(earlier);
	});

	it('persists both sides of the turn', async () => {
		await runRemoteTurn(prompt);
		expect(saved('user')).toEqual([{ id: 'remote-guest1', content: 'what is a haruspex?' }]);
		expect(saved('assistant')).toEqual([{ id: 'remote-guest1', content: 'an answer' }]);
	});

	it('keeps a stopped answer in the history, not just on screen', async () => {
		mocks.runEphemeralTurn.mockImplementationOnce(async (options: EphemeralTurnOptions) => {
			options.onAssistantDelta?.('half an ans');
			cancelRemoteTurn(prompt.turnId);
			throw new Error('aborted');
		});
		await runRemoteTurn(prompt);
		// A history that omitted it would make the next turn incoherent.
		expect(saved('assistant')).toEqual([{ id: 'remote-guest1', content: 'half an ans' }]);
	});

	it('records nothing for an answer that never started', async () => {
		mocks.runEphemeralTurn.mockRejectedValueOnce(new Error('model is not running'));
		await runRemoteTurn(prompt);
		expect(saved('assistant')).toEqual([]);
	});
});

describe('showing the guest what the turn is doing', () => {
	it('describes a tool call in words, not in tool names', () => {
		expect(describeToolCall({ id: '1', name: 'web_search', arguments: { query: 'monkeys' } })).toBe(
			'Searching the web for “monkeys”'
		);
		expect(
			describeToolCall({ id: '2', name: 'fetch_url', arguments: { url: 'https://a.example/b' } })
		).toBe('Reading a.example');
		expect(
			describeToolCall({ id: '3', name: 'research_url', arguments: { url: 'not a url' } })
		).toBe('Researching a page');
		// Never leaks an internal name to someone who has never heard of a tool.
		expect(describeToolCall({ id: '4', name: 'something_new', arguments: {} })).toBe('Working');
	});

	it('reports each call starting and finishing', async () => {
		const call = { id: 'c1', name: 'web_search', arguments: { query: 'monkeys' } };
		mocks.runEphemeralTurn.mockImplementationOnce(async (options: EphemeralTurnOptions) => {
			options.onToolStart?.(call);
			options.onToolEnd?.(call, 'ten results');
			return { finalText: 'done', rawText: 'done' };
		});
		await runRemoteTurn(prompt);

		expect(calls('remote_turn_step')).toEqual([
			{ turnId: prompt.turnId, step: { id: 'c1', label: expect.any(String), status: 'running' } },
			{ turnId: prompt.turnId, step: { id: 'c1', label: expect.any(String), status: 'done' } }
		]);
	});

	it('marks a failed call as failed', async () => {
		const call = { id: 'c1', name: 'fetch_url', arguments: { url: 'https://a.example' } };
		mocks.runEphemeralTurn.mockImplementationOnce(async (options: EphemeralTurnOptions) => {
			options.onToolStart?.(call);
			options.onToolEnd?.(call, 'Error: could not reach the site');
			return { finalText: 'done', rawText: 'done' };
		});
		await runRemoteTurn(prompt);
		expect(calls('remote_turn_step').at(-1)!.step.status).toBe('failed');
	});
});

describe('asking the guest a question', () => {
	async function askDuringTurn(answer: (questionId: string) => void) {
		mocks.runEphemeralTurn.mockImplementationOnce(async (options: EphemeralTurnOptions) => {
			const asked = options.askUser!(
				{ question: 'Five of what?', options: [{ label: 'Fingers' }] },
				undefined
			);
			// The question is in flight; answer it the way the server would.
			await vi.waitFor(() => expect(calls('remote_turn_question')).toHaveLength(1));
			answer(calls('remote_turn_question')[0].question.id);
			return { finalText: `answered: ${JSON.stringify(await asked)}`, rawText: '' };
		});
		await runRemoteTurn(prompt);
	}

	it('sends the question to the guest and waits for their reply', async () => {
		await askDuringTurn((questionId) =>
			deliverAnswer({ turnId: prompt.turnId, questionId, labels: ['Fingers'] })
		);
		// It went to the guest — not to a modal on the host's screen, which they
		// could not see and would not understand.
		const asked = calls('remote_turn_question')[0].question;
		expect(asked.question).toBe('Five of what?');
		expect(asked.options).toEqual([{ label: 'Fingers' }]);
		expect(calls('remote_turn_done')[0].text).toContain('"labels":["Fingers"]');
		// And the question is taken down afterwards.
		expect(calls('remote_turn_question_cleared')).toHaveLength(1);
	});

	it('accepts an answer that was not one of the options', async () => {
		await askDuringTurn((questionId) =>
			deliverAnswer({ turnId: prompt.turnId, questionId, text: 'a high five!' })
		);
		expect(calls('remote_turn_done')[0].text).toContain('a high five!');
	});

	it('ignores an answer to a question nobody is waiting on', () => {
		// A double tap, or a stale tab.
		expect(() =>
			deliverAnswer({ turnId: 't', questionId: 'never-asked', labels: ['x'] })
		).not.toThrow();
	});

	it('gives up on an unanswered question rather than holding the slot', async () => {
		vi.useFakeTimers();
		try {
			let resolved: unknown = null;
			mocks.runEphemeralTurn.mockImplementationOnce(async (options: EphemeralTurnOptions) => {
				const asked = options.askUser!({ question: 'Five of what?', options: [] }, undefined).then(
					(answer) => (resolved = answer)
				);
				await vi.advanceTimersByTimeAsync(3 * 60_000 + 1000);
				await asked;
				return { finalText: 'carried on', rawText: '' };
			});
			await runRemoteTurn(prompt);

			// The turn holds an inference slot while parked, so a guest who
			// wanders off must not reserve the host's GPU indefinitely.
			expect(resolved).toEqual({
				kind: 'freeText',
				text: 'No answer — please continue with your best judgement.'
			});
			expect(calls('remote_turn_done')[0].text).toBe('carried on');
		} finally {
			vi.useRealTimers();
		}
	});
});
