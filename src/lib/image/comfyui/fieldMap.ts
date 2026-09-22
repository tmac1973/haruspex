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

import type { ImageRequest, LoraRef } from '../types';

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
 * A chain of LoRA loader nodes. Slot i takes `loras[i]`; unused slots are
 * REMOVED from the graph and the chain spliced back together.
 *
 * Zeroing their strengths is not enough, and a real server is the only place
 * that shows it: ComfyUI validates `lora_name` against the LoRAs actually
 * installed, so a loader left in the graph with an empty name fails
 * validation and takes the whole prompt down with it — on any server with no
 * LoRAs, which is most of them. A strength of 0 on a node that was refused
 * before it ran buys nothing.
 *
 * `source` is the node feeding the chain (the checkpoint loader). When every
 * slot is unused the chain vanishes entirely and consumers are spliced
 * straight back to it.
 */
export interface LoraSlotsBinding {
	kind: 'loraSlots';
	/** Loader nodes, in chain order: `source` → nodes[0] → nodes[1] → … */
	nodes: string[];
	/** What feeds the first slot, and what consumers fall back to. */
	source: string;
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

	if (map.loras) applyLoraChain(out, map.loras, req.loras ?? []);

	return out;
}

/**
 * Replace every reference to `from` with one to `to`.
 *
 * A link in an API-format graph is `[nodeId, outputIndex]`, so splicing a node
 * out of a chain means rewriting the id and leaving the index alone — the
 * loaders pass model and clip through on the same output slots the checkpoint
 * uses, which is what makes the splice safe.
 */
function relink(graph: ComfyGraph, from: string, to: string): void {
	for (const node of Object.values(graph)) {
		for (const [name, value] of Object.entries(node.inputs)) {
			if (Array.isArray(value) && value.length === 2 && value[0] === from) {
				node.inputs[name] = [to, value[1]];
			}
		}
	}
}

/**
 * Fill the LoRA slots that are used and delete the ones that are not.
 *
 * See [`LoraSlotsBinding`] for why deletion rather than zeroing: an unused
 * loader is not inert, it is invalid, and ComfyUI refuses the whole prompt.
 */
function applyLoraChain(graph: ComfyGraph, binding: LoraSlotsBinding, wanted: LoraRef[]): void {
	for (const node of binding.nodes) {
		if (missingNode(graph, node)) throw new Error(`Workflow has no LoRA node "${node}".`);
	}
	if (missingNode(graph, binding.source)) {
		throw new Error(`Workflow has no node "${binding.source}" to feed the LoRA chain.`);
	}

	const used = Math.min(wanted.length, binding.nodes.length);
	for (let i = 0; i < used; i++) {
		const inputs = graph[binding.nodes[i]].inputs;
		inputs.lora_name = wanted[i].name;
		inputs.strength_model = wanted[i].strength;
		inputs.strength_clip = wanted[i].strength;
	}

	const unused = binding.nodes.slice(used);
	if (unused.length === 0) return;

	// Everything downstream referenced the chain's last node; after pruning it
	// must reference the last SURVIVING one — or the source, when the whole
	// chain goes.
	const oldTail = binding.nodes[binding.nodes.length - 1];
	const newTail = used > 0 ? binding.nodes[used - 1] : binding.source;
	if (oldTail !== newTail) relink(graph, oldTail, newTail);
	for (const node of unused) delete graph[node];
}
