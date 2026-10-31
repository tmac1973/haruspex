/**
 * What Haruspex can do with the configured image model, in words, for
 * Settings → Image: drawing, editing, upscaling, extending, transparency, tiling and
 * LoRAs, with what it can't do and how to get it in a tooltip.
 *
 * Read from `capabilities()`, the same answer the tools act on, so the line
 * and what `edit_image` or `upscale_image` will do can't disagree.
 */

import type { ImageBackendCapabilities, ImageBackendKind } from '#lib/image/types.ts';

export interface CapabilityLine {
	/** What it can do, joined: "draw pictures, edit pictures (up to 4 together)". */
	can: string;
	/** What it can't, joined; empty when there is nothing. */
	cannot: string;
	/** How to get each thing it can't do, one sentence each, for a tooltip. */
	howTo: string;
	/** The line itself: "Can: …. Can't: …." */
	text: string;
}

/** How to get editing, by backend. */
const EDIT_HOW: Record<ImageBackendKind, string> = {
	none: '',
	local:
		'Editing needs Qwen-Image 2.1 with its editing weights (Add editing, under Bundled engine).',
	comfyui:
		'Editing needs FLUX.2 klein 4B, Qwen-Image-Edit-2511, or Qwen-Image 2.1 or its Turbo on ComfyUI 0.39 or later.',
	'llama-toolchest':
		'Editing needs an instance whose model edits, such as FLUX.2 klein or Qwen-Image-Edit 2511.',
	lemonade:
		'Editing needs Qwen-Image 2.1 with its editing weights (Add editing, under Models on the server).'
};

const UPSCALE_HOW: Record<ImageBackendKind, string> = {
	none: '',
	local: 'Upscaling needs the upscaler, under Bundled engine.',
	comfyui: 'Upscaling needs the upscaler, under Models on the server.',
	'llama-toolchest': 'Upscaling needs an upscaler instance (Real-ESRGAN) in llama-toolchest.',
	lemonade: 'Upscaling needs the upscaler, under Models on the server.'
};

const EXTEND_HOW = 'Only the bundled engine and ComfyUI extend pictures past their edges.';
const TRANSPARENT_HOW = 'Transparent backgrounds need Ming-Image or Qwen-Image 2.1.';
const TILING_HOW =
	'Tiling textures need the bundled engine, or ComfyUI with Ming-Image or an SD checkpoint.';

export function capabilityLine(
	caps: ImageBackendCapabilities,
	kind: ImageBackendKind
): CapabilityLine {
	const can = ['draw pictures'];
	const cannot: string[] = [];
	const howTo: string[] = [];
	const most = caps.maxEditImages ?? 1;
	const items: Array<[boolean, string, string, string]> = [
		[
			!!caps.edit,
			most > 1 ? `edit pictures (up to ${most} together)` : 'edit pictures',
			'edit pictures',
			EDIT_HOW[kind]
		],
		[!!caps.upscale, 'upscale pictures', 'upscale pictures', UPSCALE_HOW[kind]],
		[!!caps.inpaint, 'extend pictures', 'extend pictures', EXTEND_HOW],
		[caps.transparency, 'transparent backgrounds', 'transparent backgrounds', TRANSPARENT_HOW],
		[caps.seamlessTiling, 'tiling textures', 'tiling textures', TILING_HOW]
	];
	for (const [yes, said, missing, how] of items) {
		if (yes) can.push(said);
		else {
			cannot.push(missing);
			if (how) howTo.push(how);
		}
	}
	// Only the asset job uses LoRAs, so they are said only when there are some.
	if (caps.loras && caps.maxLoras > 0) can.push(`LoRAs (up to ${caps.maxLoras})`);
	const line = { can: can.join(', '), cannot: cannot.join(', '), howTo: howTo.join(' ') };
	const text = `Can: ${line.can}.` + (line.cannot ? ` Can't: ${line.cannot}.` : '');
	return { ...line, text };
}
