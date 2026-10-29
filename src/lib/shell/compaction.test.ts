import { describe, it, expect } from 'vitest';
import { compactionAfterTrim, shellModelThread } from './compaction';
import type { ChatMessage } from '#lib/api.ts';

const summary = { at: 4, summary: 'Backups taken.', summarizedAt: 1 };

describe('shellModelThread', () => {
	const thread: ChatMessage[] = [
		{ role: 'user', content: 'a' },
		{ role: 'assistant', content: 'b' },
		{ role: 'user', content: 'c' },
		{ role: 'assistant', content: 'd' },
		{ role: 'user', content: 'e' }
	];

	it('is the thread itself before any summary', () => {
		expect(shellModelThread(thread, null)).toBe(thread);
	});

	it('is the summary, then what follows it', () => {
		const view = shellModelThread(thread, summary);
		expect(view).toHaveLength(2);
		expect(view[0].role).toBe('system');
		expect(view[0].content).toMatch(/check its state again[\s\S]*Backups taken\.$/);
		expect(view[1]).toBe(thread[4]);
	});
});

describe('compactionAfterTrim', () => {
	it('moves the cut back by what was dropped, past the trim note', () => {
		expect(compactionAfterTrim(summary, 2)?.at).toBe(3);
	});

	it('starts after the note when the trim dropped past the cut', () => {
		expect(compactionAfterTrim(summary, 6)?.at).toBe(1);
	});

	it('is null without a summary', () => {
		expect(compactionAfterTrim(null, 6)).toBeNull();
	});
});
