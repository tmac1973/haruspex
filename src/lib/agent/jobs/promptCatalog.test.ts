import { describe, it, expect } from 'vitest';
import {
	BUILTIN_PROMPTS,
	builtinsFor,
	promptAppliesTo,
	type PromptScope
} from '$lib/agent/jobs/promptCatalog';

describe('prompt catalog', () => {
	it('every built-in has a unique id, a name, and a non-empty prompt', () => {
		const ids = new Set<string>();
		for (const p of BUILTIN_PROMPTS) {
			expect(p.name.trim().length).toBeGreaterThan(0);
			expect(p.prompt.trim().length).toBeGreaterThan(0);
			expect(p.builtin).toBe(true);
			expect(ids.has(p.id)).toBe(false);
			ids.add(p.id);
		}
	});

	it('scope matching: any applies everywhere; audit/research are exclusive', () => {
		expect(promptAppliesTo('any', 'audit')).toBe(true);
		expect(promptAppliesTo('any', 'research')).toBe(true);
		expect(promptAppliesTo('audit', 'audit')).toBe(true);
		expect(promptAppliesTo('audit', 'research')).toBe(false);
		expect(promptAppliesTo('research', 'audit')).toBe(false);
	});

	it('builtinsFor returns only applicable starters', () => {
		const auditOnly = builtinsFor('audit');
		expect(auditOnly.length).toBeGreaterThan(0);
		for (const p of auditOnly) {
			const s: PromptScope = p.scope;
			expect(s === 'audit' || s === 'any').toBe(true);
		}
		// The shipped starters are code-review prompts → none leak into research.
		for (const p of builtinsFor('research')) {
			expect(p.scope).toBe('any');
		}
	});
});
