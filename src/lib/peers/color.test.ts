import { describe, it, expect } from 'vitest';
import { peerColor, peerHue } from './color.ts';

describe("a computer's colour", () => {
	it('is the same every time for one computer, and differs between computers', () => {
		const a = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
		const b = '11111111-2222-3333-4444-555555555555';
		expect(peerColor(a)).toBe(peerColor(a));
		expect(peerHue(a)).not.toBe(peerHue(b));
		expect(peerHue(a)).toBeGreaterThanOrEqual(0);
		expect(peerHue(a)).toBeLessThan(360);
		expect(peerColor(a)).toMatch(/^hsl\(\d+ 60% 52%\)$/);
	});
});
