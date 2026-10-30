import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Everything the full prompt has a section for is on, so a lean prompt that
// leaks one shows it.
vi.mock('#lib/stores/settings.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/stores/settings.ts')>();
	return {
		...actual,
		getSettings: () => ({
			...actual.getSettings(),
			customSystemPrompt: '',
			sandboxEnabled: true,
			agentFeedbackEnabled: true,
			screenCaptureEnabled: true,
			imageBackendKind: 'comfyui',
			musicBackendKind: 'toolchest',
			videoGenBackendKind: 'toolchest'
		}),
		hasEnabledEmailAccount: () => true,
		hasSendableEmailAccount: () => true,
		hasEnabledCalendarAccount: () => true,
		hasEnabledContactsAccount: () => true,
		startableMcpServers: () => [
			{
				id: 'lean-prompt-srv',
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

import { buildSystemPrompt, injectMessageHints } from './systemPrompt';
import { getToolSchemas } from '#lib/agent/tools/index.ts';
import { registerMcpTools, unregisterMcpServer } from '#lib/agent/tools/mcp.ts';
import { LEAN_CHAT_TOOLS } from '#lib/agent/tools/leanProfile.ts';
import { skillsPromptSection } from '#lib/skills/turn.ts';

function leanPrompt(): string {
	return buildSystemPrompt('/home/u/notes', {
		memorySection: '\n\nMEMORY — things you learned:\n- Prefers metric units.',
		skillsSection: skillsPromptSection({
			catalog: [{ name: 'notes', description: 'Tidy meeting notes', tools: [] }],
			projectRoot: null
		}),
		includeImages: true,
		guide: true,
		feedback: true,
		lean: true
	}).content as string;
}

describe('buildSystemPrompt — lean', () => {
	beforeAll(() =>
		registerMcpTools(
			'lean-prompt-srv',
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
		)
	);
	afterAll(() => unregisterMcpServer('lean-prompt-srv'));

	it('leaves out the sections for what lean mode turns off', () => {
		const prompt = leanPrompt();
		for (const heading of [
			'EMAIL INTEGRATION',
			'CONNECTED INTEGRATIONS',
			'PYTHON SANDBOX',
			'fs_write_'
		]) {
			expect(prompt).not.toContain(heading);
		}
		expect(prompt).not.toContain('A picture you drew');
	});

	it('keeps search, citations, images, memory and skills', () => {
		const prompt = leanPrompt();
		for (const kept of ['SEARCH RULES', 'INLINE CITATIONS', 'IMAGES', 'Prefers metric', 'SKILLS']) {
			expect(prompt).toContain(kept);
		}
	});

	it('tells the model the working folder is for reading', () => {
		expect(leanPrompt()).toContain('You can read files here but not create or change them');
	});

	it('names no tool a lean turn is not offered', () => {
		// Every tool any surface offers, with lean mode off in the registry
		// (this file does not turn it on): the prompt may name only lean ones.
		const all = new Set(
			[
				{ hasWorkingDir: true, interactive: true, hasSkills: true, taskOwner: 'chat:1' },
				{ hasWorkingDir: true, interactive: true, codeMode: true },
				{ hasWorkingDir: true, interactive: true, shellMode: true }
			].flatMap((o) => getToolSchemas(o).map((s) => s.function.name))
		);
		const prompt = leanPrompt();
		const named = [...all].filter((n) => new RegExp(`\\b${n}\\b`).test(prompt));
		expect(named.filter((n) => !LEAN_CHAT_TOOLS.has(n))).toEqual([]);
	});

	it('does not push a lean turn to write a file', () => {
		const [msg] = injectMessageHints([{ role: 'user', content: 'Make me a PDF of this' }], {
			workingDir: '/home/u/notes',
			exhaustiveResearch: false,
			lean: true
		});
		expect(msg.content).not.toContain('fs_write_');
	});
});
