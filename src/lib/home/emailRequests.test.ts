import { describe, expect, it } from 'vitest';
import { watchLine } from './emailRequests';

describe('watchLine', () => {
	it('says nothing without a watcher, and flags only a failing one', () => {
		expect(watchLine(null)).toBeNull();
		expect(watchLine({ state: 'idle' })).toMatchObject({
			text: 'Watching the inbox.',
			problem: false
		});
		expect(watchLine({ state: 'polling' })?.text).toMatch(/every 2 minutes/);
		expect(watchLine({ state: 'retrying', reason: 'LOGIN on imap.x failed' })).toEqual({
			text: "Can't reach the inbox. Trying again.",
			detail: 'LOGIN on imap.x failed',
			problem: true
		});
	});
});
