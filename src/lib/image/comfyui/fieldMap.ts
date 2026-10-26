/**
 * Binding a request's parameters into a ComfyUI API-format workflow graph.
 *
 * A graph is a flat map of node id → `{ class_type, inputs }`, so every
 * parameter has to be addressed as "this input of that node". One
 * `{node, input}` slot covers most of them, but not all: a size may have to
 * reach several nodes at once (a transparent canvas is an image and a mask of
 * the same size), and a variable-length LoRA list has to land in a fixed set
 * of loader nodes. Those are the reasons this has binding kinds rather than a
 * flat record.
 *
 * A binding naming a node or input the graph does not contain is an error, not
 * a silent no-op. A typo would otherwise produce a perfectly good picture made
 * with default parameters, which is the worst failure available here: it looks
 * like success.
 */

import type { ImageRequest, LoraRef } from '#lib/image/types.ts';

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
	/**
	 * A numeric value lands multiplied by this, rounded: a crop at half the
	 * width, a mask band at a quarter of it. Omitted means the value as is.
	 */
	scale?: number;
}

/**
 * A value that must land in several places at once. Every slot gets the same
 * value (times its own `scale`); a graph that disagreed with itself about its
 * own size would fail on the server, or worse, run at whichever size won.
 */
export type MultiBinding = ScalarBinding | ScalarBinding[];

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

/**
 * The pictures an edit changes. Each uploaded picture gets a `LoadImage` node
 * of its own, wired to `node`'s `${prefix}1`, `${prefix}2`, …: the slots of an
 * autogrow input, which ComfyUI's API names `<input>.<slot>` (`images.image_1`
 * on `TextEncodeQwenImage21`). Built here because the count varies per request.
 */
export interface EditImagesBinding {
	kind: 'editImages';
	/** The node whose slots take the pictures, or several that each take them all. */
	node: string | string[];
	prefix: string;
	/**
	 * A node whose `image` input takes the first picture, and whose output
	 * then fills slot 1: Qwen-Image-Edit scales its first picture
	 * (`FluxKontextImageScale`), and samples from it.
	 */
	firstThrough?: string;
}

/**
 * The pictures of a FLUX.2 edit: each is scaled to the request's area,
 * VAE-encoded and chained through a `ReferenceLatent` on both of `guider`'s
 * conditionings, as ComfyUI's klein workflows do. `size` (a `GetImageSize`)
 * reads the first picture as scaled, so the result takes its shape.
 */
export interface ReferenceLatentsBinding {
	kind: 'referenceLatents';
	guider: string;
	vae: string;
	size: string;
}

export interface FieldMap {
	/** The SaveImage node whose results are collected. */
	outputNode: string;
	prompt?: ScalarBinding;
	negativePrompt?: ScalarBinding;
	seed?: ScalarBinding;
	width?: MultiBinding;
	height?: MultiBinding;
	model?: ScalarBinding;
	/** A DiT family's separate text encoder file. */
	textEncoder?: ScalarBinding;
	/** A DiT family's separate VAE file. */
	vae?: ScalarBinding;
	samplerName?: ScalarBinding;
	samplerSteps?: ScalarBinding;
	samplerCfg?: ScalarBinding;
	loras?: LoraSlotsBinding;
	editImages?: EditImagesBinding;
	referenceLatents?: ReferenceLatentsBinding;
	/**
	 * The edge an edit's reference pictures are resized to, about: the square
	 * root of the request's area, in 32s. The result takes the first picture's
	 * shape at that size.
	 */
	resolution?: ScalarBinding;
}

/** Values a binding can carry that are not on the request verbatim. */
export interface DerivedValues {
	/** Resolved model, after the settings default is applied. */
	model?: string;
	/** Resolved from the server's own file lists, for a DiT family. */
	textEncoder?: string;
	vae?: string;
	/** An edit's pictures, as `/upload/image` named them on the server. */
	editImages?: string[];
}

function missingNode(graph: ComfyGraph, node: string): boolean {
	return !Object.prototype.hasOwnProperty.call(graph, node);
}

function missingInput(graph: ComfyGraph, node: string, input: string): boolean {
	return !Object.prototype.hasOwnProperty.call(graph[node].inputs, input);
}

/** The template's own nodes an edit's pictures are wired into. */
function pictureNodes(b: EditImagesBinding | ReferenceLatentsBinding): string[] {
	return b.kind === 'referenceLatents'
		? [b.guider, b.vae, b.size]
		: [b.node, b.firstThrough ?? []].flat();
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
		if (Array.isArray(binding)) {
			if (binding.length === 0) problems.push(`${label} binds no slots; omit it instead.`);
			binding.forEach((b: ScalarBinding, i) => checkSlot(`${label} [${i}]`, b.node, b.input));
			continue;
		}
		const b = binding as
			ScalarBinding | LoraSlotsBinding | EditImagesBinding | ReferenceLatentsBinding;
		if (b.kind === 'referenceLatents' || b.kind === 'editImages') {
			// Their nodes are made per request; the nodes they join must be there.
			for (const node of pictureNodes(b).filter((n) => missingNode(graph, n))) {
				problems.push(`${label} binds node "${node}", which the workflow does not contain.`);
			}
		} else if (b.kind === 'loraSlots') {
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

function setScalar(graph: ComfyGraph, binding: MultiBinding, value: unknown): void {
	for (const b of Array.isArray(binding) ? binding : [binding]) {
		if (missingNode(graph, b.node) || missingInput(graph, b.node, b.input)) {
			throw new Error(`Workflow has no input "${b.input}" on node "${b.node}".`);
		}
		graph[b.node].inputs[b.input] =
			b.scale !== undefined && typeof value === 'number' ? Math.round(value * b.scale) : value;
	}
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

	const scalars: Array<[MultiBinding | undefined, unknown]> = [
		[map.prompt, req.prompt],
		[map.negativePrompt, req.negativePrompt],
		[map.seed, req.seed],
		[map.width, req.width],
		[map.height, req.height],
		[map.model, derived.model ?? req.model],
		[map.textEncoder, derived.textEncoder],
		[map.vae, derived.vae],
		[map.samplerName, req.sampler?.name],
		[map.samplerSteps, req.sampler?.steps],
		[map.samplerCfg, req.sampler?.cfg],
		[map.resolution, Math.max(32, Math.round(Math.sqrt(req.width * req.height) / 32) * 32)]
	];
	for (const [binding, value] of scalars) {
		// An absent value leaves the template's own default in place; an absent
		// binding means this template does not take that parameter at all.
		if (binding && value !== undefined && value !== null) setScalar(out, binding, value);
	}

	if (map.loras) applyLoraChain(out, map.loras, req.loras ?? []);
	applyPictures(out, map, derived.editImages ?? [], req);

	return out;
}

/** An edit's pictures, by whichever binding the workflow has. */
function applyPictures(graph: ComfyGraph, map: FieldMap, names: string[], req: ImageRequest): void {
	if (map.editImages) applyEditImages(graph, map.editImages, names);
	if (map.referenceLatents) applyReferenceLatents(graph, map.referenceLatents, names, req);
}

/** A `LoadImage` node per uploaded picture, each wired to its slot. */
function applyEditImages(graph: ComfyGraph, binding: EditImagesBinding, names: string[]): void {
	const nodes = [binding.node].flat();
	for (const node of [...nodes, binding.firstThrough ?? []].flat()) {
		if (missingNode(graph, node)) {
			throw new Error(`Workflow has no node "${node}" for the edit's pictures.`);
		}
	}
	if (names.length === 0) throw new Error('An edit workflow needs at least one picture.');
	names.forEach((name, i) => {
		const id = `edit_image_${i + 1}`;
		graph[id] = { class_type: 'LoadImage', inputs: { image: name } };
		let source = [id, 0];
		if (i === 0 && binding.firstThrough) {
			graph[binding.firstThrough].inputs.image = source;
			source = [binding.firstThrough, 0];
		}
		for (const node of nodes) graph[node].inputs[`${binding.prefix}${i + 1}`] = source;
	});
}

/** Each picture loaded, scaled, encoded and chained onto both conditionings. */
function applyReferenceLatents(
	graph: ComfyGraph,
	binding: ReferenceLatentsBinding,
	names: string[],
	req: ImageRequest
): void {
	for (const node of [binding.guider, binding.vae, binding.size]) {
		if (missingNode(graph, node)) throw new Error(`Workflow has no node "${node}" for the edit.`);
	}
	if (names.length === 0) throw new Error('An edit workflow needs at least one picture.');
	const megapixels = Math.max(0.01, Math.round((req.width * req.height) / 1048576 / 0.01) * 0.01);
	const guider = graph[binding.guider].inputs;
	let positive = guider.positive;
	let negative = guider.negative;
	names.forEach((name, i) => {
		const n = i + 1;
		graph[`edit_image_${n}`] = { class_type: 'LoadImage', inputs: { image: name } };
		graph[`edit_scale_${n}`] = {
			class_type: 'ImageScaleToTotalPixels',
			inputs: {
				image: [`edit_image_${n}`, 0],
				upscale_method: 'nearest-exact',
				megapixels: Number(megapixels.toFixed(2)),
				resolution_steps: 1
			}
		};
		graph[`edit_latent_${n}`] = {
			class_type: 'VAEEncode',
			inputs: { pixels: [`edit_scale_${n}`, 0], vae: [binding.vae, 0] }
		};
		graph[`edit_positive_${n}`] = {
			class_type: 'ReferenceLatent',
			inputs: { conditioning: positive, latent: [`edit_latent_${n}`, 0] }
		};
		graph[`edit_negative_${n}`] = {
			class_type: 'ReferenceLatent',
			inputs: { conditioning: negative, latent: [`edit_latent_${n}`, 0] }
		};
		positive = [`edit_positive_${n}`, 0];
		negative = [`edit_negative_${n}`, 0];
	});
	guider.positive = positive;
	guider.negative = negative;
	graph[binding.size].inputs.image = ['edit_scale_1', 0];
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
