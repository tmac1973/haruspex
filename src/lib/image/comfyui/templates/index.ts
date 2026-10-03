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
import mingSeamlessGraph from './ming_t2i_seamless.json';
import qwen21Graph from './qwen21_t2i.json';
import type { ComfyGraph, FieldMap, ScalarBinding } from '../fieldMap';
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

/** A slot that takes the request's width or height times `scale`. */
function at(node: string, input: string, scale?: number): ScalarBinding {
	return scale === undefined
		? { kind: 'scalar', node, input }
		: { kind: 'scalar', node, input, scale };
}

/**
 * Where `ming_t2i_seamless.json` needs the size, axis by axis.
 *
 * Pass one rolls the image by half (crops and pastes 20-27) and repaints a
 * cross over the seams, through a mask built at an eighth of the size and
 * scaled up so its blur is wide (30-37). Pass two rolls the result by a
 * quarter (60-67) and repaints two patches (70-76): where the cross's arms
 * met the image edges, each end was painted without its wrap partner.
 */
function seamlessSize(axis: 'width' | 'height'): ScalarBinding[] {
	const w = axis === 'width';
	const pos = w ? 'x' : 'y';
	const [across, along] = w ? ['31', '32'] : ['32', '31'];
	// Pass two's crops: [node, size along this axis, offset along this axis].
	const quarter: Array<[string, number, number]> = w
		? [
				['60', 3 / 4, 0],
				['61', 1 / 4, 3 / 4],
				['62', 3 / 4, 0],
				['63', 1 / 4, 3 / 4]
			]
		: [
				['60', 3 / 4, 0],
				['61', 3 / 4, 0],
				['62', 1 / 4, 3 / 4],
				['63', 1 / 4, 3 / 4]
			];
	return [
		at('6', axis),
		// Pass one.
		...['20', '21', '22', '23'].map((n) => at(n, axis, 1 / 2)),
		...(w ? ['21', '23', '25', '27'] : ['22', '23', '26', '27']).map((n) => at(n, pos, 1 / 2)),
		at('30', axis, 1 / 8),
		at(across, axis, 1 / 32),
		at(along, axis, 1 / 8),
		at(w ? '33' : '34', pos, 3 / 64),
		at('37', axis),
		// Pass two.
		...quarter.map(([n, size]) => at(n, axis, size)),
		...quarter.filter(([, , off]) => off > 0).map(([n, , off]) => at(n, pos, off)),
		...(w ? ['64', '66'] : ['64', '65']).map((n) => at(n, pos, 1 / 4)),
		at('70', axis, 1 / 8),
		at('71', axis, 3 / 64),
		at('72', pos, w ? 9 / 128 : 1 / 128),
		at('73', pos, w ? 1 / 128 : 9 / 128),
		at('76', axis)
	];
}

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
		 * Offset and inpaint, in one graph. Generate; roll the image by half
		 * so the wrap seams cross in the middle; repaint a soft-edged cross a
		 * quarter of the size wide over them, with DifferentialDiffusion so
		 * the repaint fades into what is kept. The cross's arms run to the
		 * image edges, where each end is painted without its wrap partner, so
		 * a second pass rolls by a quarter and repaints those two spots. The
		 * output's edges were the generation's middle, so they wrap. A frame
		 * Ming drew round the texture is in the cross, and goes.
		 * Measured against a hard-edged band, a narrower one and a lower
		 * denoise in phase 23 (`measurements-phase-23.md`).
		 */
		id: 'ming_t2i_seamless',
		family: 'ming',
		graph: mingSeamlessGraph as ComfyGraph,
		map: {
			outputNode: '9',
			...MING_BINDINGS,
			width: seamlessSize('width'),
			height: seamlessSize('height')
		},
		license: LICENSE,
		source: SOURCE,
		supports: { transparent: false, seamless: true },
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
 * Exact first. Failing that, keep transparency and drop seamless — no graph
 * does both, and the caller already knows that from `capabilities()` and
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
