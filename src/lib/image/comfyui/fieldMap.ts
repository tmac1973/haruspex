/**
 * Binding a request's parameters into a ComfyUI API-format workflow graph.
 *
 * A graph is a flat map of node id → `{ class_type, inputs }`, so every
 * parameter has to be addressed as "this input of that node". One
 * `{node, input}` slot covers most of them, but not all: a reference image is
 * uploaded first and the graph receives the server-side FILENAME, and a
 * variable-length LoRA list has to land in a fixed set of loader nodes. Those
 * are the two reasons this has binding kinds rather than a flat record.
 *
 * A binding naming a node or input the graph does not contain is an error, not
 * a silent no-op. A typo would otherwise produce a perfectly good picture made
 * with default parameters, which is the worst failure available here: it looks
 * like success.
 */

import type { ImageRequest } from '../types';

/** One node in an API-format graph. */
export interface GraphNode {
	class_type: string;
	inputs: Record<string, unknown>;
	[k: string]: unknown;
}

export type ComfyGraph = Record<string, GraphNode>;

export interface ScalarBinding {
	kind: 'scalar';
	node: string;
	input: string;
}

/** The uploaded reference: the graph gets a filename, never the bytes. */
export interface UploadedBinding {
	kind: 'uploaded';
	node: string;
	input: string;
}

/**
 * A fixed set of LoRA loader nodes. Slot i takes `loras[i]`; every unused slot
 * has its strengths zeroed so a template with three slots and one LoRA does
 * not apply two leftovers from whatever the graph shipped with.
 */
export interface LoraSlotsBinding {
	kind: 'loraSlots';
	nodes: string[];
}

export interface FieldMap {
	/** The SaveImage node whose results are collected. */
	outputNode: string;
	prompt?: ScalarBinding;
	negativePrompt?: ScalarBinding;
	seed?: ScalarBinding;
	width?: ScalarBinding;
	height?: ScalarBinding;
	model?: ScalarBinding;
	samplerName?: ScalarBinding;
	samplerSteps?: ScalarBinding;
	samplerCfg?: ScalarBinding;
	referenceImage?: UploadedBinding;
	referenceStrength?: ScalarBinding;
	loras?: LoraSlotsBinding;
}

/** Values a binding can carry that are not on the request verbatim. */
export interface DerivedValues {
	/** Server-side filename returned by the upload, for `referenceImage`. */
	referenceFilename?: string;
	/** Resolved checkpoint, after the settings default is applied. */
	model?: string;
}

function missingNode(graph: ComfyGraph, node: string): boolean {
	return !Object.prototype.hasOwnProperty.call(graph, node);
}

function missingInput(graph: ComfyGraph, node: string, input: string): boolean {
	return !Object.prototype.hasOwnProperty.call(graph[node].inputs, input);
}

/**
 * Every problem with a map against a graph, as sentences. Run when the backend
 * is configured, so a broken bundled template or a bad user map fails there
 * rather than forty images into an overnight run.
 */
export function validateFieldMap(graph: ComfyGraph, map: FieldMap): string[] {
	const problems: string[] = [];
	const checkSlot = (label: string, node: string, input: string) => {
		if (missingNode(graph, node)) {
			problems.push(`${label} binds node "${node}", which the workflow does not contain.`);
			return;
		}
		if (missingInput(graph, node, input)) {
			problems.push(`${label} binds input "${input}" of node "${node}", which does not exist.`);
		}
	};

	if (missingNode(graph, map.outputNode)) {
		problems.push(`The output node "${map.outputNode}" is not in the workflow.`);
	}
	for (const [label, binding] of Object.entries(map)) {
		if (label === 'outputNode' || !binding || typeof binding !== 'object') continue;
		const b = binding as ScalarBinding | UploadedBinding | LoraSlotsBinding;
		if (b.kind === 'loraSlots') {
			if (b.nodes.length === 0) {
				problems.push('The LoRA binding declares no slots; omit it instead.');
			}
			b.nodes.forEach((n, i) => checkSlot(`LoRA slot ${i}`, n, 'lora_name'));
		} else {
			checkSlot(label, b.node, b.input);
		}
	}
	return problems;
}

function setScalar(graph: ComfyGraph, b: ScalarBinding | UploadedBinding, value: unknown): void {
	if (missingNode(graph, b.node) || missingInput(graph, b.node, b.input)) {
		throw new Error(`Workflow has no input "${b.input}" on node "${b.node}".`);
	}
	graph[b.node].inputs[b.input] = value;
}

/**
 * A graph with the request substituted in. The source graph is never mutated —
 * templates are module-level constants and a run generates many images from
 * each one.
 */
export function applyFieldMap(
	graph: ComfyGraph,
	map: FieldMap,
	req: ImageRequest,
	derived: DerivedValues = {}
): ComfyGraph {
	const out: ComfyGraph = structuredClone(graph);

	const scalars: Array<[ScalarBinding | undefined, unknown]> = [
		[map.prompt, req.prompt],
		[map.negativePrompt, req.negativePrompt],
		[map.seed, req.seed],
		[map.width, req.width],
		[map.height, req.height],
		[map.model, derived.model ?? req.model],
		[map.samplerName, req.sampler?.name],
		[map.samplerSteps, req.sampler?.steps],
		[map.samplerCfg, req.sampler?.cfg],
		[map.referenceStrength, req.referenceStrength]
	];
	for (const [binding, value] of scalars) {
		// An absent value leaves the template's own default in place; an absent
		// binding means this template does not take that parameter at all.
		if (binding && value !== undefined && value !== null) setScalar(out, binding, value);
	}

	if (map.referenceImage && derived.referenceFilename) {
		setScalar(out, map.referenceImage, derived.referenceFilename);
	}

	if (map.loras) {
		const wanted = req.loras ?? [];
		map.loras.nodes.forEach((node, i) => {
			if (missingNode(out, node)) {
				throw new Error(`Workflow has no LoRA node "${node}".`);
			}
			const lora = wanted[i];
			const inputs = out[node].inputs;
			inputs.lora_name = lora ? lora.name : (inputs.lora_name ?? '');
			// Zeroed rather than left alone: an unused slot must contribute
			// nothing, whatever the template shipped with.
			inputs.strength_model = lora ? lora.strength : 0;
			inputs.strength_clip = lora ? lora.strength : 0;
		});
	}

	return out;
}
