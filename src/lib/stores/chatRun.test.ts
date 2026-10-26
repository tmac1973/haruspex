import { describe, it, expect } from 'vitest';
import { ChatRun } from '#lib/stores/chatRun.svelte.ts';

describe('ChatRun', () => {
	it('begins a turn with a fresh stream and no error', () => {
		const run = new ChatRun();
		run.fail('boom', 3);
		run.streamingContent = 'old';

		run.begin(4);

		expect(run.generating).toBe(true);
		expect(run.busy).toBe(true);
		expect(run.streamingContent).toBe('');
		expect(run.errorMessage).toBeNull();
		expect(run.lastTurnFailed).toBe(false);
		expect(run.currentTurnId).toBe(4);
	});

	it("does not let a replaced turn's end clear the new turn", () => {
		const run = new ChatRun();
		const first = run.begin(1);
		run.cancel();
		const second = run.begin(2);
		run.streamingContent = 'new turn';

		run.end(first);
		expect(run.generating).toBe(true);
		expect(run.streamingContent).toBe('new turn');

		run.end(second);
		expect(run.generating).toBe(false);
		expect(run.busy).toBe(false);
	});

	it('cancelling a send queued for startup leaves it to retry', () => {
		const run = new ChatRun();
		run.queuedForStartup = true;

		run.cancel();

		expect(run.queuedForStartup).toBe(false);
		expect(run.lastTurnFailed).toBe(true);
		expect(run.errorMessage).toBe('Cancelled before the model started.');
	});

	it('cancelling a running turn aborts it', () => {
		const run = new ChatRun();
		const signal = run.begin(1);

		run.cancel();

		expect(signal.aborted).toBe(true);
		expect(run.generating).toBe(false);
	});
});
