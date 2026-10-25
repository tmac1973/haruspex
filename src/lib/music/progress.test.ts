import { describe, it, expect } from 'vitest';
import { describeMusicProgress } from './progress';

describe('describeMusicProgress', () => {
	it('names the stage and keeps the clock moving', () => {
		expect(describeMusicProgress(null, 0)).toBe('Generating… 0 s');
		expect(describeMusicProgress({ phase: 'queued', ahead: 2 }, 3)).toBe('Queued (2 ahead)… 3 s');
		expect(describeMusicProgress({ phase: 'queued' }, 3)).toBe('Queued… 3 s');
		expect(describeMusicProgress({ phase: 'composing' }, 8)).toBe('Composing… 8 s');
		expect(describeMusicProgress({ phase: 'synthesizing' }, 20)).toBe('Synthesizing… 20 s');
	});
});
