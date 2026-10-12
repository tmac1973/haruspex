import { describe, expect, it } from 'vitest';
import { formatBytes, formatContextSize, formatGigabytes } from './format';

describe('formatContextSize', () => {
	it.each([
		[262144, '256K'],
		[8192, '8K'],
		[37888, '37K'],
		[1024, '1K'],
		[512, '512']
	])('%i → %s', (n, out) => {
		expect(formatContextSize(n)).toBe(out);
	});
});

describe('formatBytes', () => {
	it.each([
		[812, '812 B'],
		[4300, '4.2 KB'],
		[1.3 * 1024 * 1024, '1.3 MB'],
		[2 * 1024 ** 3, '2.00 GB']
	])('%d → %s', (n, out) => {
		expect(formatBytes(n)).toBe(out);
	});
});

describe('formatGigabytes', () => {
	it('uses decimal gigabytes, as model hosts do', () => {
		expect(formatGigabytes(5_700_000_000)).toBe('5.7 GB');
	});
});
