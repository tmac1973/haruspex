import { describe, it, expect } from 'vitest';
import { remapIndexedRecords } from './compaction';

describe('remapIndexedRecords', () => {
	const msgs = ['m0', 'm1', 'm2', 'm3', 'm4'].map((c) => ({ content: c }));

	it('moves surviving entries to the new indices', () => {
		// Compaction shape: summary inserted at 0, last messages kept.
		const newMessages = [{ content: 'summary' }, msgs[3], msgs[4]];
		const records = { 3: 'steps-for-m3', 4: 'steps-for-m4' };
		expect(remapIndexedRecords(msgs, newMessages, records)).toEqual({
			1: 'steps-for-m3',
			2: 'steps-for-m4'
		});
	});

	it('drops entries for summarized-away messages', () => {
		const newMessages = [{ content: 'summary' }, msgs[4]];
		const records = { 0: 'gone', 1: 'gone', 4: 'kept' };
		expect(remapIndexedRecords(msgs, newMessages, records)).toEqual({ 1: 'kept' });
	});

	it('keys nothing to the inserted summary message', () => {
		const newMessages = [{ content: 'summary' }, msgs[4]];
		const out = remapIndexedRecords(msgs, newMessages, { 0: 'x' });
		expect(out[0]).toBeUndefined();
	});

	it('is identity when the array is unchanged', () => {
		const records = { 1: 'a', 3: 'b' };
		expect(remapIndexedRecords(msgs, msgs, records)).toEqual(records);
	});
});
