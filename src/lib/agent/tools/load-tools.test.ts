import { describe, it, expect } from 'vitest';
import '#lib/agent/tools/index.ts';
import type { ToolContext, DeferredFamily } from './types';
import { executeTool, getDisplayLabel, getToolSchemas } from './registry';
import { familyResult, loadedFamilies } from './deferred';

const VIDEO: DeferredFamily = {
	id: 'video',
	line: 'video — edit the episodes',
	schemas: [
		{
			type: 'function',
			function: { name: 'video_probe', description: 'Probe.', parameters: { type: 'object' } }
		}
	]
};

const ctx = (deferredTools?: DeferredFamily[]) =>
	({ workingDir: '/work', interactive: true, deferredTools }) as ToolContext;

const asTool = (content: string) => [{ role: 'tool' as const, tool_call_id: 'c', content }];

describe('load_tools', () => {
	it('returns the family, with its marker', async () => {
		const out = await executeTool('load_tools', { family: 'video' }, ctx([VIDEO]));
		expect(out.result).toBe(familyResult(VIDEO));
		expect([...loadedFamilies(asTool(out.result))]).toEqual(['video']);
	});

	it('loads nothing for a family this turn is not offered, and says where to turn it on', async () => {
		const out = await executeTool('load_tools', { family: 'email' }, ctx([VIDEO]));
		expect(out.result).toContain('Settings → Integrations');
		expect(out.result).toContain('Families you can load: video');
		expect(loadedFamilies(asTool(out.result)).size).toBe(0);
	});

	it('loads nothing in a turn that does not defer', async () => {
		const out = await executeTool('load_tools', { family: 'video' }, ctx());
		expect(loadedFamilies(asTool(out.result)).size).toBe(0);
	});

	it('is never offered by the filters', () => {
		const offered = [
			...getToolSchemas({ hasWorkingDir: true, interactive: true }),
			...getToolSchemas({ hasWorkingDir: true, toolAllowlist: ['load_tools', 'use_tool'] })
		].map((s) => s.function.name);
		expect(offered).not.toContain('load_tools');
		expect(offered).not.toContain('use_tool');
	});
});

describe('use_tool', () => {
	it('says what it needs when the call could not be unwrapped', async () => {
		const out = await executeTool('use_tool', { arguments: {} }, ctx([VIDEO]));
		expect(out.result).toContain('needs name');
	});

	it("shows the named tool's label", () => {
		expect(
			getDisplayLabel('use_tool', { name: 'web_search', arguments: { query: 'heat pumps' } })
		).toBe(getDisplayLabel('web_search', { query: 'heat pumps' }));
	});
});
