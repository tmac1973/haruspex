/**
 * Deciding a turn's tools: the registry's filters, then the deferred-loading
 * split. Apart from the loop context so Chat and the Code tab can decide them
 * before they build the prompt, which lists the families the loop defers.
 */

import type { ToolDefinition } from '#lib/api.ts';
import { getToolSchemas } from '#lib/agent/tools/index.ts';
import { getDeferTools, getSettings } from '#lib/stores/settings.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import { deferOn, splitTurnTools } from '#lib/agent/tools/deferred.ts';
import type { DeferredFamily } from '#lib/agent/tools/types.ts';
import { skillsWithFiles } from '#lib/skills/content.ts';
import type { TurnSkills } from '#lib/skills/turn.ts';
import type { ChatMessage } from '#lib/api.ts';
import type { AgentLoopOptions } from '#lib/agent/loop.ts';

/** A turn's tools: what the request carries, and the families it lists but does not send. */
export interface TurnTools {
	tools: ToolDefinition[];
	deferredTools?: DeferredFamily[];
}

/** What deciding a turn's tools reads of its options. */
export type TurnToolsInput = Pick<
	AgentLoopOptions,
	| 'messages'
	| 'workingDir'
	| 'deepResearch'
	| 'visionSupported'
	| 'shellMode'
	| 'codeMode'
	| 'codeReadOnly'
	| 'codeRemote'
	| 'interactive'
	| 'subtask'
	| 'toolAllowlist'
	| 'forceFinalTool'
	| 'feedback'
	| 'skills'
	| 'codeSessionId'
	| 'conversationId'
	| 'backend'
>;

/**
 * The turn's tool list, filtered by working-dir presence, deep-research mode,
 * vision support and the rest, then split when deferred loading is on.
 *
 * Chat and the Code tab call this before they build the system prompt, which
 * lists the deferred families, and hand the result to the loop as
 * `turnTools`, so the prompt and `load_tools` name the same families.
 */
export function resolveTurnTools(options: TurnToolsInput): TurnTools {
	const descriptor = resolveBackendDescriptor(options.backend);
	const workingDir = options.workingDir ?? null;
	const shellMode = options.shellMode ?? false;
	const codeMode = options.codeMode ?? false;
	const offered = getToolSchemas({
		hasWorkingDir: workingDir !== null,
		deepResearch: options.deepResearch ?? false,
		visionSupported: options.visionSupported ?? true,
		shellMode,
		codeMode,
		codeReadOnly: options.codeReadOnly ?? false,
		codeRemote: options.codeRemote ?? false,
		interactive: options.interactive ?? false,
		subtask: options.subtask !== undefined,
		// The forced final tool is always offered. A stage once listed its
		// read tools but not its submit tool: the model, correctly, never
		// called a tool it was not given, and the forced call then named a
		// tool missing from the request, which vLLM refuses with a 400 — so
		// the turn ended empty and a chain lost its art.
		toolAllowlist:
			options.toolAllowlist && options.forceFinalTool
				? [...options.toolAllowlist, options.forceFinalTool]
				: options.toolAllowlist,
		harnessFeedback: options.feedback !== undefined,
		skillNames: options.skills?.catalog.map((s) => s.name),
		skillFileNames: options.skills && readableSkills(options.skills, options.messages),
		hasSkills: options.skills !== undefined,
		taskOwner: options.codeSessionId
			? `code:${options.codeSessionId}`
			: options.conversationId
				? `chat:${options.conversationId}`
				: undefined
	});
	const split = deferOn({
		setting: getDeferTools(),
		modelId: descriptor.modelId,
		interactive: options.interactive ?? false,
		codeMode,
		shellMode,
		subtask: options.subtask !== undefined,
		// A forced final tool must be in the request (see toolAllowlist above).
		allowlisted: options.toolAllowlist !== undefined || options.forceFinalTool !== undefined,
		lean: getSettings().leanMode
	})
		? splitTurnTools(offered, codeMode, options.codeReadOnly ?? false)
		: null;
	if (!split?.deferred.length) return { tools: split?.sent ?? offered };
	return { tools: split.sent, deferredTools: split.deferred };
}

/**
 * Skills whose files the model may read this turn: those it may load, and
 * any already in the conversation with files — a skill the user ran with
 * `/name` is readable whether or not autonomous use is on.
 */
export function readableSkills(skills: TurnSkills, messages: ChatMessage[]): string[] {
	const names = new Set(skills.catalog.map((s) => s.name));
	for (const name of skillsWithFiles(messages)) names.add(name);
	return [...names];
}
