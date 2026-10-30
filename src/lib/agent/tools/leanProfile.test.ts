import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Every integration on, so a lean turn has every reason to offer more than it
// should: email that can send, calendar, contacts, screen, image, music and
// video backends, the sandbox, writable memory and an enabled MCP server.
const lean = vi.hoisted(() => ({ on: true }));

vi.mock('#lib/stores/settings.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/stores/settings.ts')>();
	return {
		...actual,
		getSettings: () => ({
			...actual.getSettings(),
			leanMode: lean.on,
			screenCaptureEnabled: true,
			imageBackendKind: 'comfyui',
			musicBackendKind: 'toolchest',
			videoGenBackendKind: 'toolchest',
			sandboxEnabled: true,
			agentFeedbackEnabled: true
		}),
		hasEnabledEmailAccount: () => true,
		hasSendableEmailAccount: () => true,
		hasEnabledCalendarAccount: () => true,
		hasEnabledContactsAccount: () => true,
		startableMcpServers: () => [
			{
				id: 'lean-srv',
				label: 'GitHub',
				enabled: true,
				source: { kind: 'catalog', entryId: 'github' },
				secrets: {},
				toolEnabled: {},
				proxyUse: 'auto',
				setupComplete: true
			}
		]
	};
});
vi.mock('#lib/stores/memory.svelte.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/memory.svelte.ts')>()),
	memoryActive: () => true
}));
vi.mock('#lib/sandbox/availability.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/sandbox/availability.ts')>()),
	pythonRuntimeMissing: () => false
}));

import { getToolSchemas } from '#lib/agent/tools/index.ts';
import { registerMcpTools, unregisterMcpServer } from '#lib/agent/tools/mcp.ts';
import { LEAN_CHAT_TOOLS, LEAN_SCHEMA_BUDGET_CHARS } from './leanProfile';

/** A Chat turn with a working folder and everything a lean tool could need. */
const CHAT = {
	hasWorkingDir: true,
	interactive: true,
	visionSupported: true,
	deepResearch: false,
	hasSkills: true,
	skillNames: ['notes'],
	skillFileNames: ['notes'],
	taskOwner: 'chat:1'
};

const names = (opts: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(opts).map((s) => s.function.name);

describe('lean mode tool profile', () => {
	beforeEach(() => {
		lean.on = true;
		registerMcpTools(
			'lean-srv',
			'GitHub',
			[
				{
					name: 'list_pull_requests',
					title: null,
					description: 'does list_pull_requests',
					inputSchema: { type: 'object' },
					annotations: null
				}
			],
			['list_pull_requests']
		);
	});
	afterEach(() => unregisterMcpServer('lean-srv'));

	it('offers a Chat turn exactly the lean tools', () => {
		expect(names(CHAT).sort()).toEqual([...LEAN_CHAT_TOOLS].sort());
	});

	it('keeps the lean schemas within the budget', () => {
		const chars = getToolSchemas(CHAT).reduce((n, s) => n + JSON.stringify(s).length, 0);
		expect(chars).toBeLessThanOrEqual(LEAN_SCHEMA_BUDGET_CHARS);
	});

	it('still drops what the turn cannot use', () => {
		const offered = names({ ...CHAT, hasWorkingDir: false, visionSupported: false });
		expect(offered.some((n) => n.startsWith('fs_'))).toBe(false);
		expect(offered).toContain('web_search');
	});

	it('leaves Code, Shell, jobs and allowlisted turns alone', () => {
		const code = { hasWorkingDir: true, interactive: true, codeMode: true };
		const shell = { hasWorkingDir: true, interactive: true, shellMode: true };
		const job = { hasWorkingDir: true, interactive: false };
		const allow = { hasWorkingDir: true, toolAllowlist: ['fs_write_text', 'web_search'] };
		const leanSets = [code, shell, job, allow].map((o) => names(o).sort());
		lean.on = false;
		const fullSets = [code, shell, job, allow].map((o) => names(o).sort());
		expect(leanSets).toEqual(fullSets);
		expect(leanSets[2]).toContain('fs_write_text');
	});

	it('changes nothing for Chat with lean mode off', () => {
		lean.on = false;
		const offered = names(CHAT);
		expect(offered).toContain('run_python');
		expect(offered).toContain('fs_write_docx');
		expect(offered.some((n) => n.includes('list_pull_requests'))).toBe(true);
	});
});
