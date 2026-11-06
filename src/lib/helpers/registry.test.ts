import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getToolSchemas } from '#lib/agent/tools/index.ts';
import { isCodeWriteTool } from '#lib/agent/tools/_codeTabProfile.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolResult } from '#lib/agent/tools/types.ts';
import { setCodeHelper, setCodeHelperConfig } from '#lib/stores/settings.ts';
import {
	helperConfig,
	helperForTool,
	helperOn,
	helpers,
	registerHelper,
	sessionHelpers,
	type HelperDef
} from './registry';

const TOOL = 'zz_test_helper_tool';

const def: HelperDef = {
	id: 'zz-test',
	label: 'Test',
	summary: 'A helper for tests.',
	tooltip: 'Only in tests.',
	tools: [TOOL],
	writes: true
};

const withSettings: HelperDef = {
	id: 'zz-configured',
	label: 'Configured',
	summary: 'A helper with settings.',
	tooltip: 'Only in tests.',
	tools: [],
	writes: false,
	settings: {
		parse: (raw) => ({
			url: typeof (raw as { url?: unknown })?.url === 'string' ? (raw as { url: string }).url : ''
		}),
		component: async () => ({ default: (() => {}) as never })
	}
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
	registerHelper(withSettings);
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

	it('gives a session its stored ids, or the switched-on ones when it has none', () => {
		expect(sessionHelpers(null)).not.toContain(def);
		expect(sessionHelpers([def.id, 'gone'])).toEqual([def]);
		setCodeHelper(def.id, true);
		expect(sessionHelpers(undefined)).toContain(def);
		expect(sessionHelpers([])).toEqual([]);
	});

	it('marks a writing helper’s tools as write tools', () => {
		expect(isCodeWriteTool(TOOL)).toBe(true);
	});
});

describe('a helper’s settings', () => {
	afterEach(() => setCodeHelperConfig(withSettings.id, undefined));

	it('parses what is stored, or gives the defaults when nothing is', () => {
		expect(helperConfig(withSettings.id)).toEqual({ url: '' });
		setCodeHelperConfig(withSettings.id, { url: 'http://box:3000' });
		expect(helperConfig(withSettings.id)).toEqual({ url: 'http://box:3000' });
		setCodeHelperConfig(withSettings.id, 'garbage');
		expect(helperConfig(withSettings.id)).toEqual({ url: '' });
	});

	it('is undefined for a helper without settings, or an unknown one', () => {
		expect(helperConfig(def.id)).toBeUndefined();
		expect(helperConfig('unknown')).toBeUndefined();
	});
});

describe('offering a helper’s tools', () => {
	const codeTab = { hasWorkingDir: true, codeMode: true, interactive: true };

	it('offers them in the Code tab only while the helper is on', () => {
		expect(offered(codeTab)).toBe(false);
		setCodeHelper(def.id, true);
		expect(offered(codeTab)).toBe(true);
	});

	it('follows the session’s own list over the setting', () => {
		expect(offered({ ...codeTab, codeHelpers: [def.id] })).toBe(true);
		setCodeHelper(def.id, true);
		expect(offered({ ...codeTab, codeHelpers: [] })).toBe(false);
		expect(offered({ ...codeTab, codeHelpers: null })).toBe(true);
	});

	it('never offers them in Shell Code mode, Chat, a subtask or a read-only session', () => {
		setCodeHelper(def.id, true);
		expect(offered({ ...codeTab, shellMode: true })).toBe(false);
		expect(offered({ hasWorkingDir: true, interactive: true })).toBe(false);
		expect(offered({ ...codeTab, subtask: true })).toBe(false);
		expect(offered({ ...codeTab, codeReadOnly: true })).toBe(false);
	});
});
