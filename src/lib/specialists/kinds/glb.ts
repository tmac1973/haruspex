/**
 * `glb`: a model that writes a Three.js page with an Export GLB button (such
 * as ccore/Qwen3.5-4B-GLB-3D-Coder) makes a 3D asset for a game engine. The
 * page is run headless, its export clicked, and the GLB checked and drawn as a
 * render sheet (`#lib/glb/`) before it is written; the page stays beside it as `<name>.glb.html`.
 */
import { assetIo, writeAsset } from '#lib/agent/tools/_assetIo.ts';
import { checkGlb } from '#lib/glb/check.ts';
import { MAX_PENDING_IMAGES } from '#lib/agent/tools/fs-read.ts';
import { toolResult } from '#lib/agent/tools/types.ts';
import { registerSpecialistKind } from '#lib/specialists/kinds.ts';
import {
	HTML_KIND_PARAMS,
	htmlCallLabel,
	runHtmlKind,
	type HtmlKindSpec
} from '#lib/specialists/three/htmlKind.ts';

/** The model card's system prompt (2026-11-01). */
export const GLB_SYSTEM_PROMPT =
	'Create game assets for the Godot editor, which uses GLB files. Create whatever the user requests as a good-quality low-poly asset using only Three.js in one complete standalone HTML file. The HTML must show the asset and include an Export GLB button that downloads a working GLB. If the requested asset needs animation, add it and include the animation in the exported GLB; otherwise make it static.';

/** In the spike, scenery (a bench's ground disc, a torch's wall) came out with the asset. */
export const GLB_REQUEST_SUFFIX =
	' Export only the asset itself, with no ground, floor, backdrop or wall unless the request asks for one.';

/** What the model is told when the render sheet came with the result. */
export const SHEET_NOTE =
	"The render sheet is attached (front, right, back, left, top, three-quarter, over a floor grid): if it doesn't look like the request, fix the page or call again with a clearer request.";

const spec: HtmlKindSpec = {
	sourcePath(args) {
		if (typeof args.recheck === 'string') {
			const source = args.recheck;
			if (!source.endsWith('.glb.html')) return 'recheck needs the .glb.html this tool saved.';
			return { source, target: source.slice(0, -'.html'.length) };
		}
		const target = String(args.path);
		if (!target.endsWith('.glb')) return 'path must end in .glb.';
		return { source: `${target}.html`, target };
	},
	requestSuffix: GLB_REQUEST_SUFFIX,
	runOptions: { export: true },
	async finish(result, paths, { ctx }) {
		// No GLB: the runner's errors (no button, a timeout) already say why.
		if (!result.glb) return { ok: false, problems: [] };
		ctx.onProgress?.('Checking');
		const checked = await checkGlb(result.glb);
		if ('problems' in checked) return { ok: false, problems: checked.problems };
		// A recheck replaces the GLB this source made; a new one was checked before generating.
		const refused = await writeAsset(paths.targetAbs, result.glb, true, false, assetIo(ctx));
		if (refused) return { ok: false, problems: [refused] };
		const sees =
			checked.png !== null &&
			ctx.visionSupported !== false &&
			ctx.pendingImages.length < MAX_PENDING_IMAGES;
		if (sees) ctx.pendingImages.push({ path: paths.target, dataUrl: checked.png! });
		const lines = [
			`Saved ${paths.target} (source: ${paths.source}).`,
			checked.text,
			...(sees ? [SHEET_NOTE] : [])
		];
		return { ok: true, output: toolResult(lines.join('\n'), checked.png ?? undefined) };
	}
};

registerSpecialistKind({
	id: 'glb',
	label: '3D asset (GLB)',
	summary: 'Writes a Three.js scene and exports it as a GLB file.',
	defaultDescription:
		'Makes a low-poly 3D asset (props, characters, buildings) as a GLB file for a game engine. Send a short English request.',
	defaultSystemPrompt: GLB_SYSTEM_PROMPT,
	// 48k, not 24k: the 2026-11-02 checkpoint writes long pages. In the 2026-11-04
	// tests half its drafts were cut off at 24k mid-page (a well ran to 80,000
	// characters), with thinking on or off.
	defaultSampling: { temperature: 0.8, top_p: 0.95, top_k: 40, min_p: 0, max_tokens: 48000 },
	writes: true,
	params: HTML_KIND_PARAMS,
	requestRequired: false,
	callLabel: htmlCallLabel,
	run: (run) => runHtmlKind(run, spec)
});
