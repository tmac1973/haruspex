import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpecialistEntry } from './types';

const store = vi.hoisted(() => ({ specialists: [] as unknown[] }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => store
	})
);

import '#lib/specialists/kinds/index.ts';
import { newSpecialistEntry } from './entries';
import { sessionSpecialists } from './session';

function entry(id: string, onByDefault = false): SpecialistEntry {
	return { ...newSpecialistEntry('text', []), id, name: id, onByDefault };
}

const names = (list: SpecialistEntry[]) => list.map((e) => e.name);

beforeEach(() => {
	store.specialists = [entry('a', true), entry('b'), entry('c', true)];
});

describe('sessionSpecialists', () => {
	it('gives the on-by-default entries for an unset list', () => {
		expect(names(sessionSpecialists(null))).toEqual(['a', 'c']);
	});

	it('gives exactly the stored entries, in Settings order', () => {
		expect(names(sessionSpecialists(['c', 'b']))).toEqual(['b', 'c']);
	});

	it('ignores the id of a deleted entry', () => {
		expect(names(sessionSpecialists(['gone', 'b']))).toEqual(['b']);
	});

	it('gives none for an empty list', () => {
		expect(sessionSpecialists([])).toEqual([]);
	});
});
