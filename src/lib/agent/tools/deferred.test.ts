import { describe, it, expect, vi, afterEach } from 'vitest';

// `full` turns everything on: every integration, two image models, music,
// video, screen capture. The audit's profiles.
const flags = vi.hoisted(() => ({ full: true, defer: 'on' as 'auto' | 'on' | 'off' }));

vi.mock('#lib/stores/settings.ts', async (orig) => {
	const real = await orig<typeof import('#lib/stores/settings.ts')>();
	return {
		...real,
		getSettings: () => ({
			...real.getSettings(),
			sandboxEnabled: true,
			screenCaptureEnabled: flags.full,
			musicBackendKind: flags.full ? 'toolchest' : 'none',
			videoGenBackendKind: flags.full ? 'toolchest' : 'none',
			memoryEnabled: true,
			leanMode: false,
			agentFeedbackEnabled: false,
			codeSubtasks: 'read'
		}),
		getDeferTools: () => flags.defer,
		hasEnabledEmailAccount: () => flags.full,
		hasSendableEmailAccount: () => flags.full,
		hasEnabledCalendarAccount: () => flags.full,
		hasEnabledContactsAccount: () => flags.full
	};
});
vi.mock('#lib/image/entries.ts', async (orig) => ({
	...(await orig<object>()),
	imageEntries: () => (flags.full ? [{ id: 'a' }, { id: 'b' }] : [])
}));
vi.mock('#lib/stores/memory.svelte.ts', async (orig) => ({
	...(await orig<object>()),
	memoryActive: () => true
}));
vi.mock('#lib/video/binaries.ts', async (orig) => ({
	...(await orig<object>()),
	videoToolsOn: () => flags.full,
	videoAvailable: () => flags.full
}));
vi.mock('#lib/sandbox/availability.ts', async (orig) => ({
	...(await orig<object>()),
	pythonRuntimeMissing: () => false
}));

import '#lib/agent/tools/index.ts';
import type { ChatMessage, ToolDefinition } from '#lib/api.ts';
import type { AgentLoopOptions } from '#lib/agent/loop.ts';
import { buildLoopContext } from '#lib/agent/loop/context.ts';
import { getToolSchemas, type ToolSchemaOpts } from './registry';
import {
	LOAD_TOOLS,
	USE_TOOL,
	deferOn,
	deferredFamilyOf,
	familyResult,
	loadedFamilies,
	loadedMarker,
	splitTurnTools,
	type DeferTurn
} from './deferred';

afterEach(() => {
	flags.full = true;
	flags.defer = 'on';
});

const names = (schemas: ToolDefinition[]) => schemas.map((s) => s.function.name);

const PROFILES: [string, boolean, ToolSchemaOpts, boolean][] = [
	['Chat, no folder', false, { hasWorkingDir: false, interactive: true }, false],
	['Chat, folder', false, { hasWorkingDir: true, interactive: true, taskOwner: 'chat:x' }, false],
	[
		'Chat, everything on',
		true,
		{
			hasWorkingDir: true,
			interactive: true,
			hasSkills: true,
			skillNames: ['a'],
			skillFileNames: ['a'],
			taskOwner: 'chat:x'
		},
		false
	],
	['Code tab', false, { hasWorkingDir: true, interactive: true, codeMode: true }, true],
	[
		'Code tab, everything on',
		true,
		{ hasWorkingDir: true, interactive: true, codeMode: true, taskOwner: 'code:x' },
		true
	]
];

describe('splitTurnTools', () => {
	for (const [label, full, opts, codeTab] of PROFILES) {
		it(`neither widens nor narrows the turn: ${label}`, () => {
			flags.full = full;
			const offered = getToolSchemas(opts);
			const { sent, deferred } = splitTurnTools(offered, codeTab);
			const core = sent.filter((s) => ![LOAD_TOOLS, USE_TOOL].includes(s.function.name));
			const split = [...names(core), ...deferred.flatMap((f) => names(f.schemas))];
			expect(split.sort()).toEqual(names(offered).sort());
			// A family with nothing offered is not listed.
			for (const f of deferred) expect(f.schemas.length).toBeGreaterThan(0);
		});
	}

	it('sends the core in registry order, then load_tools and use_tool', () => {
		const offered = getToolSchemas(PROFILES[2][2]);
		const { sent, deferred } = splitTurnTools(offered, false);
		expect(names(sent).slice(-2)).toEqual([LOAD_TOOLS, USE_TOOL]);
		const core = names(sent).slice(0, -2);
		expect(core).toEqual(names(offered).filter((n) => core.includes(n)));
		expect(names(sent)).not.toContain('video_cut');
		const load = sent.at(-2)!.function.parameters as {
			properties: { family: { enum: string[] } };
		};
		expect(load.properties.family.enum).toEqual(deferred.map((f) => f.id));
		expect(load.properties.family.enum).toContain('video');
	});

	it('sends what was offered when there is nothing to defer', () => {
		flags.full = false;
		const offered = getToolSchemas({ hasWorkingDir: false, interactive: true });
		const split = splitTurnTools(offered, false);
		if (split.deferred.length === 0) expect(split.sent).toBe(offered);
		const shell = getToolSchemas({ hasWorkingDir: true, interactive: true, shellMode: true });
		expect(splitTurnTools(shell, false).sent).toBe(shell);
	});
});

describe('deferOn', () => {
	const turn = (over: Partial<DeferTurn> = {}): DeferTurn => ({
		setting: 'on',
		modelId: 'qwen3.5-9b',
		interactive: true,
		codeMode: false,
		shellMode: false,
		subtask: false,
		allowlisted: false,
		lean: false,
		...over
	});

	it('applies to interactive Chat and the Code tab', () => {
		expect(deferOn(turn())).toBe(true);
		expect(deferOn(turn({ codeMode: true }))).toBe(true);
	});

	it('leaves Shell, jobs, guests, subtasks and lean turns alone', () => {
		expect(deferOn(turn({ shellMode: true }))).toBe(false);
		expect(deferOn(turn({ codeMode: true, shellMode: true }))).toBe(false);
		expect(deferOn(turn({ interactive: false }))).toBe(false);
		expect(deferOn(turn({ allowlisted: true }))).toBe(false);
		expect(deferOn(turn({ subtask: true }))).toBe(false);
		expect(deferOn(turn({ lean: true }))).toBe(false);
		// Lean mode is a Chat setting.
		expect(deferOn(turn({ lean: true, codeMode: true }))).toBe(true);
	});

	it('follows the setting, and the model size under auto', () => {
		expect(deferOn(turn({ setting: 'off' }))).toBe(false);
		expect(deferOn(turn({ setting: 'auto', modelId: 'qwen3.5-9b' }))).toBe(false);
		expect(deferOn(turn({ setting: 'auto', modelId: 'Qwen3.8-35B-A3B' }))).toBe(true);
		expect(deferOn(turn({ setting: 'auto', modelId: 'some-model' }))).toBe(true);
	});
});

describe('loaded families', () => {
	const tool = (content: string): ChatMessage => ({ role: 'tool', tool_call_id: 'c', content });

	it('reads the marker from a tool result', () => {
		const video = deferredFamilyOf(
			'video_cut',
			splitTurnTools(getToolSchemas(PROFILES[2][2]), false).deferred
		)!;
		const result = familyResult(video);
		expect(result.startsWith(loadedMarker('video'))).toBe(true);
		expect(result).toContain('"name":"video_cut"');
		expect([...loadedFamilies([tool(result)])]).toEqual(['video']);
	});

	it('does not count a marker the user typed, or a result that was trimmed', () => {
		expect(loadedFamilies([{ role: 'user', content: loadedMarker('video') }]).size).toBe(0);
		expect(loadedFamilies([tool('[Trimmed: load_tools result]')]).size).toBe(0);
	});
});

describe('buildLoopContext with deferred loading', () => {
	const options = (messages: ChatMessage[], over: Partial<AgentLoopOptions> = {}) =>
		({
			messages,
			workingDir: '/work',
			interactive: true,
			conversationId: 'x',
			contextSize: 65536,
			onStreamChunk: () => {},
			onComplete: () => {},
			onError: () => {},
			...over
		}) as AgentLoopOptions;

	const loaded = (): ChatMessage[] => {
		const ctx = buildLoopContext(options([]));
		const video = ctx.deferredTools!.find((f) => f.id === 'video')!;
		return [
			{ role: 'user', content: 'Cut ep012.' },
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id: 'c1',
						type: 'function',
						function: { name: LOAD_TOOLS, arguments: '{"family":"video"}' }
					}
				]
			},
			{ role: 'tool', tool_call_id: 'c1', content: familyResult(video) }
		];
	};

	it('sends the same tools before and after a load', () => {
		const before = buildLoopContext(options([{ role: 'user', content: 'Cut ep012.' }]));
		const after = buildLoopContext(options(loaded()));
		expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
		expect(names(before.tools)).not.toContain('video_probe');
		expect(names(before.tools)).toContain(USE_TOOL);
	});

	it('changes nothing with the setting off', () => {
		flags.defer = 'off';
		const ctx = buildLoopContext(options([]));
		expect(ctx.deferredTools).toBeUndefined();
		expect(JSON.stringify(ctx.tools)).toBe(
			JSON.stringify(
				getToolSchemas({
					hasWorkingDir: true,
					interactive: true,
					deepResearch: false,
					visionSupported: true,
					shellMode: false,
					codeMode: false,
					codeReadOnly: false,
					codeRemote: false,
					subtask: false,
					harnessFeedback: false,
					hasSkills: false,
					taskOwner: 'chat:x'
				})
			)
		);
	});

	it('does not defer a job, which has an allowlist', () => {
		const ctx = buildLoopContext(
			options([], { interactive: false, toolAllowlist: ['web_search', 'video_probe'] })
		);
		expect(ctx.deferredTools).toBeUndefined();
	});
});
