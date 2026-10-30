import { describe, it, expect, vi, beforeEach } from 'vitest';

const lean = vi.hoisted(() => ({ on: false }));

vi.mock('#lib/stores/settings.ts', () => ({
	getLiveSettings: () => ({ leanMode: lean.on })
}));

import { pausedByLean } from './lean';

describe('pausedByLean', () => {
	beforeEach(() => (lean.on = false));

	it('pauses nothing with lean mode off', () => {
		expect(pausedByLean('research')).toBe(false);
		expect(pausedByLean('audit')).toBe(false);
	});

	it('pauses every type but research with lean mode on', () => {
		lean.on = true;
		expect(pausedByLean('research')).toBe(false);
		for (const id of ['audit', 'guided_planning', 'autonomous_coding', 'asset_generation']) {
			expect(pausedByLean(id)).toBe(true);
		}
	});
});
