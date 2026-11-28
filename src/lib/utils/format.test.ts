import { describe, expect, it } from 'vitest';
import {
	formatBytes,
	formatContextSize,
	formatGigabytes,
	formatShortWhen,
	formatTokens,
	plural,
	titleFromText
} from './format';

describe('formatShortWhen', () => {
	const now = new Date(2026, 10, 27, 15, 0);
	it('shows the time for today', () => {
		const ms = new Date(2026, 10, 27, 9, 5).getTime();
		expect(formatShortWhen(ms, now)).toBe(
			new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
		);
	});
	it('shows month and day for another day', () => {
		const ms = new Date(2026, 10, 26, 23, 59).getTime();
		expect(formatShortWhen(ms, now)).toBe(
			new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
		);
	});
});

describe('titleFromText', () => {
	it('takes the first five words, capitalised', () => {
		expect(titleFromText('a slow walk, by the sea at night')).toBe('A Slow Walk By The');
	});
	it('drops brackets and full stops', () => {
		expect(titleFromText('[verse] rain. on (soft) glass')).toBe('Verse Rain On Soft Glass');
	});
	it('falls back when there are no words', () => {
		expect(titleFromText(' , . ', 'Clip')).toBe('Clip');
		expect(titleFromText('')).toBe('');
	});
});

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

describe('plural', () => {
	it('adds an s unless told the plural', () => {
		expect(plural(1, 'clip')).toBe('1 clip');
		expect(plural(2, 'clip')).toBe('2 clips');
		expect(plural(0, 'was', 'were')).toBe('0 were');
	});
});

describe('formatTokens', () => {
	it.each([
		[950, '950'],
		[1000, '1K'],
		[1234, '1.2K'],
		[48_200, '48K'],
		[262_144, '262K'],
		[4_100_000, '4.1M'],
		[12_000_000, '12M']
	])('%i → %s', (n, out) => {
		expect(formatTokens(n)).toBe(out);
	});
});
