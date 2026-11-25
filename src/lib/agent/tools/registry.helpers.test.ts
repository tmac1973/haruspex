import { afterEach, describe, expect, it } from 'vitest';
import { getToolSchemas } from '#lib/agent/tools/index.ts';
import { isCodeWriteTool } from '#lib/agent/tools/_codeTabProfile.ts';
import { helperForTool } from '#lib/helpers/registry.ts';
import { setCodeHelper, setCodeHelperConfig } from '#lib/stores/settings.ts';

const codeTab = { hasWorkingDir: true, codeMode: true, interactive: true };

const offered = (tool: string, opts: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(opts).some((s) => s.function.name === tool);

afterEach(() => {
	setCodeHelper('search', false);
	setCodeHelper('3d', false);
	setCodeHelperConfig('3d', undefined);
});

const delegateModel = { baseUrl: 'https://openrouter.ai/api', modelId: 'vendor/big' };

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

describe('a subtask’s helper tools', () => {
	const subtask = { ...codeTab, interactive: false, subtask: true, codeHelpers: ['3d'] };

	it('gets none unless its profile names the helper', () => {
		expect(offered('check_3d', subtask)).toBe(false);
		expect(offered('check_3d', { ...subtask, subtaskHelpers: ['3d'] })).toBe(true);
		expect(offered('check_3d', { ...subtask, subtaskHelpers: ['search'] })).toBe(false);
	});

	it('holds under an allowlist, which only narrows what a subtask gets', () => {
		const allowlist = ['fs_read_text', 'check_3d', 'delegate'];
		const listed = { ...subtask, toolAllowlist: allowlist };
		expect(offered('check_3d', listed)).toBe(false);
		expect(offered('check_3d', { ...listed, subtaskHelpers: ['3d'] })).toBe(true);
		expect(offered('fs_read_text', listed)).toBe(true);
		expect(offered('delegate', { ...listed, subtaskHelpers: ['3d'] })).toBe(false);
		expect(offered('code_grep', { ...listed, subtaskHelpers: ['3d'] })).toBe(false);
	});
});

describe('delegate_3d', () => {
	it('belongs to the 3D helper, which writes', () => {
		expect(helperForTool('delegate_3d')).toMatchObject({ id: '3d', writes: true });
	});

	it('is offered only with 3D on and a delegate model set', () => {
		setCodeHelper('3d', true);
		expect(offered('delegate_3d', codeTab)).toBe(false);
		expect(offered('check_3d', codeTab)).toBe(true);
		setCodeHelperConfig('3d', { backend: delegateModel });
		expect(offered('delegate_3d', codeTab)).toBe(true);
		expect(offered('delegate_3d', { ...codeTab, codeReadOnly: true })).toBe(false);
		setCodeHelper('3d', false);
		expect(offered('delegate_3d', codeTab)).toBe(false);
	});

	it('is never offered to a subtask, even one with the 3D helper', () => {
		setCodeHelper('3d', true);
		setCodeHelperConfig('3d', { backend: delegateModel });
		const subtask = {
			...codeTab,
			interactive: false,
			subtask: true,
			codeHelpers: ['3d'],
			subtaskHelpers: ['3d']
		};
		expect(offered('check_3d', subtask)).toBe(true);
		expect(offered('delegate_3d', subtask)).toBe(false);
	});
});
