import { textureFiles, transitionFiles } from '#lib/assets/texture.ts';
import type { ToolDefinition } from '#lib/api.ts';
import type { ToolRegistration, ToolExecOutput, ToolContext } from '#lib/agent/tools/types.ts';
import { toolResult, toolError } from '#lib/agent/tools/types.ts';
import { coerceArgsToSchema } from '#lib/agent/tools/coerce.ts';
import {
	hasEnabledEmailAccount,
	hasSendableEmailAccount,
	hasEnabledCalendarAccount,
	hasEnabledContactsAccount,
	getSettings
} from '#lib/stores/settings.ts';
// The predicate, not the tool module — mcp.ts registers THROUGH this file, so
// importing it here would be a cycle. Same reason as memoryActive() below.
import { isMcpToolEnabled } from '#lib/agent/tools/mcp-names.ts';
// The predicate, not the tool module: memoryWrite.ts registers THROUGH this
// file, so importing it here would be a cycle.
import { memoryActive } from '#lib/stores/memory.svelte.ts';
import { PYTHON_UNAVAILABLE, pythonRuntimeMissing } from '#lib/sandbox/availability.ts';
import {
	CODE_TAB_ONLY,
	CODE_TAB_DESCRIPTIONS,
	READ_ONLY_REFUSAL,
	REMOTE_HANDOFF_REFUSAL,
	isCodeWriteTool,
	type DescriptionOverride
} from '#lib/agent/tools/codeTabProfile.ts';
import { shellPlatformSupported } from '#lib/shell/platformSupport.ts';
import { videoAvailable, videoToolsOn } from '#lib/video/binaries.ts';
import { getTasks } from '#lib/tasks/store.svelte.ts';

const tools = new Map<string, ToolRegistration>();

export function registerTool(reg: ToolRegistration): void {
	tools.set(reg.schema.function.name, reg);
}

/**
 * Remove a tool. Only MCP tools are ever withdrawn — built-ins register once at
 * module load and stay — but the registry does not need to know that, so this
 * is the general operation rather than an MCP-shaped one.
 */
export function unregisterTool(name: string): void {
	tools.delete(name);
}

/** The tools that make a picture in Chat, offered and saved alike. */
const IMAGE_TOOLS = new Set(['generate_image', 'edit_image', 'upscale_image']);

/** The tools that make a song, offered and saved alike. */
const SONG_TOOLS = new Set(['generate_music', 'edit_music']);

/**
 * Get the tool schemas to expose to the model for this request.
 *
 * Filtering logic:
 * - Filesystem tools only included when a working directory is active
 * - In deep-research mode, fetch_url is removed so the model uses research_url
 * - Vision-dependent tools filtered when backend doesn't support vision
 * - Email tools hidden until the user has enabled at least one account
 */
interface ToolFilterOpts {
	hasWorkingDir: boolean;
	/** A live user is present, who can answer `ask_user_question`. */
	interactive: boolean;
	deepResearch: boolean;
	visionSupported: boolean;
	shellMode: boolean;
	codeMode: boolean;
	/** A read-only Code session: no tool that writes into the project. */
	codeReadOnly: boolean;
	/** A Code turn started from another computer: no hand-off to a Shell tab. */
	codeRemote: boolean;
	/** A subtask's turn (`delegate`'s child): see `SUBTASK_EXCLUDED`. */
	subtask: boolean;
	hasEmail: boolean;
	sandboxEnabled: boolean;
	/** Memory is on AND its embedding model is present — see memoryActive(). */
	memoryWritable: boolean;
	/** At least one CalDAV account is enabled and has credentials. */
	hasCalendar: boolean;
	/** The same, for an account whose server actually serves address books. */
	hasContacts: boolean;
	/** The user has switched screen capture on in Settings → Screen. */
	screenCapture: boolean;
	/**
	 * An image backend is set up AND someone is there to see the picture. The
	 * second half matters: a research job runs without an allowlist, so it gets
	 * this filter too, and must not spend GPU minutes drawing for nobody.
	 */
	imageGeneration: boolean;
	/** A music backend is set up AND someone is there to hear the song. */
	musicGeneration: boolean;
	/**
	 * ffmpeg, ffprobe and melt were found, there is a working folder for the
	 * footage, AND someone is there: a render runs for minutes and an upload
	 * publishes, so neither belongs in a job.
	 */
	videoTools: boolean;
	/**
	 * An account has Allow sending on AND someone is there to review the
	 * draft. A job never gets `email_compose`, allowlist or not.
	 */
	sendableEmail: boolean;
	/** The background-task owner the turn speaks for; see `getToolSchemas`. */
	taskOwner?: string;
}

// Tools exposed to the Shell-tab assistant (non-Code mode). Reads only —
// the plain assistant is read-only; file edits live in Code mode (which
// uses the CODE_TOOLS set below). Email and sandbox don't make sense for
// admin troubleshooting and stay hidden.
const SHELL_FS_READS = new Set(['fs_read_text', 'fs_list_dir', 'fs_read_pdf']);

// The lean Code-tab toolset: Pi's core (read/write/edit/bash + ls/grep/find)
// plus web research. Keeping this list small is the single biggest context
// lever (every exposed tool's schema ships in every request — see plan §7).
const CODE_TOOLS = new Set([
	'fs_read_text',
	'fs_list_dir',
	'fs_edit_text',
	'fs_write_text',
	'code_grep',
	'code_glob',
	'run_command',
	'web_search',
	'research_url'
]);

// `fs`-category tools that should only ever appear in Code mode — keeps the
// Chat schema lean (it otherwise exposes every fs tool when a workdir is set).
const CODE_ONLY_FS = new Set(['code_grep', 'code_glob']);

// Interactive PTY-control tools. Only meaningful in Code mode driving a live
// shell session (the Shell tab in Code mode), where there's a real terminal to
// drive — not the standalone Code tab (one-shot exec, no PTY).
const SHELL_INTERACTIVE_TOOLS = new Set([
	'shell_read',
	'shell_input',
	'shell_interrupt',
	'shell_snapshot'
]);

function shouldIncludeShellTool(reg: ToolRegistration, opts: ToolFilterOpts): boolean {
	const name = reg.schema.function.name;
	// `exec` (run_command) is Code-mode only — never expose it in Shell mode,
	// which has its own real terminal.
	if (reg.category === 'exec') return false;
	if (reg.category === 'web') {
		if (opts.deepResearch && name === 'fetch_url') return false;
		return true;
	}
	if (reg.category === 'fs') {
		// Reads only — the plain Shell assistant is read-only. Writes are a
		// Code-mode capability (see shouldIncludeCodeTool / CODE_TOOLS).
		return SHELL_FS_READS.has(name);
	}
	// Asking the person at the terminal a multiple-choice question, in the
	// modal rather than as chat text.
	if (reg.category === 'interaction') return opts.interactive;
	// Email, sandbox, etc. are intentionally hidden in Shell mode.
	return false;
}

function shouldIncludeCodeTool(reg: ToolRegistration, opts: ToolFilterOpts): boolean {
	const name = reg.schema.function.name;
	// Vision-dependent tools (e.g. shell_snapshot) are useless without a model
	// that can see images.
	if (reg.requiresVision && !opts.visionSupported) return false;
	if (opts.codeReadOnly && isCodeWriteTool(name)) return false;
	if (CODE_TOOLS.has(name)) return true;
	// ask_user_question. Code mode is where "ask me one question at a time"
	// is most often said; without this the model asked in chat text instead.
	if (reg.category === 'interaction') return opts.interactive;
	// Interactive terminal control only when Code mode drives a live shell
	// session (shellMode), where there's a real PTY to send input/signals to.
	if (SHELL_INTERACTIVE_TOOLS.has(name)) return opts.shellMode;
	// Looking at the screen is as useful in Code mode as in Chat — "why does
	// this dialog look wrong" is a question about pixels — and it carries the
	// same toggle either way.
	if (reg.category === 'desktop') return opts.screenCapture;
	// An MCP server is a capability the user configured, not a Chat feature.
	// Blender and Godot are the obvious cases — driving an editor is *more*
	// useful with a repo open than it is in Chat — and the per-tool switches in
	// Settings → MCP already decide which tools the model sees. Same rule as
	// Chat, deliberately: a server enabled in one place should not silently
	// vanish in the other.
	if (reg.category === 'mcp') return isMcpToolEnabled(name);
	// Art for the project, written into it. Chat's `generate_image` is for
	// pictures in an answer, so it stays out. Offered without an image
	// backend too: a texture is drawn by code, and the tool says what the
	// other kinds need.
	if (name === 'make_asset') return opts.interactive;
	// A song for the project or the answer. The Code tab only: Shell has no
	// saved session to keep the song in.
	if (SONG_TOOLS.has(name)) return opts.musicGeneration && isCodeTab(opts);
	// Saving a picture or song made earlier into the project.
	if (name === 'save_generated') return isCodeTab(opts) && !opts.codeReadOnly;
	// Editing the videos in the project folder. The Code tab only: Shell has
	// no folder that stays put.
	if (reg.category === 'video') return opts.videoTools && isCodeTab(opts);
	return false;
}

function shouldIncludeChatTool(reg: ToolRegistration, opts: ToolFilterOpts): boolean {
	const name = reg.schema.function.name;
	// `exec` (run_command) runs arbitrary host commands — Code mode only.
	// Without this, the `return true` fall-through would leak it into Chat.
	if (reg.category === 'exec') return false;
	// Job-type-owned structured-output tools — `audit` (submit_findings /
	// submit_verdict), `planning` (submit_plan_outline), `coding`
	// (submit_preflight, ...) — are only ever exposed via an explicit
	// toolAllowlist, never the default toolset.
	if (
		reg.category === 'audit' ||
		reg.category === 'planning' ||
		reg.category === 'coding' ||
		reg.category === 'memory'
	)
		return false;
	// code_grep / code_glob are Code-mode fs tools; keep them out of Chat.
	if (CODE_ONLY_FS.has(name)) return false;
	// remember_this writes to long-term memory. Offered only when memory is
	// switched on AND its embedding model is present — memory_add embeds before
	// inserting, so without the model the call can only fail.
	if (reg.category === 'memory-write' && !opts.memoryWritable) return false;
	if (reg.category === 'fs' && !opts.hasWorkingDir) return false;
	if (reg.category === 'email' && !opts.hasEmail) return false;
	if (name === 'email_compose' && !opts.sendableEmail) return false;
	if (reg.category === 'calendar' && !opts.hasCalendar) return false;
	if (reg.category === 'contacts' && !opts.hasContacts) return false;
	if (reg.category === 'desktop' && !opts.screenCapture) return false;
	if (reg.category === 'image' && !opts.imageGeneration) return false;
	if (reg.category === 'music' && !opts.musicGeneration) return false;
	if (reg.category === 'video' && !opts.videoTools) return false;
	// make_asset writes into a project; Chat has no project.
	if (name === 'make_asset') return false;
	if (reg.category === 'sandbox' && !opts.sandboxEnabled) return false;
	// MCP tools are per-tool switchable, so the category alone is not the
	// answer; see isMcpToolEnabled for how an explicit choice beats the
	// catalog default.
	if (reg.category === 'mcp' && !isMcpToolEnabled(name)) return false;
	if (opts.deepResearch && name === 'fetch_url') return false;
	if (!opts.visionSupported && reg.requiresVision) return false;
	return true;
}

/** The Code tab: the code toolset with no live terminal behind it. */
function isCodeTab(opts: ToolFilterOpts): boolean {
	return opts.codeMode && !opts.shellMode;
}

/**
 * What a subtask never gets: another subtask, anything that asks the user or
 * opens something for them, anything left running after it ends, and art.
 */
function subtaskExcludes(reg: ToolRegistration): boolean {
	const name = reg.schema.function.name;
	return (
		name === 'delegate' ||
		name === 'make_asset' ||
		SONG_TOOLS.has(name) ||
		name === 'save_generated' ||
		CODE_TAB_ONLY.has(name) ||
		reg.category === 'video' ||
		reg.category === 'interaction' ||
		reg.category === 'desktop'
	);
}

function shouldIncludeTool(reg: ToolRegistration, opts: ToolFilterOpts): boolean {
	if (opts.subtask && subtaskExcludes(reg)) return false;
	// Checking or cancelling a background task: only an owner that has one.
	if (reg.category === 'tasks') {
		return !!opts.taskOwner && opts.interactive && getTasks(opts.taskOwner).length > 0;
	}
	// Subtasks are the user's to switch off (Settings → Code → Subtasks).
	if (reg.schema.function.name === 'delegate' && getSettings().codeSubtasks === 'off') {
		return false;
	}
	// Background-process and hand-off tools belong to the Code tab alone. Shell
	// Code mode has a real terminal for both, and Chat and Shell run nothing.
	if (CODE_TAB_ONLY.has(reg.schema.function.name)) {
		// open_in_shell hands a command to a Shell tab, so only where one works,
		// and only to a person at this computer.
		if (
			reg.schema.function.name === 'open_in_shell' &&
			(shellPlatformSupported() === false || opts.codeRemote)
		) {
			return false;
		}
		return isCodeTab(opts);
	}
	// codeMode wins over shellMode: the Shell assistant in Code mode exposes the
	// code toolset (resolved against the live shell CWD), not the plain shell set.
	if (opts.codeMode) return shouldIncludeCodeTool(reg, opts);
	if (opts.shellMode) return shouldIncludeShellTool(reg, opts);
	return shouldIncludeChatTool(reg, opts);
}

export function getToolSchemas(opts: {
	hasWorkingDir: boolean;
	deepResearch?: boolean;
	visionSupported?: boolean;
	shellMode?: boolean;
	codeMode?: boolean;
	/** A read-only Code session: the write and edit tools are left out. */
	codeReadOnly?: boolean;
	/** A Code turn started from another computer: `open_in_shell` is left out. */
	codeRemote?: boolean;
	/** A subtask's turn: no `delegate`, and nothing that needs the user. */
	subtask?: boolean;
	/** A live user is present. Gates tools that only make sense for one. */
	interactive?: boolean;
	/**
	 * When set, the turn exposes EXACTLY these tools (by name), bypassing the
	 * mode-based filters entirely. Used by audit runs to pin a turn to a precise
	 * read-only subset plus the structured-output tool (submit_findings /
	 * submit_verdict). Names not registered are silently ignored.
	 */
	toolAllowlist?: Iterable<string>;
	/**
	 * The skills this turn may load. `load_skill` is offered only when it is
	 * non-empty, with `name` narrowed to these.
	 */
	skillNames?: string[];
	/** The skills whose files it may read; the same for `read_skill_file`. */
	skillFileNames?: string[];
	/**
	 * An allowlisted turn that may also carry `haruspex_feedback` when Settings
	 * → Feedback has it on: a job's, not a remote guest's or memory's own.
	 * Every other turn carries it whenever the setting is on.
	 */
	harnessFeedback?: boolean;
	/**
	 * The turn carries skills (Chat or Shell). With `interactive`, it gets
	 * `create_skill` and `update_skill`.
	 */
	hasSkills?: boolean;
	/**
	 * The background-task owner the turn speaks for (`chat:…` or `code:…`).
	 * The `tasks` tools are offered only when it has started a task.
	 */
	taskOwner?: string;
}): ToolDefinition[] {
	if (opts.toolAllowlist) {
		const allow = new Set(opts.toolAllowlist);
		const schemas: ToolDefinition[] = [];
		for (const reg of tools.values()) {
			const name = reg.schema.function.name;
			// Sending, and writing a skill, are reviewed by a person at the
			// keyboard, and an allowlisted turn is a job's: no allowlist can
			// grant them.
			if (allow.has(name) && name !== 'email_compose' && reg.category !== 'skills-write') {
				schemas.push(reg.schema);
			} else if (reg.category === 'harness-feedback' && opts.harnessFeedback && feedbackOn()) {
				schemas.push(reg.schema);
			}
		}
		return schemas;
	}
	const interactive = opts.interactive ?? false;
	const filter: ToolFilterOpts = {
		hasWorkingDir: opts.hasWorkingDir,
		interactive,
		deepResearch: opts.deepResearch ?? false,
		visionSupported: opts.visionSupported ?? true,
		shellMode: opts.shellMode ?? false,
		codeMode: opts.codeMode ?? false,
		codeReadOnly: opts.codeReadOnly ?? false,
		codeRemote: opts.codeRemote ?? false,
		subtask: opts.subtask ?? false,
		hasEmail: hasEnabledEmailAccount(),
		hasCalendar: hasEnabledCalendarAccount(),
		hasContacts: hasEnabledContactsAccount(),
		screenCapture: getSettings().screenCaptureEnabled,
		imageGeneration: interactive && getSettings().imageBackendKind !== 'none',
		musicGeneration: interactive && getSettings().musicBackendKind !== 'none',
		videoTools: interactive && opts.hasWorkingDir && videoToolsOn(),
		sendableEmail: interactive && hasSendableEmailAccount(),
		sandboxEnabled: getSettings().sandboxEnabled && !pythonRuntimeMissing(),
		memoryWritable: memoryActive(),
		taskOwner: opts.taskOwner
	};
	const schemas: ToolDefinition[] = [];
	for (const reg of tools.values()) {
		const schema = schemaFor(reg, filter, opts);
		if (schema) schemas.push(schema);
	}
	return schemas;
}

/**
 * The schema `reg` contributes to this turn, or null. Skills tools follow the
 * turn's skills rather than its mode: offered whenever the caller handed some
 * over, never otherwise.
 */
function schemaFor(
	reg: ToolRegistration,
	filter: ToolFilterOpts,
	skills: { skillNames?: string[]; skillFileNames?: string[]; hasSkills?: boolean }
): ToolDefinition | null {
	// The user guide answers the person asking, in any mode; a job has nobody
	// asking. Remote guests get it through their allowlist.
	if (reg.category === 'guide') return filter.interactive && !filter.subtask ? reg.schema : null;
	// Every mode, subtasks and all: friction is friction wherever it happens.
	if (reg.category === 'harness-feedback') return feedbackOn() ? reg.schema : null;
	if (reg.category === 'skills-write') {
		if (!skills.hasSkills || !filter.interactive || filter.codeReadOnly || filter.subtask) {
			return null;
		}
		// The repo's AGENTS.md is a Code mode file, like the repo itself.
		if (reg.schema.function.name === 'write_agents_md') {
			return filter.codeMode ? reg.schema : null;
		}
		// A repo's skills folder is only a destination in Code mode.
		return filter.codeMode ? reg.schema : withoutWhere(reg.schema);
	}
	if (reg.category === 'skills') {
		const names =
			reg.schema.function.name === 'read_skill_file' ? skills.skillFileNames : skills.skillNames;
		return names?.length ? withSkillEnum(reg.schema, names) : null;
	}
	if (!shouldIncludeTool(reg, filter)) return null;
	// Saving a song needs a folder that may be written: the Code tab's
	// project, or Chat's working folder.
	const canSave = filter.codeMode ? !filter.codeReadOnly : filter.hasWorkingDir;
	const name = reg.schema.function.name;
	if ((SONG_TOOLS.has(name) || IMAGE_TOOLS.has(name)) && !canSave) {
		return withoutProjectWrite(reg.schema);
	}
	return profileSchema(reg.schema, filter);
}

/**
 * The registered wording is Shell Code mode's (a live terminal); the Code tab
 * swaps in its own where a tool behaves differently there.
 */
function profileSchema(schema: ToolDefinition, filter: ToolFilterOpts): ToolDefinition {
	if (schema.function.name === 'delegate') return delegateSchema(schema, filter);
	const override = isCodeTab(filter) ? CODE_TAB_DESCRIPTIONS[schema.function.name] : undefined;
	return override ? withDescription(schema, override) : schema;
}

/**
 * `delegate` offers write mode only where Settings → Code → Subtasks allows
 * it and the session may write; otherwise its `mode` is read alone.
 */
function delegateSchema(schema: ToolDefinition, filter: ToolFilterOpts): ToolDefinition {
	if (getSettings().codeSubtasks === 'write' && !filter.codeReadOnly) return schema;
	const params = schema.function.parameters as {
		properties: Record<string, Record<string, unknown>>;
	};
	return {
		...schema,
		function: {
			...schema.function,
			parameters: {
				...params,
				properties: {
					...params.properties,
					mode: {
						type: 'string',
						enum: ['read'],
						description: 'read: the subtask reads and searches the project only.'
					}
				}
			}
		}
	};
}

/** A schema with its description, and any named parameters', replaced. */
function withDescription(schema: ToolDefinition, override: DescriptionOverride): ToolDefinition {
	const params = schema.function.parameters as {
		properties: Record<string, Record<string, unknown>>;
	};
	const properties = { ...params.properties };
	for (const [name, description] of Object.entries(override.params ?? {})) {
		if (properties[name]) properties[name] = { ...properties[name], description };
	}
	return {
		...schema,
		function: {
			...schema.function,
			description: override.description,
			parameters: { ...params, properties }
		}
	};
}

/**
 * Image and music generation spend GPU minutes, so the same gate as the
 * schema: a backend, and someone there to see or hear the result. Video tools
 * likewise: the switch, the binaries, a folder, and someone there. make_asset
 * checks the image backend itself, since its textures are drawn by code
 * without one. Null when the call may go ahead.
 */
function generationRefusal(reg: ToolRegistration, ctx: ToolContext): string | null {
	const s = getSettings();
	if (reg.category === 'image') {
		if (s.imageBackendKind === 'none' && reg.schema.function.name !== 'make_asset') {
			return 'Image generation is not set up. The user can choose a backend in Settings → Image.';
		}
		if (!ctx.interactive)
			return 'Image generation is only available in a conversation with the user.';
	}
	if (reg.category === 'video') {
		if (!s.videoEditingEnabled)
			return 'Video tools are off. The user can turn them on in Settings → Video editing.';
		if (!ctx.interactive) return 'Video tools are only available in a conversation with the user.';
		if (ctx.shellMode) return 'Video tools work in Chat and the Code tab, not the Shell tab.';
		if (!ctx.workingDir) return 'Video tools need a working folder. The user can pick one.';
		if (!videoAvailable()) {
			return 'Video tools need ffmpeg, ffprobe and melt. The user can check Settings → Video editing.';
		}
	}
	if (reg.category === 'music') {
		if (s.musicBackendKind === 'none') {
			return 'Music generation is off. The user can choose a backend in Settings → Music.';
		}
		if (!ctx.interactive)
			return 'Music generation is only available in a conversation with the user.';
	}
	return null;
}

/** A generate tool without `path` and `overwrite`, where there's no folder to write in. */
function withoutProjectWrite(schema: ToolDefinition): ToolDefinition {
	const params = schema.function.parameters as { properties: Record<string, unknown> };
	const properties = { ...params.properties };
	delete properties.path;
	delete properties.overwrite;
	return {
		...schema,
		function: { ...schema.function, parameters: { ...params, properties } }
	};
}

/** A schema without its `where` parameter, if it has one. */
function withoutWhere(schema: ToolDefinition): ToolDefinition {
	const params = schema.function.parameters as { properties: Record<string, unknown> };
	if (!('where' in params.properties)) return schema;
	const properties = { ...params.properties };
	delete properties.where;
	return {
		...schema,
		function: { ...schema.function, parameters: { ...params, properties } }
	};
}

/**
 * A skills tool's schema with `name` limited to the turn's skills, so the
 * model picks from what exists instead of inventing a plausible name.
 */
function withSkillEnum(schema: ToolDefinition, names: string[]): ToolDefinition {
	const params = schema.function.parameters as {
		properties: Record<string, Record<string, unknown>>;
	};
	return {
		...schema,
		function: {
			...schema.function,
			parameters: {
				...params,
				properties: { ...params.properties, name: { ...params.properties.name, enum: names } }
			}
		}
	};
}

/** Settings → Feedback → Model feedback on tools. */
function feedbackOn(): boolean {
	return getSettings().agentFeedbackEnabled === true;
}

/**
 * Execute a tool by name. Replaces the 30-arm switch statement.
 */
export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	ctx: ToolContext
): Promise<ToolExecOutput> {
	const reg = tools.get(name);
	if (!reg) {
		const hint = nearestToolName(name);
		return toolResult(toolError(`Unknown tool: ${name}${hint ? `. Did you mean ${hint}?` : ''}`));
	}

	// Hard gate on the sandbox master switch — enforced HERE, not just by
	// filtering sandbox tools out of the schema in getToolSchemas(). A small
	// model can still emit a `run_python` call it was never offered (a
	// training-prior hallucination), and this function resolves the name
	// against the FULL registry, so schema filtering alone doesn't actually
	// stop execution. Without this check, disabling the sandbox in Settings
	// fails to prevent code from running.
	if (reg.category === 'sandbox' && !getSettings().sandboxEnabled) {
		return toolResult(
			toolError('Python sandbox is disabled. Enable it in Settings → Agent to run code.')
		);
	}
	if (reg.category === 'sandbox' && pythonRuntimeMissing()) {
		return toolResult(toolError(PYTHON_UNAVAILABLE));
	}

	// Same hard gate for memory writes, and for the same reason: schema
	// filtering alone doesn't stop execution, because this function resolves
	// the name against the FULL registry and a small model can emit a call it
	// was never offered. Without this, switching memory off in Settings would
	// fail to prevent writes.
	if (reg.category === 'memory-write' && !memoryActive()) {
		return toolResult(
			toolError(
				'Long-term memory is off, or its embedding model has not been downloaded. ' +
					'Nothing was saved. The user can turn it on in Settings → Memory.'
			)
		);
	}

	if (reg.category === 'harness-feedback' && !feedbackOn()) {
		return toolResult(
			toolError('Feedback on tools is off. The user can turn it on in Settings → Feedback.')
		);
	}

	// Skills reach only the turns that were handed some; a call from any
	// other turn is one the model was never offered.
	if (reg.category === 'skills' && !ctx.skills) {
		return toolResult(toolError('Skills are not available in this conversation.'));
	}

	// Writing a skill needs someone to approve it: a job or a remote guest's
	// turn never gets these tools, and must not run them by guessing the name.
	if (reg.category === 'skills-write' && (!ctx.skills || !ctx.interactive)) {
		return toolResult(
			toolError('Skills can only be saved in a conversation with the user in Chat or Shell.')
		);
	}

	// The same hard gate for calendars. Schema filtering does not stop
	// execution — executeTool resolves against the FULL registry — and a
	// calendar call with no account reaches a CalDAV request that can only
	// fail, which is a slower and less useful answer than saying so here.
	if (reg.category === 'calendar' && !hasEnabledCalendarAccount()) {
		return toolResult(
			toolError('No calendar account is set up. The user can add one in Settings → Integrations.')
		);
	}

	// The same hard gate for screen capture, and here it is the one that
	// matters most: the toggle is the user's statement about whether this
	// assistant may look at their screen at all, and schema filtering alone
	// would leave it enforced only by the model's good behaviour.
	if (reg.category === 'desktop' && !getSettings().screenCaptureEnabled) {
		return toolResult(
			toolError('Screen capture is off. The user can turn it on in Settings → Screen.')
		);
	}

	const generation = generationRefusal(reg, ctx);
	if (generation) return toolResult(toolError(generation));

	// And for contacts, which is a separate account capability: a server can
	// serve calendars and not address books.
	if (reg.category === 'contacts' && !hasEnabledContactsAccount()) {
		return toolResult(
			toolError('No contacts account is set up. The user can add one in Settings → Integrations.')
		);
	}

	// Same hard gate again, for MCP. Identical reasoning to the two above, and
	// it matters more here: an MCP tool can reach a third-party service and
	// change something there, so a tool the user switched off must not run
	// because a small model guessed its name from the ones it *was* offered.
	if (reg.category === 'mcp' && !isMcpToolEnabled(name)) {
		return toolResult(
			toolError(`${name} is switched off. The user can enable it in Settings → Integrations.`)
		);
	}

	// Guard: fs/exec tools require a working directory in Chat/Code mode. In
	// Shell mode the absolute-path variants are dispatched instead, so
	// workingDir is allowed to be null.
	if ((reg.category === 'fs' || reg.category === 'exec') && !ctx.workingDir && !ctx.shellMode) {
		return toolResult(toolError('No working directory set'));
	}

	// A turn started from another computer hands nothing to a Shell tab here,
	// offered the tool or not.
	if (ctx.codeRemote && name === 'open_in_shell') {
		return toolResult(toolError(REMOTE_HANDOFF_REFUSAL));
	}

	// A read-only Code session never writes, offered the tool or not.
	if (ctx.codeReadOnly && (isCodeWriteTool(name) || reg.category === 'skills-write')) {
		return toolResult(toolError(READ_ONLY_REFUSAL));
	}

	// Absorb sloppy-but-unambiguous arg shapes (stringified JSON, "5" for
	// an integer, ...) before the executor's own validation runs — see
	// coerce.ts. Saves a whole model round-trip per avoided error.
	const coerced = coerceArgsToSchema(reg.schema.function.parameters, args);

	// One writer per folder: a Code session's write takes the folder first,
	// and reports what it changed to the sessions sharing it.
	const guard = ctx.codeWriteGuard && isCodeWriteTool(name) ? ctx.codeWriteGuard : null;
	if (!guard) return reg.execute(coerced, ctx);
	const refusal = await guard.acquire();
	if (refusal) return toolResult(toolError(refusal));
	const before = new Set(ctx.filesWrittenThisTurn);
	const out = await reg.execute(coerced, ctx);
	guard.changed(changedFiles(name, coerced, out, before, ctx.filesWrittenThisTurn));
	return out;
}

/**
 * The files a successful write or edit changed: what an fs_write_* added to
 * the turn's written set, or an edit's path when it reports "Edited".
 */
function changedFiles(
	name: string,
	args: Record<string, unknown>,
	out: ToolExecOutput,
	before: Set<string>,
	after: Set<string>
): string[] {
	if (name === 'fs_edit_text') {
		return out.result.startsWith('Edited ') && typeof args.path === 'string' ? [args.path] : [];
	}
	if (name === 'make_asset') {
		if (!out.result.startsWith('Wrote ') || typeof args.path !== 'string') return [];
		if (args.kind === 'transition') return transitionFiles(args.path);
		return args.kind === 'texture' ? textureFiles(args.path, args.variants) : [args.path];
	}
	return [...after].filter((p) => !before.has(p));
}

/**
 * A call's arguments as its executor will see them: coerced toward the tool's
 * schema (see coerce.ts). For anything that reads a call before it runs — a
 * stage capturing a structured answer from `onToolStart` — so it reads the
 * same arguments the tool does. Unknown tools pass through unchanged.
 */
export function coerceCallArguments(
	name: string,
	args: Record<string, unknown>
): Record<string, unknown> {
	const reg = tools.get(name);
	return reg ? coerceArgsToSchema(reg.schema.function.parameters, args) : args;
}

/**
 * Closest registered tool name for a hallucinated one, so the model can
 * recover in one step instead of dead-ending on "Unknown tool".
 */
function nearestToolName(name: string): string | null {
	let best: string | null = null;
	let bestDist = 4; // suggest only within edit distance 3
	for (const candidate of tools.keys()) {
		const d = editDistance(name, candidate);
		if (d < bestDist) {
			bestDist = d;
			best = candidate;
		}
	}
	// Fallback: a distinctive substring match ("write_file" → fs_write_text
	// is too far for edit distance, but "pdf" → fs_write_pdf isn't needed;
	// keep it simple and only do edit distance plus suffix containment).
	if (!best) {
		const lower = name.toLowerCase();
		for (const candidate of tools.keys()) {
			if (candidate.toLowerCase().includes(lower) || lower.includes(candidate.toLowerCase())) {
				return candidate;
			}
		}
	}
	return best;
}

function editDistance(a: string, b: string): number {
	if (Math.abs(a.length - b.length) > 3) return 99;
	const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0];
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = prev[j];
			prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = tmp;
		}
	}
	return prev[b.length];
}

/**
 * Extract a human-readable label from tool arguments for the search
 * step UI. Replaces the onToolStart switch in chat.svelte.ts.
 */
export function getDisplayLabel(name: string, args: Record<string, unknown>): string {
	const reg = tools.get(name);
	if (!reg) return JSON.stringify(args).slice(0, 60);
	return reg.displayLabel(args);
}
