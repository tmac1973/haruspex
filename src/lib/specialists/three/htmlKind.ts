/**
 * The flow every kind that gets a Three.js HTML page from its model shares:
 * generate (or re-read the saved source on `recheck`), save the source, run
 * it headless, let the kind check the result, and report. A failed check
 * leaves the source in place and tells the main model how to fix it and
 * check again, so repairs happen in the open with its own edit tools.
 */
import { assetIo, writeAsset } from '#lib/agent/tools/_assetIo.ts';
import { ctxCwd, resolveShellPath } from '#lib/agent/tools/_helpers.ts';
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
			description: 'Path of a source file this tool saved earlier; re-runs it without generating.'
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

type Prepared = { mode: 'generate' | 'recheck'; paths: HtmlKindPaths } | string;

/** The call's mode and paths, or why it can't run. */
function prepare(run: SpecialistRun, spec: HtmlKindSpec): Prepared {
	const { args, request, images, ctx } = run;
	const recheck = typeof args.recheck === 'string';
	if (recheck) {
		if (request !== undefined || args.path !== undefined) {
			return 'recheck takes no request or path: it re-runs the saved source.';
		}
		if (images.length)
			return 'recheck re-runs the saved source; images only go with a new request.';
	} else if (request === undefined || typeof args.path !== 'string') {
		return 'Pass request and path, or recheck.';
	}
	const shape = spec.sourcePath(args);
	if (typeof shape === 'string') return shape;
	const cwd = ctxCwd(ctx);
	return {
		mode: recheck ? 'recheck' : 'generate',
		paths: {
			...shape,
			sourceAbs: resolveShellPath(shape.source, cwd),
			targetAbs: resolveShellPath(shape.target, cwd)
		}
	};
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
		const max = effectiveSampling(entry).max_tokens;
		return {
			error: `The specialist ran out of tokens (max ${max}). Raise Max tokens in Settings → Code → Specialists, or ask for something simpler.`
		};
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
		return toolResult(failureReport(result.errors, [], paths.source, run.entry.name));
	}
	const outcome = await spec.finish(result, paths, run);
	if (!outcome.ok) {
		return toolResult(failureReport([], outcome.problems, paths.source, run.entry.name));
	}
	return outcome.output;
}
