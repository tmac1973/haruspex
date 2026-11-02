import { afterEach, describe, expect, it } from 'vitest';
import {
	registerSpecialistKind,
	specialistKind,
	specialistKinds,
	unregisterSpecialistKind
} from './kinds';
import type { SpecialistKind, SpecialistParam } from './types';

const registered: string[] = [];

function kind(id: string, params: Record<string, SpecialistParam> = {}): SpecialistKind {
	return {
		id,
		label: id,
		summary: '',
		defaultDescription: '',
		defaultSystemPrompt: '',
		defaultSampling: { max_tokens: 100 },
		writes: false,
		params,
		requestRequired: true,
		run: async () => ({ result: '' })
	};
}

function register(k: SpecialistKind) {
	registerSpecialistKind(k);
	registered.push(k.id);
}

const pathParam = (description: string, required = false): SpecialistParam => ({
	schema: { type: 'string', description },
	required
});

afterEach(() => {
	for (const id of registered.splice(0)) unregisterSpecialistKind(id);
});

describe('the specialist kind registry', () => {
	it('lists kinds in registration order', () => {
		register(kind('t-one'));
		register(kind('t-two'));
		const ids = specialistKinds().map((k) => k.id);
		expect(ids.indexOf('t-one')).toBeLessThan(ids.indexOf('t-two'));
		expect(specialistKind('t-two')?.id).toBe('t-two');
	});

	it('refuses a second kind with the same id', () => {
		register(kind('t-dup'));
		expect(() => registerSpecialistKind(kind('t-dup'))).toThrow(/already registered/);
	});

	it("refuses a param that is one of the tool's own fields", () => {
		for (const name of ['name', 'request', 'images']) {
			expect(() => registerSpecialistKind(kind(`t-${name}`, { [name]: pathParam('x') }))).toThrow(
				/tool's own field/
			);
		}
	});

	it('lets two kinds share a param that means the same thing', () => {
		register(kind('t-a', { path: pathParam('Where the GLB goes') }));
		// Descriptions may differ: the tool shows one.
		expect(() => register(kind('t-b', { path: pathParam('Where the HTML goes') }))).not.toThrow();
	});

	it('refuses a shared param with another type or required flag', () => {
		register(kind('t-c', { path: pathParam('x') }));
		expect(() =>
			registerSpecialistKind(kind('t-d', { path: { schema: { type: 'number' }, required: false } }))
		).toThrow(/differently/);
		expect(() => registerSpecialistKind(kind('t-e', { path: pathParam('x', true) }))).toThrow(
			/differently/
		);
	});
});
