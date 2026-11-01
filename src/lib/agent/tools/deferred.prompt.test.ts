import { describe, it, expect, vi } from 'vitest';

// Everything on, as the audit measured it: every integration, two image
// models, music, video generation and editing, screen capture.
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
		getDeferTools: () => 'on',
		hasEnabledEmailAccount: () => true,
		hasSendableEmailAccount: () => true,
		hasEnabledCalendarAccount: () => true,
		hasEnabledContactsAccount: () => true
	};
});
vi.mock('#lib/image/entries.ts', async (orig) => ({
	...(await orig<object>()),
	imageEntries: () => [
		{ id: 'a', label: 'Model A', backend: 'comfyui', caps: ['generate', 'edit'] },
		{ id: 'b', label: 'Model B', backend: 'comfyui', caps: ['generate'] }
	]
}));
vi.mock('#lib/image/modelsPrompt.ts', () => ({
	imageModelsPrompt: () =>
		'\n\nIMAGE MODELS, in the order the image tools use them:\n- Model A\n- Model B'
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
import type { ChatMessage } from '#lib/api.ts';
import { messageText } from '#lib/api.ts';
import type { AgentLoopOptions } from '#lib/agent/loop.ts';
import { buildSystemPrompt } from '#lib/agent/systemPrompt.ts';
import { buildCodeSystemPrompt } from '#lib/code/systemPrompt.ts';
import { buildLoopContext } from '#lib/agent/loop/context.ts';
import { resolveTurnTools, type TurnToolsInput } from '#lib/agent/loop/turnTools.ts';
import { familyResult, loadedFamilies, toolIndexSection, LOAD_TOOLS } from './deferred';
import type { DeferredFamily } from './types';

const CHAT: TurnToolsInput = {
	messages: [],
	workingDir: '/work',
	interactive: true,
	conversationId: 'x',
	skills: {
		catalog: [{ name: 'a', description: 'A skill.', tools: [] }],
		projectRoot: null
	} as never
};
const CODE: TurnToolsInput = {
	messages: [],
	workingDir: '/repo',
	interactive: true,
	codeMode: true,
	shellMode: false,
	codeSessionId: 's'
};

const chatPrompt = (deferred = resolveTurnTools(CHAT).deferredTools) =>
	messageText(
		buildSystemPrompt('/work', {
			includeImages: true,
			imageModels: true,
			guide: true,
			deferred
		}).content
	);
const codePrompt = (deferred = resolveTurnTools(CODE).deferredTools) =>
	messageText(buildCodeSystemPrompt({ root: '/repo', deferred }).content);

/** The overview's measure: the schemas sent, plus the index that lists the rest. */
const size = (t: { tools: unknown[]; deferredTools?: DeferredFamily[] }) =>
	JSON.stringify(t.tools).length + toolIndexSection(t.deferredTools).length;

describe('the system prompt with deferred families', () => {
	it('lists each deferred family once, in the MORE TOOLS index', () => {
		const deferred = resolveTurnTools(CHAT).deferredTools!;
		const prompt = chatPrompt(deferred);
		expect(prompt).toContain('MORE TOOLS');
		for (const f of deferred) expect(prompt).toContain(`- ${f.line}`);
	});

	it('names no deferred tool outside the index (Chat)', () => {
		const deferred = resolveTurnTools(CHAT).deferredTools!;
		const prompt = chatPrompt(deferred);
		for (const name of deferred.flatMap((f) => f.schemas.map((s) => s.function.name))) {
			expect(prompt, name).not.toMatch(new RegExp(`\\b${name}\\b`));
		}
		expect(prompt).not.toContain('IMAGE MODELS');
		expect(prompt).not.toContain('EMAIL INTEGRATION');
		// Email still shows as connected, so the model knows to load it.
		expect(prompt).toContain('CONNECTED INTEGRATIONS: Email');
	});

	it('names no deferred tool outside the index (Code tab)', () => {
		const deferred = resolveTurnTools(CODE).deferredTools!;
		const prompt = codePrompt(deferred);
		expect(prompt).toContain('MORE TOOLS');
		for (const name of deferred.flatMap((f) => f.schemas.map((s) => s.function.name))) {
			expect(prompt, name).not.toMatch(new RegExp(`\\b${name}\\b`));
		}
	});

	it('is unchanged without deferred families', () => {
		expect(chatPrompt([])).toBe(
			messageText(
				buildSystemPrompt('/work', { includeImages: true, imageModels: true, guide: true }).content
			)
		);
		expect(chatPrompt([])).toContain('fs_write_document');
		expect(chatPrompt([])).toContain('EMAIL INTEGRATION');
		expect(codePrompt([])).toContain('make_asset');
	});

	it('moves the text it leaves out into the load_tools result', () => {
		const chat = resolveTurnTools(CHAT).deferredTools!;
		const byId = (id: string) => familyResult(chat.find((f) => f.id === id)!);
		expect(byId('email')).toContain('Use email_list_recent first');
		expect(byId('documents')).toContain('Do NOT use run_python to create PDFs');
		expect(byId('images')).toContain('IMAGE MODELS');
		const code = resolveTurnTools(CODE).deferredTools!;
		expect(familyResult(code.find((f) => f.id === 'assets')!)).toContain('- make_asset —');
	});

	it('keeps the schemas and index under 20 KB in Chat and 16 KB in the Code tab', () => {
		expect(size(resolveTurnTools(CHAT))).toBeLessThan(20 * 1024);
		expect(size(resolveTurnTools(CODE))).toBeLessThan(16 * 1024);
	});
});

describe('preloading the documents family', () => {
	const run = (messages: ChatMessage[], expectsFileOutput: boolean) => {
		const added: ChatMessage[] = [];
		const ctx = buildLoopContext({
			...CHAT,
			messages,
			expectsFileOutput,
			contextSize: 65536,
			onStreamChunk: () => {},
			onComplete: () => {},
			onError: () => {},
			onMessageAdded: (m: ChatMessage) => added.push(m)
		} as unknown as AgentLoopOptions);
		return { ctx, added };
	};

	it('loads it before a file-output request, as if the model had asked', () => {
		const { ctx, added } = run([{ role: 'user', content: 'Make me a PDF on heat pumps.' }], true);
		expect(added.map((m) => m.role)).toEqual(['assistant', 'tool']);
		const call = added[0] as { tool_calls: { function: { name: string; arguments: string } }[] };
		expect(call.tool_calls[0].function).toEqual({
			name: LOAD_TOOLS,
			arguments: '{"family":"documents"}'
		});
		expect(loadedFamilies(ctx.messages).has('documents')).toBe(true);
	});

	it('does nothing for other requests, or when it is already loaded', () => {
		expect(run([{ role: 'user', content: 'Hi.' }], false).added).toEqual([]);
		const { ctx: first } = run([{ role: 'user', content: 'Make me a PDF.' }], true);
		expect(run(first.messages, true).added).toEqual([]);
	});
});
