import { describe, expect, it, vi } from 'vitest';

const call = vi.hoisted(() => ({
	callSpecialist: vi.fn(async () => ({ content: '<think>hmm</think>\n^\\d{4}-\\d{2}-\\d{2}$' })),
	callOptionsFrom: vi.fn(() => ({ inTurn: true }))
}));
vi.mock('#lib/specialists/call.ts', () => call);

import { specialistKind } from '#lib/specialists/kinds.ts';
import { MAX_ANSWER_CHARS, textAnswer } from './text';

describe('the text kind', () => {
	it('returns the answer without its thinking', async () => {
		const images = [{ path: 'a.png', dataUrl: 'data:image/png;base64,AA' }];
		const out = await specialistKind('text')!.run({
			entry: {} as never,
			request: 'A regex for ISO dates',
			images,
			args: {},
			ctx: { workingDir: null } as never
		});
		expect(out.result).toBe('^\\d{4}-\\d{2}-\\d{2}$');
		expect(call.callSpecialist).toHaveBeenCalledWith({}, 'A regex for ISO dates', {
			inTurn: true,
			images
		});
	});

	it('cuts a long answer and says so', () => {
		const long = 'x'.repeat(MAX_ANSWER_CHARS + 10);
		const out = textAnswer(long);
		expect(out.startsWith('x'.repeat(MAX_ANSWER_CHARS))).toBe(true);
		expect(out).toMatch(/\(answer cut at 24,000 characters\)$/);
		expect(textAnswer('short')).toBe('short');
	});
});
