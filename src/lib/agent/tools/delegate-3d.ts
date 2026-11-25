/**
 * `delegate_3d`: the Code tab's agent hands one 3D asset to the 3D delegate,
 * a subtask on the model set in Settings → Code → Helpers → 3D. It starts
 * with an empty context, writes the build module and animation module, checks
 * them with `check_3d` and writes the .glb, and may write nothing else. When
 * it ends, the same check runs in code on the files on disk
 * (`finalCheck3d`): a failing one sends it back once, and the result says
 * whether errors remain.
 *
 * Owned by the 3D helper and offered only while a delegate model is set
 * (`registry.ts`). It shares `delegate`'s per-turn limit, but not its
 * setting: Settings → Code → Subtasks is not read.
 */
import { invoke } from '@tauri-apps/api/core';
import { check3dHost } from '#lib/agent/tools/check-3d.ts';
import {
	runInForeground,
	startInBackground,
	SUBTASKS_PER_TURN
} from '#lib/agent/tools/delegate.ts';
import { MAX_PENDING_IMAGES } from '#lib/agent/tools/fs-read.ts';
import { fsWorkdir, writableKey } from '#lib/agent/tools/_helpers.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult } from '#lib/agent/tools/types.ts';
import type { CodeWriteGuard, ToolContext, ToolExecOutput } from '#lib/agent/tools/types.ts';
import { newSubtaskState } from '#lib/code/subtask.ts';
import type { SubtaskProfile, SubtaskUsage } from '#lib/code/subtaskProfile.ts';
import type { SubtaskResult } from '#lib/code/runSubtask.ts';
import type { SubtaskSpec } from '#lib/code/subtaskRun.ts';
import { formatCost, formatTokens } from '#lib/code/usageTotals.ts';
import {
	finalCheck3d,
	lastCheckOptions,
	type FinalCheck3d
} from '#lib/helpers/three/delegateCheck.ts';
import type { Check3dHost } from '#lib/helpers/three/call.ts';
import { delegate3dConfig, type Delegate3dConfig } from '#lib/helpers/three/delegateConfig.ts';
import {
	delegate3dFiles,
	delegate3dFinalReport,
	delegate3dFirstMessage,
	delegate3dSystemPrompt,
	type Delegate3dFiles
} from '#lib/helpers/three/delegatePrompt.ts';
import { errMessage } from '#lib/utils/error.ts';

/** The most reference images one call may send. */
export const MAX_DELEGATE_IMAGES = 3;
/** The largest reference image, in bytes. */
export const MAX_DELEGATE_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;

/** The tools the delegate is offered, and no others. */
export const DELEGATE_3D_TOOLS = [
	'fs_list_dir',
	'fs_read_text',
	'fs_read_image',
	'code_grep',
	'code_glob',
	'fs_write_text',
	'fs_edit_text',
	'check_3d'
];

const NO_DELEGATE = 'No 3D delegate model is set. Set one in Settings → Code → Helpers → 3D.';

/** The label shown for a call: the model's, else "3D: <file name>". */
export function delegate3dLabel(args: Record<string, unknown>): string {
	const label = typeof args.label === 'string' ? args.label.trim() : '';
	if (label) return label;
	const path = typeof args.path === 'string' ? args.path.trim() : '';
	return `3D: ${path.split(/[/\\]/).pop() || 'asset'}`;
}

/** Why this call can't start, or null when it can (the arguments come after). */
function refusal(args: Record<string, unknown>, ctx: ToolContext): string | null {
	if (ctx.subtask) return 'A subtask cannot start subtasks of its own.';
	if (!ctx.workingDir) return 'No project folder set.';
	if (ctx.codeReadOnly) return 'This session is read-only: delegate_3d writes files.';
	if (!delegate3dConfig().backend) return NO_DELEGATE;
	if (args.background === true && !ctx.startBackgroundSubtask) {
		return 'Background calls are not available here; leave background off.';
	}
	if ((ctx.subtasksStartedThisTurn?.count ?? 0) >= SUBTASKS_PER_TURN) {
		return `This turn has already started ${SUBTASKS_PER_TURN} subtasks, the most it may. Do the rest yourself.`;
	}
	return null;
}

/** The three files, relative to the folder, or why `path` can't be used. */
function filesFor(raw: unknown, ctx: ToolContext): Delegate3dFiles | string {
	const path = typeof raw === 'string' ? raw.trim() : '';
	if (!/\.glb$/i.test(path)) return 'path must be where the .glb goes, ending in .glb.';
	const key = writableKey(ctx, path);
	if (key === null) return 'path must be inside the project folder.';
	return delegate3dFiles(key) ?? 'path must be where the .glb goes, ending in .glb.';
}

/** Whether `relPath` exists in the folder. */
async function exists(ctx: ToolContext, relPath: string): Promise<boolean> {
	try {
		return await invoke<boolean>('fs_path_exists', { workdir: fsWorkdir(ctx), relPath });
	} catch {
		return false;
	}
}

/** The reference images as data URLs, or why one can't be used. */
async function loadImages(
	raw: unknown,
	ctx: ToolContext
): Promise<{ path: string; dataUrl: string }[] | string> {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.some((p) => typeof p !== 'string' || !p.trim())) {
		return 'images must be a list of file paths.';
	}
	if (raw.length > MAX_DELEGATE_IMAGES) return `Pass at most ${MAX_DELEGATE_IMAGES} images.`;
	const out: { path: string; dataUrl: string }[] = [];
	const workdir = fsWorkdir(ctx);
	for (const p of raw as string[]) {
		const path = writableKey(ctx, p.trim());
		if (path === null) return `${p}: images must be inside the project folder.`;
		if (!IMAGE_FILE.test(path)) return `${path}: images must be PNG, JPEG or WebP.`;
		try {
			const bytes = await invoke<number[]>('fs_read_bytes', { workdir, relPath: path });
			if (bytes.length > MAX_DELEGATE_IMAGE_BYTES) return `${path} is over 8 MB.`;
			out.push({
				path,
				dataUrl: await invoke<string>('fs_read_image', { workdir, relPath: path })
			});
		} catch (e) {
			return `Could not read ${path}: ${errMessage(e)}`;
		}
	}
	return out;
}

/**
 * The final check's host: the turn's folder, writing only the GLB, showing
 * the sheet to nobody, and stopped by nothing (a background call outlives
 * its turn's signal). Its write takes the folder's lease and reports the GLB
 * through `guard`, as the delegate's own writes do: the turn's in the
 * foreground, a per-write one in the background.
 */
export function finalHost(
	ctx: ToolContext,
	files: Delegate3dFiles,
	guard: CodeWriteGuard | undefined
): Check3dHost {
	const host = check3dHost({
		...ctx,
		writablePaths: [files.glb],
		pendingImages: [],
		signal: undefined,
		onProgress: undefined
	});
	if (!guard) return host;
	return {
		...host,
		write: async (path, bytes) => {
			const refused = await guard.acquire();
			if (refused) return refused;
			const failed = await host.write(path, bytes);
			guard.changed(failed ? [] : [files.glb]);
			return failed;
		}
	};
}

/** A file's text, or '' when it can't be read. */
async function readText(ctx: ToolContext, relPath: string): Promise<string> {
	try {
		const bytes = await invoke<number[]>('fs_read_bytes', { workdir: fsWorkdir(ctx), relPath });
		return new TextDecoder().decode(new Uint8Array(bytes));
	} catch {
		return '';
	}
}

/**
 * Why `files` can't be the delegate's, or null: a module path that already
 * holds a file with no default export is some other script (a game's
 * `player.js` beside `player.glb`), not a build module to edit.
 */
async function notBuildModules(ctx: ToolContext, files: Delegate3dFiles): Promise<string | null> {
	for (const path of [files.module, files.anim]) {
		if (!(await exists(ctx, path))) continue;
		const text = await readText(ctx, path);
		if (!/\bexport\s+default\b/.test(text)) {
			return `${path} already exists and is not a build or animation module (it has no export default). Pick another name for the .glb, so the delegate's modules don't replace it.`;
		}
	}
	return null;
}

/** The nudge for a failing final check, or null when it passes. */
export function delegate3dNudge(check: FinalCheck3d): string | null {
	if (check.ok) return null;
	return `The final check still fails:\n${check.problems.join('\n')}\nFix them, run check_3d, then give your report.`;
}

/** What the parent is told once the delegate ends. */
export function delegate3dResultText(
	label: string,
	res: SubtaskResult,
	check: FinalCheck3d,
	written: string[],
	usage: SubtaskUsage,
	byUser = false
): string {
	const calls = res.steps.length;
	const head = `3D delegate "${label}" (${res.outcome}, ${calls} tool call${calls === 1 ? '' : 's'})`;
	const body =
		res.outcome === 'done'
			? `${head}:\n\n${res.report || '(It gave no report.)'}`
			: res.outcome === 'stopped'
				? `${head}: ${byUser ? 'the user stopped it; do not start it again' : 'stopped before it finished'}.${res.report ? `\n\nWhat it had so far:\n${res.report}` : ''}`
				: `${head}: ${res.error ?? 'it failed.'}`;
	const verdict = check.ok
		? 'Final check: clean.'
		: `Final check: errors remain:\n${check.problems.join('\n')}`;
	const files = `Files: ${written.length ? written.join(', ') : 'none written'}.`;
	const cost =
		usage.costUsd !== null
			? `Cost: ${formatCost(usage.costUsd)} (${formatTokens(usage.tokens)} tokens).`
			: usage.tokens > 0
				? `Tokens: ${formatTokens(usage.tokens)}.`
				: '';
	return [body, '', verdict, files, ...(cost ? [cost] : [])].join('\n');
}

/** The delegate's profile for one call. */
function profileFor(
	ctx: ToolContext,
	config: Delegate3dConfig & { backend: NonNullable<Delegate3dConfig['backend']> },
	files: Delegate3dFiles,
	label: string,
	firstMessage: string,
	images: { path: string; dataUrl: string }[]
): SubtaskProfile {
	return {
		backend: config.backend,
		system: delegate3dSystemPrompt(),
		firstMessage,
		images,
		tools: DELEGATE_3D_TOOLS,
		helpers: ['3d'],
		writablePaths: [files.module, files.anim, files.glb],
		maxRounds: config.maxRounds,
		maxCostUsd: config.maxCostUsd,
		finalReport: delegate3dFinalReport,
		doneCheck: async (steps, run) =>
			delegate3dNudge(
				await finalCheck3d(
					files,
					finalHost(ctx, files, run.guard),
					lastCheckOptions(steps, files.module)
				)
			),
		finish: async (res, usage, run) => {
			const check = await finalCheck3d(
				files,
				finalHost(ctx, files, run.guard),
				lastCheckOptions(res.steps, files.module)
			);
			const all = [files.module, files.anim, files.glb];
			const there = await Promise.all(all.map((f) => exists(ctx, f)));
			const written = all.filter((_, i) => there[i]);
			const text = delegate3dResultText(label, res, check, written, usage, run.stoppedByUser);
			return { text, ...(check.png ? { png: check.png } : {}) };
		}
	};
}

/** Show the final sheet to the parent, when its model can see. */
function attachSheet(ctx: ToolContext, path: string, png: string | undefined): void {
	if (!png || ctx.visionSupported === false) return;
	if (ctx.pendingImages.length >= MAX_PENDING_IMAGES) return;
	ctx.pendingImages.push({ path, dataUrl: png });
}

export async function executeDelegate3d(
	args: Record<string, unknown>,
	ctx: ToolContext
): Promise<ToolExecOutput> {
	const refused = refusal(args, ctx);
	if (refused) return toolResult(toolError(refused));
	const files = filesFor(args.path, ctx);
	if (typeof files === 'string') return toolResult(toolError(files));
	const task = typeof args.task === 'string' ? args.task.trim() : '';
	if (!task) return toolResult(toolError('delegate_3d requires a task.'));
	const images = await loadImages(args.images, ctx);
	if (typeof images === 'string') return toolResult(toolError(images));
	const config = delegate3dConfig();
	if (!config.backend) return toolResult(toolError(NO_DELEGATE));
	const foreign = await notBuildModules(ctx, files);
	if (foreign) return toolResult(toolError(foreign));

	const label = delegate3dLabel(args);
	const [module, anim] = await Promise.all([exists(ctx, files.module), exists(ctx, files.anim)]);
	const firstMessage = delegate3dFirstMessage({
		path: files.module,
		anim: files.anim,
		glb: files.glb,
		task,
		existing: { module, anim },
		imagePaths: images.map((i) => i.path)
	});
	const background = args.background === true;
	if (ctx.subtasksStartedThisTurn) ctx.subtasksStartedThisTurn.count += 1;
	const spec: SubtaskSpec = {
		id: ctx.toolCallId ?? `subtask-${Date.now()}`,
		label,
		task,
		mode: 'write',
		wt: null,
		profile: profileFor(
			ctx,
			{ ...config, backend: config.backend },
			files,
			label,
			firstMessage,
			images
		)
	};
	const initial = newSubtaskState(spec.id, label, task, 'write', background);
	if (background) return startInBackground(ctx, spec, initial);

	const res = await runInForeground(ctx, spec, initial, ctx.workingDir as string);
	if (res.failed) return toolResult(toolError(res.text));
	attachSheet(ctx, files.glb, res.png);
	return toolResult(res.text, res.png);
}

registerTool({
	category: 'exec',
	usesModel: true,
	schema: {
		type: 'function',
		function: {
			name: 'delegate_3d',
			description:
				"Hand one 3D asset to the 3D delegate model: it writes the build module and animation module, checks them with check_3d until clean, and writes the .glb. It can't see this conversation: put everything it needs in task. To change an asset it made, call again with the same path.",
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description:
							'Where the .glb goes, relative to the session folder. The modules go beside it (name.js, name.anim.js).'
					},
					task: {
						type: 'string',
						description:
							'What to make: size in metres, style, target engine, clips, and anything from the project it needs to fit.'
					},
					images: {
						type: 'array',
						items: { type: 'string' },
						description: `Up to ${MAX_DELEGATE_IMAGES} reference images in the project (PNG, JPEG or WebP, 8 MB each).`
					},
					label: {
						type: 'string',
						description: 'A few words naming the asset, shown to the user.'
					},
					background: {
						type: 'boolean',
						description:
							"Return at once and let it run on; you'll get a notification turn with its report when it finishes. Default false: wait for its report."
					}
				},
				required: ['path', 'task']
			}
		}
	},
	displayLabel: delegate3dLabel,
	execute: executeDelegate3d
});
