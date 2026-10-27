import { describe, it, expect } from 'vitest';
import { contextResponseFloor } from './context';

describe('contextResponseFloor', () => {
	it('is an eighth of the window', () => {
		expect(contextResponseFloor(32_768)).toBe(4_096);
		expect(contextResponseFloor(65_536)).toBe(8_192);
		expect(contextResponseFloor(100_001)).toBe(12_500);
	});

	it('stops growing at 32K', () => {
		expect(contextResponseFloor(262_144)).toBe(32_768);
		expect(contextResponseFloor(1_000_000)).toBe(32_768);
	});

	it('is nothing for an unknown window', () => {
		expect(contextResponseFloor(0)).toBe(0);
		expect(contextResponseFloor(-1)).toBe(0);
	});
});
