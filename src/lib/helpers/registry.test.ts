import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getToolSchemas } from '#lib/agent/tools/index.ts';
import { isCodeWriteTool } from '#lib/agent/tools/codeTabProfile.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolResult } from '#lib/agent/tools/types.ts';
import { setCodeHelper } from '#lib/stores/settings.ts';
import { helperForTool, helperOn, helpers, registerHelper, type HelperDef } from './registry';

const TOOL = 'zz_test_helper_tool';

const def: HelperDef = {
	id: 'zz-test',
	label: 'Test',
	summary: 'A helper for tests.',
	tooltip: 'Only in tests.',
	tools: [TOOL],
	writes: true
};

beforeAll(() => {
	registerTool({
		category: 'fs',
		schema: {
			type: 'function',
			function: { name: TOOL, description: 'test', parameters: { type: 'object', properties: {} } }
		},
		execute: async () => toolResult('ok'),
		displayLabel: () => 'test'
	});
	registerHelper(def);
});

afterEach(() => setCodeHelper(def.id, false));

const offered = (opts: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(opts).some((s) => s.function.name === TOOL);

describe('the helper registry', () => {
	it('finds a helper by its tool and lists it', () => {
		expect(helperForTool(TOOL)).toBe(def);
		expect(helperForTool('fs_read_text')).toBeUndefined();
		expect(helpers()).toContain(def);
	});

	it('refuses a duplicate id or a tool another helper owns', () => {
		expect(() => registerHelper(def)).toThrow(/already registered/);
		expect(() => registerHelper({ ...def, id: 'other' })).toThrow(/already belongs/);
	});

	it('is off until switched on', () => {
		expect(helperOn(def.id)).toBe(false);
		expect(helperOn('unknown')).toBe(false);
		setCodeHelper(def.id, true);
		expect(helperOn(def.id)).toBe(true);
	});

	it('marks a writing helper’s tools as write tools', () => {
		expect(isCodeWriteTool(TOOL)).toBe(true);
	});
});

describe('offering a helper’s tools', () => {
	const codeTab = { hasWorkingDir: true, codeMode: true, interactive: true };

	it('offers them in the Code tab only while the helper is on', () => {
		expect(offered(codeTab)).toBe(false);
		setCodeHelper(def.id, true);
		expect(offered(codeTab)).toBe(true);
	});

	it('never offers them in Shell Code mode, Chat, a subtask or a read-only session', () => {
		setCodeHelper(def.id, true);
		expect(offered({ ...codeTab, shellMode: true })).toBe(false);
		expect(offered({ hasWorkingDir: true, interactive: true })).toBe(false);
		expect(offered({ ...codeTab, subtask: true })).toBe(false);
		expect(offered({ ...codeTab, codeReadOnly: true })).toBe(false);
	});
});
