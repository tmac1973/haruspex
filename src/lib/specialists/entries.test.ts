import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpecialistEntry } from './types';

const store = vi.hoisted(() => ({ specialists: [] as unknown[] }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => store
	})
);

import '#lib/specialists/kinds/index.ts';
import {
	effectiveDescription,
	effectiveSampling,
	effectiveSystemPrompt,
	entryBackend,
	newSpecialistEntry,
	specialistEntries
} from './entries';

function entry(over: Partial<SpecialistEntry> = {}): SpecialistEntry {
	return { ...newSpecialistEntry('text', []), url: 'http://x:3000', model: 'm', ...over };
}

beforeEach(() => {
	store.specialists = [];
});

describe('specialist entries', () => {
	it("fall back to the kind's defaults where they hold null", () => {
		const e = entry();
		expect(effectiveSampling(e)).toEqual({ temperature: 0.7, max_tokens: 4096 });
		expect(effectiveSystemPrompt(e)).toBe('');
		expect(effectiveDescription(e)).toMatch(/Answers a question/);
	});

	it('override the kind field by field', () => {
		const e = entry({
			sampling: { temperature: 0.2, thinking: false },
			systemPrompt: 'Be brief.',
			description: 'Writes SQL.'
		});
		expect(effectiveSampling(e)).toEqual({ temperature: 0.2, max_tokens: 4096, thinking: false });
		expect(effectiveSystemPrompt(e)).toBe('Be brief.');
		expect(effectiveDescription(e)).toBe('Writes SQL.');
	});

	it("keep an empty system prompt as 'send none'", () => {
		expect(effectiveSystemPrompt(entry({ systemPrompt: '' }))).toBe('');
	});

	it('leave out entries of a kind that is not registered', () => {
		store.specialists = [
			entry({ name: 'ok' }),
			entry({ name: 'gone', kind: 'from-a-newer-build' })
		];
		expect(specialistEntries().map((e) => e.name)).toEqual(['ok']);
	});

	it('build a backend without the trailing slash or /v1', () => {
		for (const url of [
			'http://asmodean:3000/',
			'http://asmodean:3000/v1',
			' http://asmodean:3000/v1/ '
		]) {
			expect(entryBackend(entry({ url, keyId: 'k1' }))).toEqual({
				baseUrl: 'http://asmodean:3000',
				apiKeyId: 'k1',
				modelId: 'm'
			});
		}
	});

	it('give a new entry a unique name and safe defaults', () => {
		const first = newSpecialistEntry('text', []);
		const second = newSpecialistEntry('text', [first]);
		expect(first.name).toBe('Text');
		expect(second.name).toBe('Text 2');
		expect(second.id).not.toBe(first.id);
		expect(second).toMatchObject({ onByDefault: false, acceptsImages: false, sampling: null });
	});
});
