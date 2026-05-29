import { describe, it, expect } from 'vitest';
import { truncateCapturedOutput } from './truncate';

describe('truncateCapturedOutput', () => {
	it('returns the input unchanged when under the cap', () => {
		const result = truncateCapturedOutput('hello world', 1024);
		expect(result.truncated).toBe(false);
		expect(result.text).toBe('hello world');
		expect(result.originalBytes).toBe(11);
	});

	it('returns the input unchanged when cap is 0 (disabled)', () => {
		const big = 'x'.repeat(100_000);
		const result = truncateCapturedOutput(big, 0);
		expect(result.truncated).toBe(false);
		expect(result.text.length).toBe(100_000);
	});

	it('returns the input unchanged when cap is negative', () => {
		const result = truncateCapturedOutput('hello', -1);
		expect(result.truncated).toBe(false);
	});

	it('truncates when over the cap and leaves a marker', () => {
		const big = 'x'.repeat(100_000);
		const result = truncateCapturedOutput(big, 8192);
		expect(result.truncated).toBe(true);
		expect(result.originalBytes).toBe(100_000);
		expect(result.text).toContain('middle truncated');
		// Marker should mention the original size in some unit.
		expect(result.text).toMatch(/\d+(\.\d+)?\s*(B|KiB|MiB)\s+total/);
		// Marker should be present once.
		const markerCount = (result.text.match(/middle truncated/g) ?? []).length;
		expect(markerCount).toBe(1);
	});

	it('keeps head and tail bytes when truncating', () => {
		// Pad start and end with recognizable markers; middle with junk.
		const head = 'HEADLINE\n'.repeat(100);
		const tail = 'TAILLINE\n'.repeat(100);
		const middle = 'x'.repeat(50_000);
		const input = `${head}${middle}${tail}`;
		const result = truncateCapturedOutput(input, 4096);
		expect(result.truncated).toBe(true);
		expect(result.text.startsWith('HEADLINE')).toBe(true);
		expect(result.text.trimEnd().endsWith('TAILLINE')).toBe(true);
	});

	it('snaps head and tail cuts to nearest newline when one is close', () => {
		// Lines of fixed length so we can predict snap points.
		const line = 'A'.repeat(60) + '\n';
		const input = line.repeat(2000);
		const result = truncateCapturedOutput(input, 4096);
		expect(result.truncated).toBe(true);
		// Look only at lines made entirely of 'A's (skip the marker text).
		const aLines = result.text.split('\n').filter((l) => /^A+$/.test(l));
		expect(aLines.length).toBeGreaterThan(0);
		for (const l of aLines) {
			expect(l.length).toBe(60);
		}
	});

	it('uses UTF-8 byte length, not char count', () => {
		// Two-byte UTF-8 chars (é) — 1024 chars is 2048 bytes.
		const input = 'é'.repeat(1024);
		const result = truncateCapturedOutput(input, 1500);
		expect(result.truncated).toBe(true);
		expect(result.originalBytes).toBe(2048);
	});

	it('the marker tells the model how big the original was', () => {
		const input = 'x'.repeat(500_000);
		const result = truncateCapturedOutput(input, 8192);
		// Should mention KiB or MiB units for human-readable sizes.
		expect(result.text).toMatch(/KiB|MiB|B/);
	});
});
