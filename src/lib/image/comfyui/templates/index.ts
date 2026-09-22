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
 * Four templates, not three. A terrain texture is both seamless AND
 * conditioned on the style anchor, so a set without `seamless_reference` makes
 * template selection choose one and silently drop the other — with
 * `capabilities()` still reporting reference conditioning, so nothing records
 * a degradation and the whole texture half of a set quietly loses its style.
 */

import txt2imgGraph from './txt2img.json';
import referenceGraph from './reference.json';
import seamlessGraph from './seamless.json';
import seamlessReferenceGraph from './seamless_reference.json';
import type { ComfyGraph, FieldMap } from '../fieldMap';

export interface WorkflowTemplate {
	id: string;
	graph: ComfyGraph;
	map: FieldMap;
	/** Licence of the graph itself. */
	license: string;
	/** Who authored it. */
	source: string;
	supports: { reference: boolean; seamless: boolean };
}

const LICENSE = 'Same licence as Haruspex itself.';
const SOURCE = 'Authored for Haruspex.';

/** The bindings every bundled graph shares; they all descend from txt2img. */
const COMMON: Omit<FieldMap, 'outputNode'> = {
	prompt: { kind: 'scalar', node: '4', input: 'text' },
	negativePrompt: { kind: 'scalar', node: '5', input: 'text' },
	seed: { kind: 'scalar', node: '7', input: 'seed' },
	model: { kind: 'scalar', node: '1', input: 'ckpt_name' },
	samplerName: { kind: 'scalar', node: '7', input: 'sampler_name' },
	samplerSteps: { kind: 'scalar', node: '7', input: 'steps' },
	samplerCfg: { kind: 'scalar', node: '7', input: 'cfg' },
	loras: { kind: 'loraSlots', nodes: ['2', '3'], source: '1' }
};

/** Text-to-image graphs size their own empty latent, node 6. */
const SIZE_PLAIN: Pick<FieldMap, 'width' | 'height'> = {
	width: { kind: 'scalar', node: '6', input: 'width' },
	height: { kind: 'scalar', node: '6', input: 'height' }
};

/**
 * Reference graphs also sample a fresh latent — node 10, because node 6 is the
 * LoadImage carrying the reference.
 *
 * That they sample a fresh latent at all is the whole design. The obvious
 * implementation is img2img: feed the reference in as the latent and denoise
 * partway. Tried against a real server, it does exactly what it says — it
 * returns the REFERENCE, restyled. Asked for "a green pear" conditioned on a
 * picture of an apple, img2img at denoise 0.6 produced the apple again. There
 * is no denoise value that gives a different subject in the same style:
 * turn it up and the style goes, turn it down and the subject comes back.
 *
 * IP-Adapter is the mechanism that actually separates them. It injects the
 * reference into the model's attention (`weight_type: "style transfer"`) and
 * leaves composition entirely to the prompt, so the subject is the prompt's
 * and the palette and feel are the reference's.
 */
const SIZE_REFERENCE: Pick<FieldMap, 'width' | 'height'> = {
	width: { kind: 'scalar', node: '10', input: 'width' },
	height: { kind: 'scalar', node: '10', input: 'height' }
};

const REFERENCE_BINDINGS: Pick<FieldMap, 'referenceImage' | 'referenceStrength'> = {
	referenceImage: { kind: 'uploaded', node: '6', input: 'image' },
	// The IP-Adapter weight, not a denoise. Measured against SD1.5: 0.6 shifts
	// the palette clearly while leaving the subject alone, 0.9 is strong, and
	// above that the reference's own forms start bleeding into the output.
	referenceStrength: { kind: 'scalar', node: '13', input: 'weight' }
};

export const TEMPLATES: WorkflowTemplate[] = [
	{
		id: 'txt2img',
		graph: txt2imgGraph as ComfyGraph,
		map: { outputNode: '9', ...COMMON, ...SIZE_PLAIN },
		license: LICENSE,
		source: SOURCE,
		supports: { reference: false, seamless: false }
	},
	{
		id: 'reference',
		graph: referenceGraph as ComfyGraph,
		map: { outputNode: '9', ...COMMON, ...SIZE_REFERENCE, ...REFERENCE_BINDINGS },
		license: LICENSE,
		source: SOURCE,
		supports: { reference: true, seamless: false }
	},
	{
		id: 'seamless',
		graph: seamlessGraph as ComfyGraph,
		map: { outputNode: '9', ...COMMON, ...SIZE_PLAIN },
		license: LICENSE,
		source: SOURCE,
		supports: { reference: false, seamless: true }
	},
	{
		id: 'seamless_reference',
		graph: seamlessReferenceGraph as ComfyGraph,
		map: { outputNode: '9', ...COMMON, ...SIZE_REFERENCE, ...REFERENCE_BINDINGS },
		license: LICENSE,
		source: SOURCE,
		supports: { reference: true, seamless: true }
	}
];

/**
 * The template for a request, by what it asks for. All four combinations are
 * covered; see the note at the top for why the fourth exists.
 */
export function selectTemplate(
	want: { reference: boolean; seamless: boolean },
	from: WorkflowTemplate[] = TEMPLATES
): WorkflowTemplate | undefined {
	return from.find(
		(t) => t.supports.reference === want.reference && t.supports.seamless === want.seamless
	);
}
