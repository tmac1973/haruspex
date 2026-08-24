import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	extractMemories: vi.fn(async () => ({ added: 0, deduped: 0 })),
	memoryActive: vi.fn(() => true)
}));

vi.mock('./extraction', () => ({ extractMemories: mocks.extractMemories }));
vi.mock('$lib/debug-log', () => ({ logDebug: vi.fn() }));
vi.mock('$lib/stores/memory.svelte', () => ({ memoryActive: mocks.memoryActive }));

import {
	__resetSchedulerForTests,
	cancelAllExtraction,
	noteConversationLeft,
	noteTurnFinished
} from './scheduler';

/**
 * Let the single-flight queue drain. Under fake timers a bare `setTimeout(0)`
 * never fires, so advance-by-zero is what flushes both the timer queue and the
 * pending microtasks.
 */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	mocks.memoryActive.mockReturnValue(true);
	__resetSchedulerForTests();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('idle trigger', () => {
	it('extracts once the conversation has been still for the idle delay', async () => {
		noteTurnFinished('conv-1');
		expect(mocks.extractMemories).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(120_000);
		expect(mocks.extractMemories).toHaveBeenCalledWith('conv-1');
	});

	/**
	 * A back-and-forth exchange should be distilled once when it settles, not
	 * once per turn — each turn restarts the countdown.
	 */
	it('restarts the countdown on every turn', async () => {
		noteTurnFinished('conv-1');
		await vi.advanceTimersByTimeAsync(90_000);
		noteTurnFinished('conv-1');
		await vi.advanceTimersByTimeAsync(90_000);
		expect(mocks.extractMemories).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.extractMemories).toHaveBeenCalledTimes(1);
	});

	it('tracks conversations independently', async () => {
		noteTurnFinished('conv-1');
		await vi.advanceTimersByTimeAsync(60_000);
		noteTurnFinished('conv-2');
		await vi.advanceTimersByTimeAsync(60_000);

		expect(mocks.extractMemories).toHaveBeenCalledWith('conv-1');
		expect(mocks.extractMemories).not.toHaveBeenCalledWith('conv-2');
	});

	it('does not arm a timer while memory is off', async () => {
		mocks.memoryActive.mockReturnValue(false);
		noteTurnFinished('conv-1');
		await vi.advanceTimersByTimeAsync(300_000);
		expect(mocks.extractMemories).not.toHaveBeenCalled();
	});
});

describe('chat-switch trigger', () => {
	it('extracts the conversation just left, immediately', async () => {
		noteConversationLeft('conv-1');
		await settle();
		expect(mocks.extractMemories).toHaveBeenCalledWith('conv-1');
	});

	it('cancels the pending idle timer for that conversation', async () => {
		// Same work, happening sooner — it must not then run a second time.
		noteTurnFinished('conv-1');
		noteConversationLeft('conv-1');
		await settle();
		await vi.advanceTimersByTimeAsync(300_000);
		expect(mocks.extractMemories).toHaveBeenCalledTimes(1);
	});

	it('ignores a null conversation', async () => {
		noteConversationLeft(null);
		await settle();
		expect(mocks.extractMemories).not.toHaveBeenCalled();
	});
});

describe('single-flight queue', () => {
	it('runs one pass at a time', async () => {
		// Extraction holds an inference slot; several at once on a one-slot
		// local server is the app going quiet.
		let release: (() => void) | undefined;
		mocks.extractMemories.mockImplementationOnce(
			() => new Promise((r) => (release = () => r({ added: 0, deduped: 0 })))
		);

		noteConversationLeft('conv-1');
		noteConversationLeft('conv-2');
		await settle();
		expect(mocks.extractMemories).toHaveBeenCalledTimes(1);

		release?.();
		await settle();
		expect(mocks.extractMemories).toHaveBeenCalledTimes(2);
	});

	it('does not queue the same conversation twice', async () => {
		// A pass reads whatever is unextracted when it runs, so a second entry
		// would be one real pass and one no-op.
		let release: (() => void) | undefined;
		mocks.extractMemories.mockImplementationOnce(
			() => new Promise((r) => (release = () => r({ added: 0, deduped: 0 })))
		);

		noteConversationLeft('conv-1');
		noteConversationLeft('conv-2');
		noteConversationLeft('conv-2');
		await settle();
		release?.();
		await settle();

		expect(mocks.extractMemories).toHaveBeenCalledTimes(2);
	});

	it('keeps draining after a pass throws', async () => {
		mocks.extractMemories.mockRejectedValueOnce(new Error('boom'));
		noteConversationLeft('conv-1');
		noteConversationLeft('conv-2');
		await settle();
		await settle();
		expect(mocks.extractMemories).toHaveBeenCalledWith('conv-2');
	});

	it('abandons the backlog when memory is switched off mid-drain', async () => {
		let release: (() => void) | undefined;
		mocks.extractMemories.mockImplementationOnce(
			() => new Promise((r) => (release = () => r({ added: 0, deduped: 0 })))
		);

		noteConversationLeft('conv-1');
		noteConversationLeft('conv-2');
		await settle();
		mocks.memoryActive.mockReturnValue(false);
		release?.();
		await settle();

		expect(mocks.extractMemories).toHaveBeenCalledTimes(1);
	});
});

describe('cancelAllExtraction', () => {
	/**
	 * Switching memory off must not leave a timer armed from when it was on —
	 * that would record from a chat the user has since decided should not be
	 * remembered.
	 */
	it('disarms pending idle timers', async () => {
		noteTurnFinished('conv-1');
		cancelAllExtraction();
		await vi.advanceTimersByTimeAsync(300_000);
		expect(mocks.extractMemories).not.toHaveBeenCalled();
	});
});
