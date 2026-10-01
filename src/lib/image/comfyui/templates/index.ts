/**
 * The bundled workflows, each paired with the field map that says where its
 * parameters go.
 *
 * Licensing lives here rather than in the JSON: a ComfyUI API-format graph
 * must parse as strict JSON, and JSON has no comments. `templates/README.md`
 * says the same in prose, and a test asserts every row below carries both
 * fields — the overview's constraint is that the bundled workflows are ours
 * and carry this repository's licence, so it needs somewhere checkable to live.
 *
 * Templates are grouped by model family (`families.ts`), because a graph that
 * loads an SD checkpoint cannot load a DiT that ships its text encoder and VAE
 * as separate files, and the two DiT families do not share a sampler.
 */

import txt2imgGraph from './txt2img.json';
import seamlessGraph from './seamless.json';
import mingGraph from './ming_t2i.json';
import mingRgbaGraph from './ming_t2i_rgba.json';
import qwen21Graph from './qwen21_t2i.json';
import type { ComfyGraph, FieldMap } from '../fieldMap';
import type { ModelFamily } from '../families';
import type { SamplerSettings } from '../../types';

export interface WorkflowTemplate {
	id: string;
	family: ModelFamily;
	graph: ComfyGraph;
	map: FieldMap;
	/** Licence of the graph itself. */
	license: string;
	/** Who authored it. */
	source: string;
	supports: { transparent: boolean; seamless: boolean };
	/** What the graph samples with when the request names nothing. */
	defaultSampler: SamplerSettings;
	/**
	 * Applied to the prompt when this template serves a transparent request.
	 * For a model that turns alpha on with words rather than with the graph.
	 */
	wrapPrompt?: (prompt: string) => string;
}

const LICENSE = 'Same licence as Haruspex itself.';
const SOURCE = 'Authored for Haruspex.';

// ---- SD-family checkpoints ---------------------------------------------------

/** The bindings both SD graphs share; seamless descends from txt2img. */
const SD_BINDINGS: Omit<FieldMap, 'outputNode'> = {
	prompt: { kind: 'scalar', node: '4', input: 'text' },
	negativePrompt: { kind: 'scalar', node: '5', input: 'text' },
	seed: { kind: 'scalar', node: '7', input: 'seed' },
	model: { kind: 'scalar', node: '1', input: 'ckpt_name' },
	samplerName: { kind: 'scalar', node: '7', input: 'sampler_name' },
	samplerSteps: { kind: 'scalar', node: '7', input: 'steps' },
	samplerCfg: { kind: 'scalar', node: '7', input: 'cfg' },
	loras: { kind: 'loraSlots', nodes: ['2', '3'], source: '1' },
	width: { kind: 'scalar', node: '6', input: 'width' },
	height: { kind: 'scalar', node: '6', input: 'height' }
};

const SD_SAMPLER: SamplerSettings = { name: 'euler_ancestral', steps: 28, cfg: 7 };

// ---- Ming-Image ----------------------------------------------------------------

/**
 * Ming's text encoder runs on the CPU in both graphs. On a 16 GB card the
 * encoder and the DiT cannot both stay resident, and measured on a 9070 XT the
 * CPU costs ~65 s once per distinct prompt while sampling stays at ~19 s.
 *
 * `ModelSamplingFlux` is pinned at `max_shift` 1.35 against a 1024 reference
 * size, which is the vendor's own shift at every size from 1024 up. At 1024
 * the stock template's 1.15 works as well; at 2048 only 1.35 gives alpha.
 */
const MING_BINDINGS: Omit<FieldMap, 'outputNode' | 'width' | 'height'> = {
	prompt: { kind: 'scalar', node: '4', input: 'text' },
	seed: { kind: 'scalar', node: '7', input: 'noise_seed' },
	model: { kind: 'scalar', node: '1', input: 'unet_name' },
	textEncoder: { kind: 'scalar', node: '2', input: 'clip_name' },
	vae: { kind: 'scalar', node: '3', input: 'vae_name' },
	samplerName: { kind: 'scalar', node: '8', input: 'sampler_name' },
	samplerSteps: { kind: 'scalar', node: '10', input: 'steps' }
	// No cfg: the vendor samples at CFG 1, which BasicGuider is.
};

const MING_SAMPLER: SamplerSettings = { name: 'euler', steps: 12, cfg: 1 };

/**
 * One of Ming's documented RGBA phrases, and it is NOT optional.
 *
 * Neither half works alone. The phrase without the transparent start gave
 * alpha 0 times in 20; the transparent start without the phrase gave alpha 0
 * times in 4 at seeds that gave it 4 times in 4 with the phrase (phase 21,
 * `p21_noprefix_*` in the spike folder). Together they are reliable.
 */
export function mingTransparent(prompt: string): string {
	return `RGBA, 4-channel, transparent background. ${prompt.trim()}`;
}

// ---- Qwen-Image-2.1 -------------------------------------------------------------

const QWEN21_BINDINGS: FieldMap = {
	outputNode: '9',
	prompt: { kind: 'scalar', node: '4', input: 'prompt' },
	negativePrompt: { kind: 'scalar', node: '4', input: 'negative_prompt' },
	seed: { kind: 'scalar', node: '7', input: 'seed' },
	model: { kind: 'scalar', node: '1', input: 'unet_name' },
	textEncoder: { kind: 'scalar', node: '2', input: 'clip_name' },
	vae: { kind: 'scalar', node: '3', input: 'vae_name' },
	samplerName: { kind: 'scalar', node: '7', input: 'sampler_name' },
	samplerSteps: { kind: 'scalar', node: '7', input: 'steps' },
	samplerCfg: { kind: 'scalar', node: '7', input: 'cfg' },
	width: { kind: 'scalar', node: '6', input: 'width' },
	height: { kind: 'scalar', node: '6', input: 'height' }
};

const QWEN21_SAMPLER: SamplerSettings = { name: 'euler', steps: 25, cfg: 1 };

/** The wrapper from the model's own template; its VAE always carries alpha. */
export function qwen21Transparent(prompt: string): string {
	return (
		`This is an RGBA format image with transparency. ${prompt.trim()} ` +
		'The image has an alpha channel and a transparent background.'
	);
}

export const TEMPLATES: WorkflowTemplate[] = [
	{
		id: 'txt2img',
		family: 'sd',
		graph: txt2imgGraph as ComfyGraph,
		map: { outputNode: '9', ...SD_BINDINGS },
		license: LICENSE,
		source: SOURCE,
		supports: { transparent: false, seamless: false },
		defaultSampler: SD_SAMPLER
	},
	{
		id: 'seamless',
		family: 'sd',
		graph: seamlessGraph as ComfyGraph,
		map: { outputNode: '9', ...SD_BINDINGS },
		license: LICENSE,
		source: SOURCE,
		supports: { transparent: false, seamless: true },
		defaultSampler: SD_SAMPLER
	},
	{
		id: 'ming_t2i',
		family: 'ming',
		graph: mingGraph as ComfyGraph,
		map: {
			outputNode: '9',
			...MING_BINDINGS,
			width: { kind: 'scalar', node: '6', input: 'width' },
			height: { kind: 'scalar', node: '6', input: 'height' }
		},
		license: LICENSE,
		source: SOURCE,
		supports: { transparent: false, seamless: false },
		defaultSampler: MING_SAMPLER
	},
	{
		/**
		 * Ming ignores its documented RGBA prompt prefixes — in ComfyUI, in the
		 * demo Space and in the vendor's own code. It does produce alpha when
		 * sampling starts from the latent of a transparent canvas at denoise
		 * 0.9, together with one of its RGBA phrases (`mingTransparent`): 10 of
		 * 10 sheets and 48 of 48 singles in the spike and phase 17.
		 * The canvas is built inside the graph (an image and a fully-set mask,
		 * joined), so there is nothing to upload; measured byte-identical to
		 * uploading a transparent PNG.
		 */
		id: 'ming_t2i_rgba',
		family: 'ming',
		graph: mingRgbaGraph as ComfyGraph,
		map: {
			outputNode: '9',
			...MING_BINDINGS,
			width: [
				{ kind: 'scalar', node: '14', input: 'width' },
				{ kind: 'scalar', node: '15', input: 'width' }
			],
			height: [
				{ kind: 'scalar', node: '14', input: 'height' },
				{ kind: 'scalar', node: '15', input: 'height' }
			]
		},
		license: LICENSE,
		source: SOURCE,
		supports: { transparent: true, seamless: false },
		defaultSampler: MING_SAMPLER,
		wrapPrompt: mingTransparent
	},
	{
		id: 'qwen21_t2i',
		family: 'qwen21',
		graph: qwen21Graph as ComfyGraph,
		map: QWEN21_BINDINGS,
		license: LICENSE,
		source: SOURCE,
		supports: { transparent: false, seamless: false },
		defaultSampler: QWEN21_SAMPLER
	},
	{
		// The same graph: Qwen turns alpha on with words, not with the graph.
		id: 'qwen21_t2i_rgba',
		family: 'qwen21',
		graph: qwen21Graph as ComfyGraph,
		map: QWEN21_BINDINGS,
		license: LICENSE,
		source: SOURCE,
		supports: { transparent: true, seamless: false },
		defaultSampler: QWEN21_SAMPLER,
		wrapPrompt: qwen21Transparent
	}
];

/**
 * The template for a request, from the templates one family offers.
 *
 * Exact first. Failing that, keep transparency and drop seamless — neither DiT
 * family tiles, and the caller already knows that from `capabilities()` and
 * records it. Failing that, an opaque one: a backend that cannot do alpha
 * still generates, and says so in `capabilities().transparency`.
 */
export function selectTemplate(
	want: { transparent: boolean; seamless: boolean },
	from: WorkflowTemplate[]
): WorkflowTemplate | undefined {
	const match = (transparent: boolean, seamless: boolean) =>
		from.find((t) => t.supports.transparent === transparent && t.supports.seamless === seamless);
	return (
		match(want.transparent, want.seamless) ??
		match(want.transparent, false) ??
		match(false, want.seamless) ??
		match(false, false)
	);
}

export function templatesFor(family: ModelFamily): WorkflowTemplate[] {
	return TEMPLATES.filter((t) => t.family === family);
}
