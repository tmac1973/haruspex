/**
 * What a model should learn about a GLB before it calls the asset done: its
 * size and where it stands, each part's bounds, parts that float free or hide
 * inside others, faces that vanish from behind or point inward, its draw
 * calls and which way it faces, and its materials, textures and clips. Pure: it reads a loaded scene and draws
 * nothing, so it runs on anyone's GLB without running anyone's code.
 */
import type { BufferGeometry, Material, Mesh, Object3D, Texture } from 'three';
import type { LoadedGlb, Three } from '#lib/glb/load.ts';
import { drawCallsOf, facingOf, unnamedMaterials, worthMerging } from '#lib/glb/gameReady.ts';

export type Vec3 = [number, number, number];

export interface Bounds {
	min: Vec3;
	max: Vec3;
	size: Vec3;
}

export interface PartInfo {
	name: string;
	min: Vec3;
	max: Vec3;
	triangles: number;
	material: string;
	doubleSided: boolean;
}

export interface MaterialInfo {
	name: string;
	type: string;
	/** `#rrggbb`, when the material has a colour. */
	color: string | null;
	metalness: number | null;
	roughness: number | null;
	transparent: boolean;
	/** The colour map's size, `[w, h]`, when there is one. */
	map: [number, number] | null;
}

export interface GlbReport {
	bounds: Bounds;
	height: number;
	feetY: number;
	/** The bounds' centre on x and z: how far the asset sits off the origin. */
	centreOffset: [number, number];
	meshes: number;
	triangles: number;
	/** What a game draws it in, and what merging what can be merged would leave. */
	drawCalls: number;
	mergedDrawCalls: number;
	parts: PartInfo[];
	/** Parts whose box touches no other part's. */
	floating: string[];
	/** Parts wholly inside another, opaque and closed, part's volume. */
	buried: { part: string; inside: string }[];
	/** Parts tiny next to the whole asset. */
	outliers: string[];
	/** The parts with the most triangles, most first (at most five). */
	heaviest: { name: string; triangles: number }[];
	/** These fail the check. */
	problems: string[];
	/** These are reported and never fail. */
	warnings: string[];
	materials: MaterialInfo[];
	textures: [number, number][];
	animations: { name: string; duration: number; tracks: number }[];
}

export interface InspectOptions {
	/** Warn when the asset has more triangles than this. */
	maxTriangles?: number;
	/** The height it should be (m), as a spec says: warn when it is off by over `HEIGHT_TOLERANCE`. */
	specHeight?: number;
}

/** How far the measured height may stray from the spec's, as a fraction. */
export const HEIGHT_TOLERANCE = 0.1;

/** Past this, a texture is warned about. */
export const MAX_TEXTURE_EDGE = 2048;
/** A part's box is grown by this share of the asset's largest dimension before testing contact. */
const CONTACT_SLACK = 0.01;
/** Parts under this share of the asset's largest dimension are outliers. */
const TINY = 0.005;

const vec = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];

function triangleCount(geo: BufferGeometry): number {
	const pos = geo.getAttribute('position');
	return Math.floor((geo.index ? geo.index.count : (pos?.count ?? 0)) / 3);
}

function materialsOf(mesh: Mesh): Material[] {
	return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/** The weld tolerance for an asset whose largest dimension is `dim`. */
export const weldFor = (dim: number) => Math.max(dim, 1e-6) * 1e-5;

/** Whether a part can hide another: closed, and not entirely see-through. */
export function isClosedOpaque(mesh: Mesh, weld: number): boolean {
	return (
		!materialsOf(mesh).every((m) => m.transparent) && meshShape(mesh.geometry, weld).boundary === 0
	);
}

function meshesOf(root: Object3D): Mesh[] {
	const out: Mesh[] = [];
	root.traverse((o) => {
		if ((o as Mesh).isMesh) out.push(o as Mesh);
	});
	return out;
}

/** Every texture a material holds (its map, normal map, and so on). */
function texturesOf(m: Material): Texture[] {
	return Object.values(m).filter((v): v is Texture => !!(v as Texture | null)?.isTexture);
}

function textureSize(t: Texture): [number, number] | null {
	const img = t.image as { width?: number; height?: number } | null | undefined;
	return img?.width && img?.height ? [img.width, img.height] : null;
}

/**
 * Boundary edges and signed volume of a mesh's triangles, after welding its
 * vertices by position: a GLB splits vertices at UV and normal seams, so
 * without the weld nearly every mesh would look open.
 */
export function meshShape(geo: BufferGeometry, weld: number): { boundary: number; volume: number } {
	const pos = geo.getAttribute('position');
	if (!pos) return { boundary: 0, volume: 0 };
	const ids = new Map<string, number>();
	const welded: number[] = [];
	for (let i = 0; i < pos.count; i++) {
		const key = `${Math.round(pos.getX(i) / weld)},${Math.round(pos.getY(i) / weld)},${Math.round(pos.getZ(i) / weld)}`;
		let id = ids.get(key);
		if (id === undefined) {
			id = ids.size;
			ids.set(key, id);
		}
		welded.push(id);
	}
	const index = geo.index;
	const tris = triangleCount(geo);
	const edges = new Map<string, number>();
	let volume = 0;
	for (let t = 0; t < tris; t++) {
		const v = [0, 1, 2].map((k) => (index ? index.getX(t * 3 + k) : t * 3 + k));
		const [a, b, c] = v;
		volume +=
			(pos.getX(a) * (pos.getY(b) * pos.getZ(c) - pos.getZ(b) * pos.getY(c)) -
				pos.getY(a) * (pos.getX(b) * pos.getZ(c) - pos.getZ(b) * pos.getX(c)) +
				pos.getZ(a) * (pos.getX(b) * pos.getY(c) - pos.getY(b) * pos.getX(c))) /
			6;
		const w = v.map((i) => welded[i]);
		for (const [p, q] of [
			[w[0], w[1]],
			[w[1], w[2]],
			[w[2], w[0]]
		]) {
			if (p === q) continue;
			const key = p < q ? `${p}-${q}` : `${q}-${p}`;
			edges.set(key, (edges.get(key) ?? 0) + 1);
		}
	}
	let boundary = 0;
	for (const n of edges.values()) if (n === 1) boundary++;
	return { boundary, volume };
}

function overlaps(a: PartInfo, b: PartInfo, slack: number): boolean {
	for (let i = 0; i < 3; i++) {
		if (a.max[i] + slack < b.min[i] - slack || b.max[i] + slack < a.min[i] - slack) return false;
	}
	return true;
}

function contains(outer: PartInfo, inner: PartInfo): boolean {
	for (let i = 0; i < 3; i++) {
		if (inner.min[i] < outer.min[i] || inner.max[i] > outer.max[i]) return false;
	}
	return true;
}

function boxVolume(p: PartInfo): number {
	return (p.max[0] - p.min[0]) * (p.max[1] - p.min[1]) * (p.max[2] - p.min[2]);
}

function largest(p: { min: Vec3; max: Vec3 }): number {
	return Math.max(p.max[0] - p.min[0], p.max[1] - p.min[1], p.max[2] - p.min[2]);
}

/** Floating, buried and outlier parts, against the asset's largest dimension. */
function partRelations(
	parts: PartInfo[],
	dim: number,
	hidden: (part: number, host: number) => boolean
) {
	const floating: string[] = [];
	const buried: { part: string; inside: string }[] = [];
	const outliers: string[] = [];
	const slack = dim * CONTACT_SLACK;
	parts.forEach((p, i) => {
		const others = parts.filter((q) => q !== p);
		if (others.length && !others.some((q) => overlaps(p, q, slack))) floating.push(p.name);
		const host = parts.findIndex(
			(q, j) => j !== i && contains(q, p) && boxVolume(q) > boxVolume(p) && hidden(i, j)
		);
		if (host >= 0) buried.push({ part: p.name, inside: parts[host].name });
		if (largest(p) / dim < TINY) outliers.push(p.name);
	});
	return { floating, buried, outliers };
}

/** Vertices sampled from a mesh, in world space: at most this many. */
const BURIED_SAMPLES = 24;
/** A ray direction no axis-aligned edge lies along. */
export const RAY: Vec3 = [0.9238, 0.3204, 0.2096];

/**
 * Whether every sampled vertex of `inner` lies inside `host`'s closed volume:
 * a ray from the point crosses the host's surface an odd number of times.
 */
function hiddenInside(THREE: Three, inner: Mesh, host: Mesh): boolean {
	const pos = inner.geometry.getAttribute('position');
	if (!pos?.count) return false;
	const mats = materialsOf(host);
	const sides = mats.map((m) => m.side);
	for (const m of mats) m.side = THREE.DoubleSide;
	const ray = new THREE.Raycaster();
	const dir = new THREE.Vector3(...RAY).normalize();
	const p = new THREE.Vector3();
	const step = Math.max(1, Math.floor(pos.count / BURIED_SAMPLES));
	try {
		for (let i = 0; i < pos.count; i += step) {
			p.fromBufferAttribute(pos, i).applyMatrix4(inner.matrixWorld);
			ray.set(p, dir);
			const hits = ray.intersectObject(host, false).map((h) => h.distance);
			const crossings = hits.filter((d, k) => k === 0 || d - hits[k - 1] > 1e-7).length;
			if (crossings % 2 === 0) return false;
		}
		return true;
	} finally {
		mats.forEach((m, k) => (m.side = sides[k]));
	}
}

function materialInfo(THREE: Three, m: Material): MaterialInfo {
	const any = m as Material & {
		color?: InstanceType<Three['Color']>;
		metalness?: number;
		roughness?: number;
		map?: Texture | null;
	};
	return {
		name: m.name || '(unnamed)',
		type: m.type.replace(/^Mesh/, '').replace(/Material$/, ''),
		color: any.color instanceof THREE.Color ? `#${any.color.getHexString()}` : null,
		metalness: typeof any.metalness === 'number' ? any.metalness : null,
		roughness: typeof any.roughness === 'number' ? any.roughness : null,
		transparent: m.transparent,
		map: any.map ? textureSize(any.map) : null
	};
}

/** The warnings about one mesh's faces and normals, and whether it is closed. */
function meshWarnings(
	THREE: Three,
	mesh: Mesh,
	name: string,
	weld: number
): { out: string[]; closed: boolean } {
	const out: string[] = [];
	const geo = mesh.geometry;
	if (!geo.getAttribute('normal')) out.push(`'${name}' has no normals.`);
	const { boundary, volume } = meshShape(geo, weld);
	const oneSided = materialsOf(mesh).some((m) => m.side === THREE.FrontSide);
	if (boundary > 0 && oneSided) {
		out.push(
			`'${name}' is one-sided and open: it vanishes from behind. Set side: THREE.DoubleSide or close it.`
		);
	}
	// Local winding: three (and engines) flip a mirrored node's faces back.
	if (boundary === 0 && volume < -1e-12) {
		out.push(`'${name}' has its faces pointing inward.`);
	}
	return { out, closed: boundary === 0 };
}

/** Each mesh's part info, shape warnings and materials, in one pass. */
function readMeshes(THREE: Three, meshes: Mesh[], weld: number) {
	const problems: string[] = [];
	const warnings: string[] = [];
	const parts: PartInfo[] = [];
	const closed: boolean[] = [];
	const materials = new Map<string, MaterialInfo>();
	const textures = new Map<string, [number, number]>();
	meshes.forEach((mesh, i) => {
		const name = mesh.name || `(unnamed ${i + 1})`;
		const geo = mesh.geometry;
		const pos = geo.getAttribute('position');
		if (pos && Array.from(pos.array as ArrayLike<number>).some(Number.isNaN)) {
			problems.push(`Mesh '${name}' has NaN vertex positions.`);
		}
		const mats = materialsOf(mesh);
		const mb = new THREE.Box3().setFromObject(mesh);
		parts.push({
			name,
			min: vec(mb.min),
			max: vec(mb.max),
			triangles: triangleCount(geo),
			material: mats[0]?.name || '(unnamed)',
			doubleSided: mats.every((m) => m.side === THREE.DoubleSide)
		});
		const shape = meshWarnings(THREE, mesh, name, weld);
		warnings.push(...shape.out);
		closed.push(shape.closed);
		for (const m of mats) {
			if (!materials.has(m.uuid)) materials.set(m.uuid, materialInfo(THREE, m));
			for (const t of texturesOf(m)) {
				const s = textureSize(t);
				if (s && !textures.has(t.uuid)) textures.set(t.uuid, s);
			}
		}
	});
	return { problems, warnings, parts, closed, materials, textures };
}

const metres = (m: number) => `${m.toFixed(2)} m`;

/** What would trip it up in a game: draw calls, unnamed materials, the wrong front, the wrong height. */
function gameWarnings(
	THREE: Three,
	root: Object3D,
	calls: ReturnType<typeof drawCallsOf>,
	b: Bounds,
	opts: InspectOptions
): string[] {
	const out: string[] = [];
	if (worthMerging(calls)) {
		out.push(
			`${calls.drawCalls} draw calls: merging meshes that share a material and move together (kit.mergeGeometries) would make it ${calls.merged}.`
		);
	}
	const unnamed = unnamedMaterials(root);
	if (unnamed) {
		out.push(
			`${unnamed} material${unnamed === 1 ? ' has' : 's have'} no name: name each, since engines list materials by name.`
		);
	}
	const facing = facingOf(THREE, root, b.size);
	if (facing && facing.faces !== '+z') {
		const named = facing.parts.slice(0, 3).join(', ');
		out.push(
			`The front seems to face ${facing.faces}: ${named} sit toward ${facing.faces} of the parts around them. Turn it so the front faces +z.`
		);
	}
	const h = b.size[1];
	if (
		opts.specHeight !== undefined &&
		Math.abs(h - opts.specHeight) > HEIGHT_TOLERANCE * opts.specHeight
	) {
		out.push(
			`Height is ${metres(h)}; the spec says ${metres(opts.specHeight)} (±${HEIGHT_TOLERANCE * 100}%). Pass height to scale it, or rebuild it to size.`
		);
	}
	return out;
}

/** Read a loaded GLB's measurements and checks. */
export function inspectGlb(THREE: Three, gltf: LoadedGlb, opts: InspectOptions = {}): GlbReport {
	const root = gltf.scene;
	root.updateMatrixWorld(true);
	const problems: string[] = [];
	const warnings: string[] = [];
	const meshes = meshesOf(root);

	const box = new THREE.Box3().setFromObject(root);
	const size = box.getSize(new THREE.Vector3());
	const bounds: Bounds = { min: vec(box.min), max: vec(box.max), size: vec(size) };
	const finite = [...bounds.min, ...bounds.max].every(Number.isFinite);
	const dim = finite ? Math.max(size.x, size.y, size.z) : 0;
	if (meshes.length === 0) problems.push('The GLB has no meshes.');
	if (!finite || dim === 0) problems.push('The GLB has zero or non-finite size.');

	const read = readMeshes(THREE, meshes, weldFor(dim));
	const { parts, closed, materials, textures } = read;
	problems.push(...read.problems);
	warnings.push(...read.warnings);

	for (const [w, h] of textures.values()) {
		if (w > MAX_TEXTURE_EDGE || h > MAX_TEXTURE_EDGE) {
			warnings.push(`A ${w}×${h} texture is over ${MAX_TEXTURE_EDGE} px on a side.`);
		}
	}
	const triangles = parts.reduce((n, p) => n + p.triangles, 0);
	const calls = drawCallsOf(THREE, gltf);
	warnings.push(...gameWarnings(THREE, root, calls, bounds, opts));
	if (opts.maxTriangles !== undefined && triangles > opts.maxTriangles) {
		warnings.push(`${triangles} triangles is over the budget of ${opts.maxTriangles}.`);
	}

	// A part is hidden only inside an opaque, closed host's actual volume.
	const hidden = (i: number, j: number) =>
		closed[j] &&
		!materialsOf(meshes[j]).every((m) => m.transparent) &&
		hiddenInside(THREE, meshes[i], meshes[j]);
	const relations =
		dim > 0 ? partRelations(parts, dim, hidden) : { floating: [], buried: [], outliers: [] };
	return {
		bounds,
		height: bounds.size[1],
		feetY: bounds.min[1],
		centreOffset: [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[2] + bounds.max[2]) / 2],
		meshes: meshes.length,
		triangles,
		drawCalls: calls.drawCalls,
		mergedDrawCalls: calls.merged,
		parts,
		...relations,
		heaviest: [...parts]
			.sort((a, b) => b.triangles - a.triangles)
			.slice(0, 5)
			.map((p) => ({ name: p.name, triangles: p.triangles })),
		problems,
		warnings,
		materials: [...materials.values()],
		textures: [...textures.values()],
		animations: gltf.animations.map((a) => ({
			name: a.name,
			duration: a.duration,
			tracks: a.tracks.length
		}))
	};
}
