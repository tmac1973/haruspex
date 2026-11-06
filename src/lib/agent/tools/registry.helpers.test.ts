import { afterEach, describe, expect, it } from 'vitest';
import { getToolSchemas } from '#lib/agent/tools/index.ts';
import { isCodeWriteTool } from '#lib/agent/tools/_codeTabProfile.ts';
import { helperForTool } from '#lib/helpers/registry.ts';
import { setCodeHelper } from '#lib/stores/settings.ts';

const codeTab = { hasWorkingDir: true, codeMode: true, interactive: true };

const offered = (tool: string, opts: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(opts).some((s) => s.function.name === tool);

afterEach(() => {
	setCodeHelper('search', false);
	setCodeHelper('3d', false);
});

describe('the shipped helpers’ tools', () => {
	it('gives search_code to the Search helper, which writes nothing', () => {
		expect(helperForTool('search_code')).toMatchObject({ id: 'search', writes: false });
		expect(isCodeWriteTool('search_code')).toBe(false);
	});

	it('offers search_code in the Code tab only while Search is on', () => {
		expect(offered('search_code', codeTab)).toBe(false);
		setCodeHelper('search', true);
		expect(offered('search_code', codeTab)).toBe(true);
		expect(offered('search_code', { hasWorkingDir: true, interactive: true })).toBe(false);
		expect(offered('search_code', { ...codeTab, shellMode: true })).toBe(false);
	});

	it('keeps search_code in a read-only session but drops check_3d', () => {
		setCodeHelper('search', true);
		setCodeHelper('3d', true);
		const readOnly = { ...codeTab, codeReadOnly: true };
		expect(offered('search_code', readOnly)).toBe(true);
		expect(offered('check_3d', codeTab)).toBe(true);
		expect(offered('check_3d', readOnly)).toBe(false);
	});
});
