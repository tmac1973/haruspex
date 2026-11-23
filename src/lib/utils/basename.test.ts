import { describe, expect, it } from 'vitest';
import { basename } from './basename';

describe('basename', () => {
	it('takes the last part of either kind of path', () => {
		expect(basename('a/b/c.txt')).toBe('c.txt');
		expect(basename('C:\\Users\\tim\\c.txt')).toBe('c.txt');
		expect(basename('c.txt')).toBe('c.txt');
	});

	it('is empty for a path ending in a separator', () => {
		expect(basename('a/b/')).toBe('');
	});
});
