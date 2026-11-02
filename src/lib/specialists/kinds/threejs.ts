/**
 * `threejs`: a model that writes a self-contained Three.js scene (such as
 * ccore/Qwen3.5-4B-3D-Coder) makes one for a project that is a Three.js app
 * itself. The page is the output: it is run headless with no export, has to
 * run cleanly and draw something, and the main model gets a screenshot and
 * ports the scene into the project's own code.
 */
import { MAX_PENDING_IMAGES } from '#lib/agent/tools/fs-read.ts';
import { toolResult } from '#lib/agent/tools/types.ts';
import { registerSpecialistKind } from '#lib/specialists/kinds.ts';
import {
	HTML_KIND_PARAMS,
	htmlCallLabel,
	runHtmlKind,
	type HtmlKindSpec
} from '#lib/specialists/three/htmlKind.ts';
import { snapshotProblems } from '#lib/specialists/three/snapshot.ts';

/** The model card's system prompt (2026-11-02). */
export const THREEJS_SYSTEM_PROMPT = [
	'Use only the Three.js core ES module from',
	'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js.',
	'Do not import addons or legacy examples/js paths;',
	'implement any camera controls directly inside the HTML.'
].join('\n');

/** What the main model is told to do with a scene that passed. */
export const PORTING_NOTE =
	"It loads three 0.160.0 core from cdnjs and has its own camera controls. Port the scene code into the project: match the project's three import and version, and drop the page's renderer, camera and controls setup if the project has its own.";

const spec: HtmlKindSpec = {
	sourcePath(args) {
		// The page is the output: source and target are one file.
		const path = String(typeof args.recheck === 'string' ? args.recheck : args.path);
		if (!path.endsWith('.html')) return 'path must end in .html.';
		return { source: path, target: path };
	},
	requestSuffix: '',
	runOptions: { export: false },
	async finish(result, paths, { ctx }) {
		if (!result.png) return { ok: false, problems: ['The page drew no canvas.'] };
		const problems = await snapshotProblems(result.png);
		if (problems.length) return { ok: false, problems };
		const sees = ctx.visionSupported !== false && ctx.pendingImages.length < MAX_PENDING_IMAGES;
		if (sees) ctx.pendingImages.push({ path: paths.source, dataUrl: result.png });
		const lines = [
			`Saved ${paths.source}; it runs cleanly.`,
			PORTING_NOTE,
			...(sees
				? [
						"Check the screenshot: if it doesn't look like the request, call again with a clearer request."
					]
				: [])
		];
		return { ok: true, output: toolResult(lines.join('\n'), result.png) };
	}
};

registerSpecialistKind({
	id: 'threejs',
	label: 'Three.js scene',
	summary: 'Writes a self-contained Three.js scene as an HTML file.',
	defaultDescription:
		"Writes a self-contained Three.js scene (one HTML file) for a web project: objects, environments, animated scenes. Port the result into the project's code. Send a short English request.",
	defaultSystemPrompt: THREEJS_SYSTEM_PROMPT,
	// Thinking off: with it on, the 2026-11-02 spike spent 24k and then 48k
	// tokens reasoning and never wrote a page.
	defaultSampling: { temperature: 0.7, top_p: 0.95, top_k: 20, max_tokens: 24000, thinking: false },
	writes: true,
	params: HTML_KIND_PARAMS,
	requestRequired: false,
	callLabel: htmlCallLabel,
	run: (run) => runHtmlKind(run, spec)
});
