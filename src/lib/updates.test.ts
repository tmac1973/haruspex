import { describe, it, expect } from 'vitest';
import { compareVersions } from '$lib/updates';

describe('compareVersions', () => {
	it('returns 0 for equal versions', () => {
		expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
	});

	it('strips a leading v', () => {
		expect(compareVersions('v0.1.30', '0.1.30')).toBe(0);
	});

	it('treats missing components as zero', () => {
		expect(compareVersions('1.2', '1.2.0')).toBe(0);
	});

	it('detects newer patch', () => {
		expect(compareVersions('0.1.31', '0.1.30')).toBeGreaterThan(0);
	});

	it('detects newer minor', () => {
		expect(compareVersions('0.2.0', '0.1.99')).toBeGreaterThan(0);
	});

	it('detects older major', () => {
		expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
	});

	it('strips pre-release suffixes', () => {
		expect(compareVersions('1.2.3-rc.1', '1.2.3')).toBe(0);
	});
});
