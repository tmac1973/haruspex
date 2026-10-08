import { describe, expect, it, vi } from 'vitest';

vi.mock('#lib/guide/status.ts', () => ({
	guideStatus: async () => '## This Haruspex right now\n- Version: 9'
}));

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { GUIDE_PAGES } from '#lib/guide/guide.ts';
import { REMOTE_TOOLS } from '#lib/remote/driver.ts';
import type { ToolContext } from './types';

const ctx = (interactive: boolean) =>
	({ workingDir: null, pendingImages: [], interactive }) as unknown as ToolContext;

describe('haruspex_docs', () => {
	const offered = (opts: Parameters<typeof getToolSchemas>[0]) =>
		getToolSchemas(opts).find((s) => s.function.name === 'haruspex_docs');

	it('is offered with someone there, in Chat, Shell and Code mode, and to remote guests', () => {
		for (const mode of [{}, { shellMode: true }, { shellMode: true, codeMode: true }]) {
			expect(offered({ hasWorkingDir: true, interactive: true, ...mode })).toBeTruthy();
			expect(offered({ hasWorkingDir: true, interactive: false, ...mode })).toBeUndefined();
		}
		expect(offered({ hasWorkingDir: false, toolAllowlist: REMOTE_TOOLS })).toBeTruthy();
	});

	it('lets the model pick only a page that exists', () => {
		const schema = offered({ hasWorkingDir: false, interactive: true })!;
		const page = (schema.function.parameters as { properties: { page: { enum: string[] } } })
			.properties.page;
		expect(page.enum).toEqual(GUIDE_PAGES.map((p) => p.name));
	});

	it('returns a page whole', async () => {
		const out = await executeTool('haruspex_docs', { page: 'skills' }, ctx(true));
		expect(out.result).toBe(GUIDE_PAGES.find((p) => p.name === 'skills')!.body);
		const bad = await executeTool('haruspex_docs', { page: 'nope' }, ctx(true));
		expect(JSON.parse(bad.result).error).toContain('No guide page "nope"');
	});

	it("gives the setup status with the index, but not to a turn that isn't the host's", async () => {
		const here = (await executeTool('haruspex_docs', {}, ctx(true))).result;
		expect(here).toContain('Version: 9');
		expect(here).toContain('- getting-started — ');
		const remote = (await executeTool('haruspex_docs', {}, ctx(false))).result;
		expect(remote).not.toContain('Version: 9');
		expect(remote).toContain("the host's own setup");
		expect(remote).toContain('- getting-started — ');
	});
});
