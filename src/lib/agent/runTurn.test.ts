import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentLoopOptions } from '#lib/agent/loop.ts';
import { ApiError, ResponseCutOffError } from '#lib/api.ts';

const loop = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('#lib/agent/loop.ts', () => ({ runAgentLoop: loop.run }));

import { runTurnCore } from './runTurn';

/** A loop that streams `text`, completes, then reports `error`. */
function loopThat(text: string, error: Error) {
	loop.run.mockImplementation(async (o: AgentLoopOptions) => {
		o.onStreamChunk({ delta: { content: text }, finish_reason: 'length' });
		o.onComplete();
		o.onError(error);
	});
}

const turn = (keepCutOffAnswer?: boolean) =>
	runTurnCore({ messages: [] } as never, { finalize: (raw) => raw.trim(), keepCutOffAnswer });

beforeEach(() => {
	loop.run.mockReset();
});

describe('runTurnCore and a cut-off answer', () => {
	it('keeps the partial answer, and says why, when the caller asks', async () => {
		loopThat('Most of a report', new ResponseCutOffError('hit the 8192-token limit'));
		const out = await turn(true);
		expect(out.finalText).toBe('Most of a report');
		expect(out.cutOff).toBe('hit the 8192-token limit');
	});

	it('still throws when the caller did not ask', async () => {
		loopThat('Most of a report', new ResponseCutOffError('cut off'));
		await expect(turn()).rejects.toBeInstanceOf(ResponseCutOffError);
	});

	it('still throws any other failure, and a cut-off with nothing written', async () => {
		loopThat('partial', new ApiError('Server error: 500'));
		await expect(turn(true)).rejects.toThrow('Server error: 500');
		loopThat('   ', new ResponseCutOffError('cut off'));
		await expect(turn(true)).rejects.toBeInstanceOf(ResponseCutOffError);
	});
});
