import { describe, expect, it } from 'vitest';
import { guideCheck } from '../../../scripts/guide-check.mjs';

describe('the guide check CI runs', () => {
	const settings = 'src/lib/components/settings/ShellSection.svelte';

	it('fails a change users can see that leaves the guide alone', () => {
		for (const f of [
			settings,
			'src/lib/agent/tools/memoryWrite.ts',
			'src/lib/agent/jobs/types/guided-planning/Editor.svelte',
			'src/lib/slash/slash.ts',
			'src/lib/shortcuts.ts',
			'src-tauri/resources/skills/init/SKILL.md'
		]) {
			const r = guideCheck([f, 'README.md']);
			expect(r.ok, f).toBe(false);
			expect(r.triggered).toEqual([f]);
		}
	});

	it('passes once the guide changes too, or with the no-docs label', () => {
		expect(guideCheck([settings, 'docs/guide/shell.md']).ok).toBe(true);
		expect(guideCheck([settings], ['windows-ci', 'no-docs']).ok).toBe(true);
		expect(guideCheck([settings], ['windows-ci']).ok).toBe(false);
	});

	it('leaves tests, tool plumbing and everything else alone', () => {
		const r = guideCheck([
			'src/lib/components/settings/SkillsSection.test.ts',
			'src/lib/agent/tools/registry.ts',
			'src/lib/agent/tools/types.ts',
			'src/lib/stores/shell.svelte.ts',
			'src-tauri/src/lib.rs',
			'plan/self-docs/overview.md'
		]);
		expect(r).toMatchObject({ ok: true, triggered: [] });
	});
});
