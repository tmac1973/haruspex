/**
 * What the 3D delegate is told: its system prompt, its first message, and the
 * message that asks for its report when a cap stops it. The build-module and
 * animation rules are shared with the 3D models job (`moduleRules.ts`), so the
 * job and the delegate say the same thing. Part of the 3D core: it imports
 * nothing from the app (`call.imports.test.ts`).
 */
import {
	ANIM_MODULE_RULES,
	buildModuleRules,
	CLIP_MOTION_RULES,
	RIG_RULE
} from '#lib/helpers/three/moduleRules.ts';

/** The report's length limit, `SUBTASK_REPORT_CHARS` (`#lib/code/systemPrompt.ts`); a test holds them together. */
export const DELEGATE_3D_REPORT_CHARS = 4000;

/** The three files one call may write. */
export interface Delegate3dFiles {
	/** The build module, `<stem>.js`. */
	module: string;
	/** The animation module, `<stem>.anim.js`. */
	anim: string;
	/** The GLB, the path the call was given. */
	glb: string;
}

/** The files for a `.glb` path; null when `path` doesn't end in `.glb`. */
export function delegate3dFiles(path: string): Delegate3dFiles | null {
	const glb = path.trim();
	if (!/^.+\.glb$/i.test(glb) || /[/\\]\.glb$/i.test(glb)) return null;
	const stem = glb.replace(/\.glb$/i, '');
	return { module: `${stem}.js`, anim: `${stem}.anim.js`, glb };
}

/** The delegate's whole system prompt. */
export function delegate3dSystemPrompt(): string {
	const chars = DELEGATE_3D_REPORT_CHARS.toLocaleString('en-US');
	return [
		'You make one 3D asset, the one the task describes: a Three.js build module, checked with `check_3d`, which also writes the .glb. Another agent handed you the task; it sees only your report.',
		'',
		'Tools:',
		'- fs_list_dir, fs_read_text, fs_read_image, code_grep, code_glob — look at the project: how the asset will be used, its scale, other models and textures. Paths are relative to the project folder.',
		'- fs_write_text, fs_edit_text — write your modules.',
		'- check_3d — build the module (and anim module), check it, write the .glb and show you the render sheet.',
		'',
		'You may write only three files: your build module, your animation module and the .glb, named in the first message. Any other write is refused.',
		'',
		'The build module:',
		...buildModuleRules(true),
		'- kit.texture takes a PNG already in the project; you write no textures.',
		'',
		`Rig, for an asset that moves: ${RIG_RULE}`,
		'',
		'The animation module:',
		...ANIM_MODULE_RULES,
		...CLIP_MOTION_RULES,
		'- Keep clips in the animation module, not in the build module, and pass it to check_3d as anim.',
		'',
		'How to work:',
		'- Run `check_3d` after every change, and look at the sheet: the shape, proportions and colours must match the task. Check each clip with clip: <name>.',
		'- You are done when `check_3d` reports no errors and the asset looks right.',
		'- Nobody will answer questions: decide, and say what you assumed.',
		'',
		'Report:',
		`Your final answer is the report. At most ${chars} characters: the files written, the size, the named parts, the clips, any problems left, and what you assumed.`
	].join('\n');
}

export interface Delegate3dFirstMessageOpts {
	/** The build module. */
	path: string;
	anim: string;
	glb: string;
	task: string;
	/** Which of the modules already exist. */
	existing: { module: boolean; anim: boolean };
	/** Reference pictures sent with the message. */
	imagePaths: string[];
}

/** The delegate's one opening message: the task, its files, and what exists already. */
export function delegate3dFirstMessage(o: Delegate3dFirstMessageOpts): string {
	const exists = (file: string) =>
		`${file} exists: read it and change it rather than starting again.`;
	return [
		o.task.trim(),
		'',
		'Files:',
		`- Build module: ${o.path}`,
		`- Animation module: ${o.anim}`,
		`- GLB: ${o.glb}`,
		...(o.existing.module ? ['', exists(o.path)] : []),
		...(o.existing.anim ? ['', exists(o.anim)] : []),
		...(o.imagePaths.length
			? ['', 'Reference images (attached):', ...o.imagePaths.map((p) => `- ${p}`)]
			: [])
	].join('\n');
}

/** The message for the last call, with no tools, once a cap has stopped the delegate. */
export function delegate3dFinalReport(why: 'rounds' | 'cost'): string {
	return `You've reached this call's ${why === 'rounds' ? 'round' : 'cost'} limit. Stop working and give your report now: what is built, what the last check said, and what is left.`;
}
