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

/** Sizes come from the latent in a text-to-image graph. */
const SIZE_FROM_LATENT: Pick<FieldMap, 'width' | 'height'> = {
	width: { kind: 'scalar', node: '6', input: 'width' },
	height: { kind: 'scalar', node: '6', input: 'height' }
};

/**
 * A reference graph takes its size from the uploaded image, so there is no
 * width/height binding — and there must not be one, since binding a node input
 * that does not exist is an error rather than a no-op.
 */
const REFERENCE_BINDINGS: Pick<FieldMap, 'referenceImage' | 'referenceStrength'> = {
	referenceImage: { kind: 'uploaded', node: '6', input: 'image' },
	referenceStrength: { kind: 'scalar', node: '7', input: 'denoise' }
};

export const TEMPLATES: WorkflowTemplate[] = [
	{
		id: 'txt2img',
		graph: txt2imgGraph as ComfyGraph,
		map: { outputNode: '9', ...COMMON, ...SIZE_FROM_LATENT },
		license: LICENSE,
		source: SOURCE,
		supports: { reference: false, seamless: false }
	},
	{
		id: 'reference',
		graph: referenceGraph as ComfyGraph,
		map: { outputNode: '9', ...COMMON, ...REFERENCE_BINDINGS },
		license: LICENSE,
		source: SOURCE,
		supports: { reference: true, seamless: false }
	},
	{
		id: 'seamless',
		graph: seamlessGraph as ComfyGraph,
		map: { outputNode: '9', ...COMMON, ...SIZE_FROM_LATENT },
		license: LICENSE,
		source: SOURCE,
		supports: { reference: false, seamless: true }
	},
	{
		id: 'seamless_reference',
		graph: seamlessReferenceGraph as ComfyGraph,
		map: { outputNode: '9', ...COMMON, ...REFERENCE_BINDINGS },
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
