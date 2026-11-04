/**
 * The Khronos glTF validator, run on every GLB `check_3d` and the models job
 * check. three.js loads and draws a lot that the spec forbids (colours past 1,
 * rotation keys that aren't unit quaternions, skin weights that don't sum to
 * 1), so a model can look right on the sheet and still break in Godot, Unity
 * or Blender. The validator says so; this turns its thousands of per-element
 * messages into one line per kind of issue, naming the meshes, clips and nodes
 * they point at, so a report stays short.
 */

/** The validator's message, as `validateBytes` reports it. */
interface Message {
	code: string;
	message: string;
	/** 0 error, 1 warning, 2 info, 3 hint. */
	severity: number;
	pointer?: string;
}

interface Validation {
	issues: { numErrors: number; messages: Message[] };
}

type ValidateBytes = (data: Uint8Array, options?: Record<string, unknown>) => Promise<Validation>;

/** Kinds of issue a model writing code makes, said plainly, with the fix. */
const PLAIN: Record<string, { what: string; fix: string }> = {
	ACCESSOR_NON_CLAMPED: {
		what: 'Vertex colour values outside 0–1',
		fix: 'keep colours within 0–1'
	},
	ACCESSOR_INVALID_FLOAT: {
		what: 'NaN or infinite values',
		fix: 'guard divisions and normalisations'
	},
	ACCESSOR_ANIMATION_SAMPLER_OUTPUT_NON_NORMALIZED_QUATERNION: {
		what: 'Rotation keys that are not unit quaternions',
		fix: 'build keys with Quaternion.setFromEuler or slerp, or normalize() each one'
	},
	ACCESSOR_ANIMATION_INPUT_NON_INCREASING: {
		what: 'Key times that do not increase',
		fix: 'sort each track’s times and drop repeats'
	},
	ACCESSOR_ANIMATION_INPUT_NEGATIVE: { what: 'Negative key times', fix: 'start clips at 0' },
	ACCESSOR_WEIGHTS_NON_NORMALIZED: {
		what: 'Skin weights that do not sum to 1',
		fix: 'normalise each vertex’s four weights'
	},
	ACCESSOR_WEIGHTS_NEGATIVE: { what: 'Negative skin weights', fix: 'clamp weights to 0 or more' },
	ACCESSOR_JOINTS_INDEX_DUPLICATE: {
		what: 'Vertices naming one bone twice',
		fix: 'merge a vertex’s weights per bone'
	},
	ACCESSOR_JOINTS_INDEX_OOB: {
		what: 'Skin indices past the skeleton',
		fix: 'index only the bones the skeleton has'
	},
	ANIMATION_CHANNEL_TARGET_NODE_SKIN: {
		what: 'Tracks on a skinned mesh’s own node (they do nothing)',
		fix: 'animate the bones instead'
	},
	NODE_SKINNED_MESH_LOCAL_TRANSFORMS: {
		what: 'A skinned mesh with its own transform (engines ignore it)',
		fix: 'leave the skinned mesh at the origin and move its bones'
	}
};

/** Warnings worth a model's attention; every other warning, info and hint is dropped. */
const KEPT_WARNINGS = new Set([
	'ANIMATION_CHANNEL_TARGET_NODE_SKIN',
	'NODE_SKINNED_MESH_LOCAL_TRANSFORMS'
]);

/** Kinds of issue shown before "and N more kinds". */
const MAX_KINDS = 6;
/** Names shown per kind before "and N more". */
const MAX_NAMES = 4;

export interface GlbValidation {
	/** The validator's error count (warnings aside). */
	errors: number;
	/** One line per kind of issue kept; empty when the GLB is clean. */
	lines: string[];
}

let loading: Promise<ValidateBytes> | null = null;

/** The validator, loaded once on first use: it is 300 KB that most turns never need. */
function validator(): Promise<ValidateBytes> {
	// A CommonJS module: the bundler may hand back its exports as `default`.
	loading ??= import('gltf-validator').then((m) => m.default.validateBytes);
	return loading;
}

interface Names {
	meshes: string[];
	nodes: string[];
	/** Clip names, and for each, sampler index → the node its channel moves. */
	clips: { name: string; samplerNode: Map<number, string> }[];
}

/** The names in a GLB's JSON chunk, for saying where an issue is. */
export function glbNames(bytes: Uint8Array): Names {
	const empty: Names = { meshes: [], nodes: [], clips: [] };
	try {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const length = view.getUint32(12, true);
		const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as {
			meshes?: { name?: string }[];
			nodes?: { name?: string; mesh?: number }[];
			animations?: {
				name?: string;
				channels?: { sampler: number; target?: { node?: number } }[];
			}[];
		};
		const nodes = (json.nodes ?? []).map((n, i) => n.name || `node ${i}`);
		return {
			// three's exporter names the node that holds a mesh, not the mesh.
			meshes: (json.meshes ?? []).map(
				(m, i) => m.name || json.nodes?.find((n) => n.mesh === i)?.name || `mesh ${i}`
			),
			nodes,
			clips: (json.animations ?? []).map((a, i) => ({
				name: a.name || `clip ${i}`,
				samplerNode: new Map(
					(a.channels ?? [])
						.filter((c) => c.target?.node !== undefined)
						.map((c) => [c.sampler, nodes[c.target!.node!] ?? `node ${c.target!.node}`])
				)
			}))
		};
	} catch {
		return empty;
	}
}

/** What an issue's JSON pointer names: a mesh, a node, a clip's track, or the pointer itself. */
export function subject(pointer: string | undefined, names: Names): string | null {
	if (!pointer) return null;
	const mesh = /^\/meshes\/(\d+)/.exec(pointer);
	if (mesh) return names.meshes[Number(mesh[1])] ?? `mesh ${mesh[1]}`;
	const node = /^\/nodes\/(\d+)/.exec(pointer);
	if (node) return names.nodes[Number(node[1])] ?? `node ${node[1]}`;
	const anim = /^\/animations\/(\d+)(?:\/(?:samplers|channels)\/(\d+))?/.exec(pointer);
	if (anim) {
		const clip = names.clips[Number(anim[1])];
		if (!clip) return `clip ${anim[1]}`;
		const on = anim[2] === undefined ? undefined : clip.samplerNode.get(Number(anim[2]));
		return on ? `${clip.name} (${on})` : clip.name;
	}
	const skin = /^\/skins\/(\d+)/.exec(pointer);
	if (skin) return `skin ${skin[1]}`;
	return null;
}

/** One line per kind of issue, most frequent first. */
export function groupIssues(messages: Message[], names: Names): string[] {
	const kinds = new Map<string, { count: number; first: string; where: string[] }>();
	for (const m of messages) {
		if (m.severity !== 0 && !KEPT_WARNINGS.has(m.code)) continue;
		const k = kinds.get(m.code) ?? { count: 0, first: m.message, where: [] };
		k.count++;
		const s = subject(m.pointer, names);
		if (s && !k.where.includes(s)) k.where.push(s);
		kinds.set(m.code, k);
	}
	const sorted = [...kinds.entries()].sort((a, b) => b[1].count - a[1].count);
	const lines = sorted.slice(0, MAX_KINDS).map(([code, k]) => {
		const shown = k.where.slice(0, MAX_NAMES).join(', ');
		const more = k.where.length > MAX_NAMES ? ` and ${k.where.length - MAX_NAMES} more` : '';
		const at = shown ? ` in ${shown}${more}` : '';
		const plain = PLAIN[code];
		return plain
			? `- ${plain.what} ×${k.count}${at}: ${plain.fix}.`
			: `- ${code} ×${k.count}${at}: ${k.first}`;
	});
	if (sorted.length > MAX_KINDS)
		lines.push(`- and ${sorted.length - MAX_KINDS} more kinds of issue.`);
	return lines;
}

/**
 * Validate GLB bytes. A validator that can't load or throws gives no lines:
 * the check goes on without it rather than failing a model over our tooling.
 */
export async function validateGlb(bytes: Uint8Array): Promise<GlbValidation> {
	try {
		const validate = await validator();
		const result = await validate(bytes, { maxIssues: 0 });
		return {
			errors: result.issues.numErrors,
			lines: groupIssues(result.issues.messages, glbNames(bytes))
		};
	} catch (e) {
		console.warn('glTF validator failed:', e);
		return { errors: 0, lines: [] };
	}
}
