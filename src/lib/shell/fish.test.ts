import { describe, it, expect } from 'vitest';
import { isFish } from '#lib/shell/fish.ts';

describe('isFish', () => {
	it('matches fish by name or path', () => {
		expect(isFish({ shellName: 'fish' })).toBe(true);
		expect(isFish({ shellPath: '/usr/bin/fish' })).toBe(true);
		expect(isFish({ shellPath: '/bin/fish', shellName: null })).toBe(true);
	});

	it('does not match other shells or lookalike names', () => {
		expect(isFish({ shellName: 'bash', shellPath: '/bin/bash' })).toBe(false);
		expect(isFish({ shellPath: '/usr/bin/catfish' })).toBe(false);
		expect(isFish({ shellPath: '/opt/fish/bin/zsh' })).toBe(false);
		expect(isFish({})).toBe(false);
	});
});
