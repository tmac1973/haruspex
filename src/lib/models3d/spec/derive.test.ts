import { describe, it, expect } from 'vitest';
import { derivePlanModelSpec } from './derive';
import { validateModelSpec } from './validate';

describe('derivePlanModelSpec', () => {
	it('keeps the plan’s ids and gives each its folder', () => {
		const { spec, rejected } = derivePlanModelSpec({
			style: ' low-poly ',
			entries: [
				{
					id: 'goblin',
					title: 'Goblin',
					description: 'Green.',
					height_m: 1.1,
					parts: ['Hip_L'],
					clips: [{ name: 'Walk', seconds: 1, action: 'walks' }]
				}
			]
		});
		expect(rejected).toEqual([]);
		expect(spec.style).toBe('low-poly');
		expect(spec.entries[0]).toMatchObject({ id: 'goblin', dir: 'assets/generated/model/goblin/' });
		// A clip named Walk loops unless told otherwise.
		expect(spec.entries[0].clips[0].loop).toBe(true);
		expect(validateModelSpec(spec)).toEqual([]);
	});

	it('rejects an id it would have to change, and a duplicate, rather than tidying', () => {
		const entry = { title: 'X', description: 'x', height_m: 1 };
		const { spec, rejected } = derivePlanModelSpec({
			entries: [
				{ ...entry, id: 'Big Crate' },
				{ ...entry, id: 'crate' },
				{ ...entry, id: 'crate' },
				entry
			]
		});
		expect(spec.entries.map((e) => e.id)).toEqual(['crate']);
		expect(rejected).toEqual(['Big Crate', 'crate', '(an entry with no id)']);
	});

	it('reads anything but a list of entries as none', () => {
		expect(derivePlanModelSpec({ entries: '[{"id":"a"}]' }).spec.entries).toEqual([]);
	});
});
