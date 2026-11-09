/**
 * The flow every kind that gets a Three.js HTML page from its model shares:
 * generate (or re-read the saved source on `recheck`), save the source, run
 * it headless, let the kind check the result, and report. A failed check
 * leaves the source in place and tells the main model how to fix it and
 * check again, so repairs happen in the open with its own edit tools.
 */
import { assetIo, writeAsset } from '#lib/agent/tools/_assetIo.ts';
import { ctxCwd } from '#lib/agent/tools/_helpers.ts';
import { resolveShellPath } from '#lib/utils/shellPath.ts';
import { toolError, toolResult, type ToolExecOutput } from '#lib/agent/tools/types.ts';
import { callOptionsFrom, callSpecialist } from '#lib/specialists/call.ts';
import { effectiveSampling } from '#lib/specialists/entries.ts';
import { extractHtml } from '#lib/specialists/three/extract.ts';
import {
	runAssetHtml,
	type AssetRunResult,
	type RunError
} from '#lib/specialists/three/runHtml.ts';
import type { SpecialistEntry, SpecialistRun } from '#lib/specialists/types.ts';
import { errMessage } from '#lib/utils/error.ts';

/** The source and output, as the model wrote them and as the file commands want them. */
export interface HtmlKindPaths {
	source: string;
	target: string;
	sourceAbs: string;
	targetAbs: string;
}

export type HtmlKindOutcome =
	{ ok: true; output: ToolExecOutput } | { ok: false; problems: string[] };

export interface HtmlKindSpec {
	/** The relative source and target paths for these args, or a refusal. Checks shape only. */
	sourcePath(args: Record<string, unknown>): { source: string; target: string } | string;
	/** Added to every request. */
	requestSuffix: string;
	runOptions: { export: boolean };
	/** Check the run and, when it passes, write the output and say what was made. */
	finish(
		result: AssetRunResult,
		paths: HtmlKindPaths,
		run: SpecialistRun
	): Promise<HtmlKindOutcome>;
}

/** The params every HTML kind declares, with one schema (the registry requires it). */
export const HTML_KIND_PARAMS = {
	path: {
		schema: {
			type: 'string',
			description: 'Where to save the output, relative to the session folder.'
		},
		required: false
	},
	recheck: {
		schema: {
			type: 'string',
			description:
				'Path of a source file this tool saved earlier; re-runs it as it is, without generating. Pass it with name alone.'
		},
		required: false
	},
	overwrite: {
		schema: { type: 'boolean', description: 'Replace an existing output file.' },
		required: false
	}
} as const;

/** The tool card's label for a recheck; null keeps the default. */
export function htmlCallLabel(
	entry: SpecialistEntry,
	args: Record<string, unknown>
): string | null {
	if (typeof args.recheck !== 'string') return null;
	return `${entry.name}: recheck ${args.recheck.split(/[\\/]/).pop()}`;
}

function errorLine(e: RunError): string {
	return e.line === null ? `- ${e.message}` : `- line ${e.line}: ${e.message}`;
}

/** What the model reads when the check fails: every error, then how to go on. */
export function failureReport(
	errors: RunError[],
	problems: string[],
	source: string,
	name: string
): string {
	return [
		'The check failed.',
		...errors.map(errorLine),
		...problems.map((p) => `- ${p}`),
		`The source is at ${source}. Fix it with your edit tools, then call ask_specialist with name '${name}' and recheck '${source}'.`
	].join('\n');
}

function decode(bytes: number[]): string {
	return new TextDecoder().decode(new Uint8Array(bytes));
}

type Prepared = { mode: 'generate' | 'recheck'; paths: HtmlKindPaths; ignored: string[] } | string;

/**
 * Why a new draft can't start: what is missing, and the argument names that
 * did arrive. A model whose `request` was dropped on the way (seen with
 * deepseek-v4.1-flash, 2026-11-04) sent the same call seven times against a
 * bare "Pass request and path"; the list shows it the field never came.
 */
function draftRefusal(run: SpecialistRun): string {
	const missing = [
		...(run.request === undefined ? ['request'] : []),
		...(typeof run.args.path !== 'string' ? ['path'] : [])
	];
	const got = Object.keys(run.args).filter((k) => k !== 'name');
	const had = got.length ? got.join(', ') : 'only name';
	return `A new draft needs request and path; to re-run a saved source, pass recheck alone. This call is missing ${missing.join(' and ')} (it had ${had}).`;
}

/** The call's mode and paths, or why it can't run. */
function prepare(run: SpecialistRun, spec: HtmlKindSpec): Prepared {
	const { args, request, images, ctx } = run;
	const recheck = typeof args.recheck === 'string';
	// A recheck re-runs the saved source, so a request, path or images can't
	// change it: run it anyway and say they went unused. Refusing left a model
	// with no call it could see as valid (2026-11-04).
	const ignored = recheck
		? [
				...(request !== undefined ? ['request'] : []),
				...(args.path !== undefined ? ['path'] : []),
				...(images.length ? ['images'] : [])
			]
		: [];
	if (!recheck && (request === undefined || typeof args.path !== 'string')) {
		return draftRefusal(run);
	}
	const shape = spec.sourcePath(recheck ? { ...args, path: undefined } : args);
	if (typeof shape === 'string') return shape;
	const cwd = ctxCwd(ctx);
	return {
		mode: recheck ? 'recheck' : 'generate',
		paths: {
			...shape,
			sourceAbs: resolveShellPath(shape.source, cwd),
			targetAbs: resolveShellPath(shape.target, cwd)
		},
		ignored
	};
}

/** The line a recheck adds when the call also carried draft-only arguments. */
function ignoredNote(ignored: string[]): string[] {
	if (!ignored.length) return [];
	return [
		`Rechecked the saved source as it is; ${ignored.join(', ')} only go with a new draft, so they were not used.`
	];
}

/** Put `lines` ahead of a result. */
function withLines(output: ToolExecOutput, lines: string[]): ToolExecOutput {
	return lines.length ? { ...output, result: [...lines, output.result].join('\n') } : output;
}

/**
 * What the model reads when the specialist's answer hit `max_tokens`. The
 * output is what ran out, not the request: a 350-word request read as "too
 * long" (2026-11-04), so say what the tokens went on.
 */
export function outOfTokens(
	max: number,
	answer: { content: string; reasoning?: string; completionTokens: number | null }
): string {
	const used = answer.completionTokens ?? max;
	const thought = answer.reasoning?.length ?? 0;
	const spent =
		thought > answer.content.length
			? 'most of it on thinking: turn Thinking off for it in Settings → Code → Specialists'
			: 'and the page was still not finished';
	return `The specialist wrote ${used.toLocaleString('en-US')} tokens (its limit is ${max}) ${spent}. The limit is on what it writes, not on the request: ask for fewer parts in one call (one draft per part, then combine them), or raise Max tokens in Settings → Code → Specialists.`;
}

/** The page the model wrote, saved at the source; or the error to return. */
async function generate(
	run: SpecialistRun,
	spec: HtmlKindSpec,
	paths: HtmlKindPaths
): Promise<string | { error: string }> {
	const { entry, request, images, ctx, args } = run;
	const io = assetIo(ctx);
	// Refuse before minutes of generation, not after.
	const taken = await writeAsset(
		paths.targetAbs,
		new Uint8Array(),
		args.overwrite === true,
		true,
		io
	);
	if (taken) return { error: taken.replace(paths.targetAbs, paths.target) };
	const answer = await callSpecialist(entry, `${request ?? ''}${spec.requestSuffix}`, {
		...callOptionsFrom(ctx),
		images
	});
	if (answer.finishReason === 'length') {
		return { error: outOfTokens(effectiveSampling(entry).max_tokens, answer) };
	}
	const html = extractHtml(answer.content);
	if (!html) {
		return {
			error: `The specialist answered without an HTML page: ${answer.content.slice(0, 500)}`
		};
	}
	const refused = await writeAsset(
		paths.sourceAbs,
		new TextEncoder().encode(html),
		true,
		false,
		io
	);
	return refused ? { error: refused } : html;
}

export async function runHtmlKind(run: SpecialistRun, spec: HtmlKindSpec): Promise<ToolExecOutput> {
	const prepared = prepare(run, spec);
	if (typeof prepared === 'string') return toolResult(toolError(prepared));
	const { mode, paths } = prepared;
	const note = ignoredNote(prepared.ignored);
	let html: string;
	if (mode === 'recheck') {
		try {
			html = decode(await assetIo(run.ctx).read(paths.sourceAbs));
		} catch (e) {
			return toolResult(toolError(`Could not read ${paths.source}: ${errMessage(e)}`));
		}
	} else {
		const made = await generate(run, spec, paths);
		if (typeof made !== 'string') return toolResult(toolError(made.error));
		html = made;
	}
	run.ctx.onProgress?.('Running');
	const result = await runAssetHtml(html, { signal: run.ctx.signal, ...spec.runOptions });
	// Any error fails the run, before `finish` can write anything.
	if (result.errors.length) {
		return withLines(
			toolResult(failureReport(result.errors, [], paths.source, run.entry.name)),
			note
		);
	}
	const outcome = await spec.finish(result, paths, run);
	if (!outcome.ok) {
		return withLines(
			toolResult(failureReport([], outcome.problems, paths.source, run.entry.name)),
			note
		);
	}
	return withLines(outcome.output, note);
}
