import { describe, expect, it } from 'vitest';
import type { Prompt } from '#lib/engine/types.ts';
import { sessionsNeedingAttention } from './needsAttention';

function prompt(over: Partial<Prompt>): Prompt {
	return {
		promptId: 'main:1',
		kind: 'command',
		sessionId: null,
		answerable: true,
		requester: null,
		detail: {},
		...over
	};
}

describe('sessionsNeedingAttention', () => {
	it('marks the session a command approval or a question is for', () => {
		const ids = sessionsNeedingAttention([
			prompt({ kind: 'command', sessionId: 's1' }),
			prompt({ kind: 'question', sessionId: 's2' })
		]);
		expect([...ids].sort()).toEqual(['s1', 's2']);
	});

	it('marks nothing for a job, a chat or a file-exists prompt', () => {
		const ids = sessionsNeedingAttention([
			prompt({ kind: 'question', sessionId: null, runId: 4 }),
			prompt({ kind: 'sandbox', sessionId: null, chatId: 'c1' }),
			prompt({ kind: 'file-conflict', sessionId: null })
		]);
		expect(ids.size).toBe(0);
	});
});
