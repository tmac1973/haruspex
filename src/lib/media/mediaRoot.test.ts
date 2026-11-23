import { describe, it, expect } from 'vitest';
import { cannotPlay } from './mediaRoot';

describe('a video that will not play', () => {
	it('names the file it could not play', () => {
		expect(cannotPlay('a.webm')).toContain('Could not play a.webm');
	});
});
