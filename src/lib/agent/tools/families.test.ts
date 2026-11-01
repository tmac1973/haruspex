import { describe, it, expect, vi, afterEach } from 'vitest';

// Everything on: every integration, two image models, music, video, screen.
vi.mock('#lib/stores/settings.ts', async (orig) => {
	const real = await orig<typeof import('#lib/stores/settings.ts')>();
	return {
		...real,
		getSettings: () => ({
			...real.getSettings(),
			sandboxEnabled: true,
			screenCaptureEnabled: true,
			musicBackendKind: 'toolchest',
			videoGenBackendKind: 'toolchest',
			memoryEnabled: true,
			leanMode: false,
			agentFeedbackEnabled: false,
			codeSubtasks: 'read'
		}),
		hasEnabledEmailAccount: () => true,
		hasSendableEmailAccount: () => true,
		hasEnabledCalendarAccount: () => true,
		hasEnabledContactsAccount: () => true
	};
});
vi.mock('#lib/image/entries.ts', async (orig) => ({
	...(await orig<object>()),
	imageEntries: () => [{ id: 'a' }, { id: 'b' }]
}));
vi.mock('#lib/stores/memory.svelte.ts', async (orig) => ({
	...(await orig<object>()),
	memoryActive: () => true
}));
vi.mock('#lib/video/binaries.ts', async (orig) => ({
	...(await orig<object>()),
	videoToolsOn: () => true,
	videoAvailable: () => true
}));
vi.mock('#lib/sandbox/availability.ts', async (orig) => ({
	...(await orig<object>()),
	pythonRuntimeMissing: () => false
}));

import '#lib/agent/tools/index.ts';
import { offeredSchemas, registeredToolNames, toolCategory } from './registry';
import { registerMcpTools, unregisterMcpServer } from './mcp';
import {
	TOOL_FAMILIES,
	CHAT_CORE,
	CODE_CORE,
	allFamilies,
	familyOf,
	isCore,
	mcpFamilies
} from './families';

afterEach(() => unregisterMcpServer('gh'));

const tool = (name: string) => ({
	name,
	title: null,
	description: null,
	inputSchema: { type: 'object' },
	annotations: null
});

const chat = () =>
	offeredSchemas({
		hasWorkingDir: true,
		interactive: true,
		hasSkills: true,
		skillNames: ['a'],
		skillFileNames: ['a'],
		taskOwner: 'chat:x'
	});
const code = () =>
	offeredSchemas({
		hasWorkingDir: true,
		interactive: true,
		codeMode: true,
		hasSkills: true,
		skillNames: ['a'],
		taskOwner: 'code:x'
	});

const size = (schemas: { function: { name: string } }[], codeTab: boolean) =>
	schemas
		.filter((s) => isCore(s.function.name, codeTab))
		.reduce((n, s) => n + JSON.stringify(s).length, 0);

describe('tool families', () => {
	it('puts every registered tool in at most one family', () => {
		registerMcpTools('gh', 'GitHub', [tool('search')]);
		const families = allFamilies();
		for (const name of registeredToolNames()) {
			const category = toolCategory(name)!;
			const hits = families.filter((f) => f.has(name, category)).map((f) => f.id);
			expect(hits.length, `${name} is in ${hits.join(', ')}`).toBeLessThanOrEqual(1);
		}
	});

	it('keeps the core tools out of every family', () => {
		for (const name of [...CHAT_CORE, ...CODE_CORE]) expect(familyOf(name), name).toBeNull();
	});

	it('names only registered tools in the core sets', () => {
		const registered = new Set(registeredToolNames());
		for (const name of [...CHAT_CORE, ...CODE_CORE]) expect(registered.has(name), name).toBe(true);
	});

	it('gives each family a short index line that starts with its id', () => {
		for (const f of TOOL_FAMILIES) {
			expect(f.line.startsWith(`${f.id} — `), f.id).toBe(true);
			expect(f.line.length, f.id).toBeLessThan(100);
		}
	});

	it('gives each family at least one tool', () => {
		const names = registeredToolNames();
		for (const f of TOOL_FAMILIES) {
			expect(
				names.some((n) => f.has(n, toolCategory(n)!)),
				f.id
			).toBe(true);
		}
	});

	it('makes one family per MCP server', () => {
		registerMcpTools('gh', 'GitHub', [tool('search'), tool('read__file')]);
		const [gh] = mcpFamilies();
		expect(gh.id).toBe('mcp:gh');
		expect(gh.line.startsWith('mcp:gh — ')).toBe(true);
		expect(familyOf('mcp__gh__read__file')?.id).toBe('mcp:gh');
		expect(isCore('mcp__gh__search', false)).toBe(false);
	});

	it('treats a tool in no family as core', () => {
		expect(isCore('run_command', false)).toBe(true);
		expect(isCore('video_cut', false)).toBe(false);
		expect(isCore('make_asset', true)).toBe(false);
	});

	it('defers most of the schemas when everything is on', () => {
		const chatAll = chat();
		const codeAll = code();
		// The audit's profiles, so these hold real families, not empty ones.
		expect(chatAll.some((s) => s.function.name === 'video_cut')).toBe(true);
		expect(codeAll.some((s) => s.function.name === 'make_asset')).toBe(true);
		expect(size(chatAll, false)).toBeLessThan(18 * 1024);
		expect(size(codeAll, true)).toBeLessThan(14.5 * 1024);
	});
});
