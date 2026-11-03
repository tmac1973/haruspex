/**
 * Whether one model in a models.json run is done, decided in code: build it
 * as `check_3d` would (same loader, same check), then hold it against its
 * spec entry: its height, its named parts and, once animated, its clips. The
 * job gates on `done`; the agent gets `text` and the sheets, which are what
 * `check_3d` would have shown it. Writes nothing; the pipeline writes.
 */
import { checkGlb } from '#lib/glb/check.ts';
import { disposeTree, loadGlb } from '#lib/glb/load.ts';
import { inspectMotion, type ClipMotion } from '#lib/glb/motion.ts';
import { clipProblems } from '#lib/glb/motionFormat.ts';
import {
	errorLines,
	failed,
	loadModuleRun,
	missingLine,
	runFailure,
	SHEET_NOTE,
	type LoadIo,
	type ModulePaths
} from '#lib/helpers/three/load.ts';
import type { ModelFiles } from '#lib/models3d/spec/paths.ts';
import type { ModelEntry } from '#lib/models3d/spec/types.ts';

/** How far the measured height may stray from the spec's, as a fraction. */
export const HEIGHT_TOLERANCE = 0.1;

/** The most a looping clip's last pose may sit from its first: this share of the height, or 1 cm. */
export const LOOP_SEAM = 0.02;

export type ModelStage = 'create' | 'animate';

export interface ModelVerdict {
	done: boolean;
	/** What keeps it from done, one sentence each. */
	problems: string[];
	/** What the check reported that doesn't block. */
	warnings: string[];
	/** What `check_3d` would say for the same files. */
	text: string;
	/** The still render sheet, or null when it couldn't be drawn or nothing built. */
	sheetPng: string | null;
	/** A motion sheet per spec clip the GLB has, keyed by clip name (animate stage only). */
	clipSheets: Record<string, string>;
	/** The GLB to write, or null when nothing passed the check. */
	glb: Uint8Array | null;
}

export interface JudgeInput {
	entry: ModelEntry;
	files: ModelFiles;
	stage: ModelStage;
	io: LoadIo;
	signal?: AbortSignal;
}

const metres = (m: number) => `${Number(m.toFixed(2))} m`;

function notDone(problems: string[], text: string): ModelVerdict {
	return { done: false, problems, warnings: [], text, sheetPng: null, clipSheets: {}, glb: null };
}

/** Build, check and compare one model with its spec entry. */
export async function judgeModel(input: JudgeInput): Promise<ModelVerdict> {
	const { entry, files, stage, io, signal } = input;
	const paths: ModulePaths = {
		build: files.build,
		anim: stage === 'animate' ? files.anim : undefined
	};
	const run = await loadModuleRun(paths, io, signal);
	if ('refused' in run) return notDone([run.refused], run.refused);
	if (run.errors.length || !run.glb) {
		const lines = errorLines(run.errors, paths.anim).map((l) => l.replace(/^- /, ''));
		return notDone(
			lines.length ? lines : ['build() exported nothing.'],
			runFailure(run.errors, paths)
		);
	}

	const checked = await checkGlb(run.glb, {});
	if ('problems' in checked) {
		return notDone(
			checked.problems,
			failed(
				checked.problems.map((p) => `- ${p}`),
				files.build
			)
		);
	}
	const problems = [...checked.report.problems];
	const h = checked.report.height;
	if (Math.abs(h - entry.height_m) > HEIGHT_TOLERANCE * entry.height_m) {
		problems.push(
			`Height is ${metres(h)}; the spec says ${metres(entry.height_m)} (±${HEIGHT_TOLERANCE * 100}%).`
		);
	}

	const seen = await inspectNodes(checked.bytes, entry.parts);
	problems.push(...seen.problems);
	const clipSheets: Record<string, string> = {};
	if (stage === 'animate') {
		problems.push(...clipVerdict(entry, seen.clips, run.missing));
		for (const c of entry.clips) {
			if (!seen.clips.some((m) => m.name === c.name)) continue;
			const shown = await checkGlb(checked.bytes, { clip: c.name });
			if (!('problems' in shown) && shown.png !== null) clipSheets[c.name] = shown.png;
		}
	}

	const text = [
		`Wrote ${files.glb}.`,
		...missingLine(run.missing),
		checked.text,
		// check_3d adds the note when it attaches the sheet for a model that can see.
		...(checked.png !== null ? [SHEET_NOTE] : [])
	].join('\n');
	return {
		done: problems.length === 0,
		problems,
		warnings: [...checked.report.warnings],
		text,
		sheetPng: checked.png,
		clipSheets,
		glb: checked.bytes
	};
}

/**
 * The spec's parts the GLB has no node for, and its clips' motion. Pivots are
 * groups, not meshes, so the report's part list can't answer this: look in
 * the scene. The loader writes a name with spaces or dots in a binding-safe
 * form, so that spelling counts too.
 */
async function inspectNodes(
	glb: Uint8Array,
	parts: string[]
): Promise<{ problems: string[]; clips: ClipMotion[] }> {
	const loaded = await loadGlb(glb);
	if ('error' in loaded) return { problems: [loaded.error], clips: [] };
	const { THREE, gltf } = loaded;
	const has = (name: string) =>
		gltf.scene.getObjectByName(name) !== undefined ||
		gltf.scene.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name)) !== undefined;
	const problems = parts
		.filter((p) => !has(p))
		.map((p) => `Missing part "${p}": name the pivot exactly so.`);
	const clips = inspectMotion(THREE, gltf);
	disposeTree(gltf.scene);
	return { problems, clips };
}

/** What keeps the clips from done: missing ones, dropped tracks, motion faults, open loops. */
function clipVerdict(entry: ModelEntry, clips: ClipMotion[], missing: string[]): string[] {
	const out: string[] = [];
	for (const c of entry.clips) {
		if (!clips.some((m) => m.name === c.name)) out.push(`Missing clip "${c.name}".`);
	}
	if (missing.length) {
		out.push(`Tracks name nodes the model doesn't have: ${missing.slice(0, 12).join(', ')}.`);
	}
	for (const m of clips) {
		for (const p of clipProblems(m)) out.push(`Clip "${m.name}": ${p}.`);
		const spec = entry.clips.find((c) => c.name === m.name);
		const limit = Math.max(0.01, LOOP_SEAM * m.height);
		if (spec?.loop && m.seam > limit) {
			out.push(
				`Clip "${m.name}" loops but ends ${Math.round(m.seam * 100)} cm from where it starts: make its last pose its first.`
			);
		}
	}
	return out;
}
