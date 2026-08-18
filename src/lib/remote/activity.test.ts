import { describe, it, expect, beforeEach } from 'vitest';

import {
	forgetRemoteActivity,
	getActiveRemoteCount,
	getRemoteActivity,
	noteAdmitted,
	noteAnswer,
	noteFinished,
	notePrompt
} from '$lib/remote/activity.svelte';

beforeEach(() => forgetRemoteActivity());

describe('what the host can see of their guests', () => {
	it('shows a turn arriving and marks it done when it ends', () => {
		notePrompt('s1', 'Dave', 'what is a haruspex?');
		expect(getRemoteActivity()[0]).toMatchObject({
			label: 'Dave',
			prompt: 'what is a haruspex?',
			state: 'waiting'
		});
		expect(getActiveRemoteCount()).toBe(1);

		noteAnswer('s1', 'a reader');
		expect(getRemoteActivity()[0]).toMatchObject({ answer: 'a reader', state: 'answering' });

		noteFinished('s1', 'done', 'a reader of entrails');
		expect(getRemoteActivity()[0]).toMatchObject({
			answer: 'a reader of entrails',
			state: 'done'
		});
		// Still listed — the host can see what was last asked — but no longer
		// counted as something happening now.
		expect(getActiveRemoteCount()).toBe(0);
	});

	it('separates queued from thinking', () => {
		// Folding these together is what made the panel say "waiting for a
		// slot" for the whole of a reasoning model's turn, then jump straight
		// to idle when the answer landed.
		notePrompt('s1', 'Dave', 'why?');
		expect(getRemoteActivity()[0].state).toBe('waiting');

		noteAdmitted('s1');
		expect(getRemoteActivity()[0].state).toBe('thinking');
		expect(getActiveRemoteCount()).toBe(1);

		noteAnswer('s1', 'because');
		expect(getRemoteActivity()[0].state).toBe('answering');
	});

	it('does not resurrect a finished turn when admission arrives late', () => {
		notePrompt('s1', 'Dave', 'why?');
		noteFinished('s1', 'done', 'because');
		noteAdmitted('s1');
		expect(getRemoteActivity()[0].state).toBe('done');
	});

	it('keeps guests apart', () => {
		notePrompt('s1', 'Dave', 'first');
		notePrompt('s2', null, 'second');
		noteAnswer('s1', 'to Dave');

		const [dave, other] = getRemoteActivity();
		expect(dave.answer).toBe('to Dave');
		expect(other.answer).toBe('');
		expect(other.label).toBeNull();
	});

	it('replaces the previous turn when the same guest asks again', () => {
		notePrompt('s1', 'Dave', 'first');
		noteFinished('s1', 'done', 'first answer');
		notePrompt('s1', 'Dave', 'second');

		expect(getRemoteActivity()).toHaveLength(1);
		expect(getRemoteActivity()[0]).toMatchObject({
			prompt: 'second',
			answer: '',
			state: 'waiting'
		});
	});

	it('does not grow without limit on a long answer', () => {
		notePrompt('s1', 'Dave', 'write me an essay');
		noteAnswer('s1', 'x'.repeat(10_000));
		const { answer } = getRemoteActivity()[0];
		expect(answer.length).toBeLessThanOrEqual(2000);
		// The end, not the beginning: the host is watching it arrive.
		expect(answer.endsWith('x')).toBe(true);
	});

	it('forgets one guest, or all of them', () => {
		notePrompt('s1', 'Dave', 'a');
		notePrompt('s2', 'Sam', 'b');

		forgetRemoteActivity('s1');
		expect(getRemoteActivity().map((a) => a.sessionId)).toEqual(['s2']);

		forgetRemoteActivity();
		expect(getRemoteActivity()).toEqual([]);
	});

	it('ignores updates for a guest who is already gone', () => {
		// A disconnect can land while a turn is still unwinding.
		expect(() => noteAnswer('vanished', 'text')).not.toThrow();
		expect(() => noteFinished('vanished', 'failed', 'oh dear')).not.toThrow();
		expect(getRemoteActivity()).toEqual([]);
	});
});
