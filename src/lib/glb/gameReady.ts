/**
 * What a game engine cares about beyond the shape: how many draw calls the
 * asset costs and how few it could cost, materials it can't name, and which
 * way the front faces. Pure, like the rest of the report: it reads a loaded
 * scene and draws nothing.
 */
import type { Material, Mesh, Object3D } from 'three';
import type { LoadedGlb, Three } from '#lib/glb/load.ts';
import type { Vec3 } from '#lib/glb/report.ts';

/** Past this many draw calls, a merge that saves a quarter of them is suggested. */
export const MANY_DRAW_CALLS = 32;
/** A merge is worth suggesting when it would leave at most this share of the draw calls. */
const MERGE_SHARE = 0.75;
/** Parts that sit at the front of a face or a foot, by name. */
const FRONT_PART = /eye|nose|snout|muzzle|beak|mouth|face|visor|jaw|teeth|tusk|toe|beard/i;
/** The front parts' centre must sit this share of the asset's depth off the rest to count. */
const FRONT_LEAN = 0.02;
/** The other parts at the front parts' height: within this share of the asset's height. */
const BAND = 0.1;

export interface DrawCalls {
	/** One per mesh, or one per material group of a multi-material mesh. */
	drawCalls: number;
	/** What merging the meshes that share a material, a pivot and attributes would leave. */
	merged: number;
}

export interface Facing {
	/** Where the front parts sit from the centre: +z is right. */
	faces: '+z' | '-z' | '+x' | '-x';
	parts: string[];
}

const materialsOf = (mesh: Mesh): Material[] =>
	Array.isArray(mesh.material) ? mesh.material : [mesh.material];

function meshesOf(root: Object3D): Mesh[] {
	const out: Mesh[] = [];
	root.traverse((o) => {
		if ((o as Mesh).isMesh) out.push(o as Mesh);
	});
	return out;
}

/** The nodes any clip moves, by name. */
function animatedNodes(THREE: Three, gltf: LoadedGlb): Set<string> {
	const out = new Set<string>();
	for (const clip of gltf.animations) {
		for (const t of clip.tracks) out.add(THREE.PropertyBinding.parseTrackName(t.name).nodeName);
	}
	return out;
}

/**
 * The asset's draw calls, and how many would be left after merging meshes
 * that move together (under the same animated node, or none), share their
 * materials and carry the same vertex attributes. A skinned mesh stays as it is.
 */
export function drawCallsOf(THREE: Three, gltf: LoadedGlb): DrawCalls {
	const animated = animatedNodes(THREE, gltf);
	const mover = (o: Object3D): string => {
		for (let p: Object3D | null = o; p; p = p.parent) {
			if (p !== o && animated.has(p.name)) return p.uuid;
			if (p === gltf.scene) break;
		}
		return 'still';
	};
	let drawCalls = 0;
	const groups = new Set<string>();
	for (const mesh of meshesOf(gltf.scene)) {
		const mats = materialsOf(mesh);
		const calls = Array.isArray(mesh.material) ? Math.max(1, mesh.geometry.groups.length) : 1;
		drawCalls += calls;
		if ((mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh || animated.has(mesh.name)) {
			groups.add(mesh.uuid);
			continue;
		}
		const attrs = Object.keys(mesh.geometry.attributes).sort().join(',');
		for (const m of mats) groups.add(`${mover(mesh)}|${m.uuid}|${attrs}`);
	}
	return { drawCalls, merged: Math.min(drawCalls, groups.size) };
}

/** Whether merging is worth a warning. */
export const worthMerging = (d: DrawCalls) =>
	d.drawCalls >= MANY_DRAW_CALLS && d.merged <= MERGE_SHARE * d.drawCalls;

/** How many of the asset's materials have no name. */
export function unnamedMaterials(root: Object3D): number {
	const seen = new Set<string>();
	let n = 0;
	for (const mesh of meshesOf(root)) {
		for (const m of materialsOf(mesh)) {
			if (seen.has(m.uuid)) continue;
			seen.add(m.uuid);
			if (!m.name) n++;
		}
	}
	return n;
}

/**
 * Which way the front faces, read from parts named like eyes, a nose or toes:
 * where they sit from the other parts at their height (a visor from the
 * helmet, toes from the shins), not from the whole asset, whose centre a sword
 * or a tail moves. Null when no part is named so, or they sit too near the
 * centre to say.
 */
export function facingOf(THREE: Three, root: Object3D, size: Vec3): Facing | null {
	const centres = meshesOf(root).map((m) => ({
		m,
		c: new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3())
	}));
	const front = centres.filter(({ m }) => FRONT_PART.test(m.name));
	if (!front.length) return null;
	const ys = front.map(({ c }) => c.y);
	const pad = BAND * size[1];
	const [low, high] = [Math.min(...ys) - pad, Math.max(...ys) + pad];
	const near = centres.filter(({ m, c }) => !FRONT_PART.test(m.name) && c.y >= low && c.y <= high);
	if (!near.length) return null;
	const mean = (xs: { c: { x: number; z: number } }[]) => [
		xs.reduce((n, { c }) => n + c.x, 0) / xs.length,
		xs.reduce((n, { c }) => n + c.z, 0) / xs.length
	];
	const [fx, fz] = mean(front);
	const [nx, nz] = mean(near);
	const [x, z] = [fx - nx, fz - nz];
	if (Math.hypot(x, z) < FRONT_LEAN * Math.max(size[0], size[2])) return null;
	const faces = Math.abs(z) >= Math.abs(x) ? (z > 0 ? '+z' : '-z') : x > 0 ? '+x' : '-x';
	return { faces, parts: [...new Set(front.map(({ m }) => m.name))] };
}
