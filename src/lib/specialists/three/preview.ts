import type { Object3D } from 'three';
import { disposeTree, loadGlb } from '#lib/glb/load.ts';
import { inspectGlb } from '#lib/glb/report.ts';

export interface GlbPreview {
	/** True when `problems` is empty. */
	ok: boolean;
	problems: string[];
	meshes: number;
	triangles: number;
	animations: { name: string; tracks: number }[];
	size: [number, number, number];
	/** A render from a fixed angle; null when the GLB did not parse or nothing could draw. */
	png: string | null;
}

const WIDTH = 640;
const HEIGHT = 480;
/** The spike's framing: the camera sits this far from the centre, in largest dimensions. */
const VIEW = [1.2, 0.8, 1.6] as const;

/**
 * Load GLB bytes with the bundled `three`, count what is in them, flag
 * broken geometry, and render a PNG. The counting and checks are the shared
 * GLB report's (`#lib/glb/report.ts`).
 */
export async function previewGlb(bytes: Uint8Array): Promise<GlbPreview> {
	const empty: GlbPreview = {
		ok: false,
		problems: [],
		meshes: 0,
		triangles: 0,
		animations: [],
		size: [0, 0, 0],
		png: null
	};
	const loaded = await loadGlb(bytes);
	if ('error' in loaded) return { ...empty, problems: [loaded.error] };
	const { gltf, THREE } = loaded;
	const root = gltf.scene;
	const report = inspectGlb(THREE, gltf);
	const box = new THREE.Box3().setFromObject(root);
	const png = render(THREE, root, box);
	disposeTree(root);
	return {
		ok: report.problems.length === 0,
		problems: report.problems,
		meshes: report.meshes,
		triangles: report.triangles,
		animations: report.animations.map((a) => ({ name: a.name, tracks: a.tracks })),
		size: report.bounds.size,
		png
	};
}

function render(
	THREE: typeof import('three'),
	root: Object3D,
	box: import('three').Box3
): string | null {
	const canvas = document.createElement('canvas');
	canvas.width = WIDTH;
	canvas.height = HEIGHT;
	let renderer: import('three').WebGLRenderer | null = null;
	try {
		renderer = new THREE.WebGLRenderer({
			canvas,
			antialias: true,
			preserveDrawingBuffer: true,
			alpha: false
		});
		renderer.setSize(WIDTH, HEIGHT, false);
		const scene = new THREE.Scene();
		scene.background = new THREE.Color(0x808080);
		scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
		const sun = new THREE.DirectionalLight(0xffffff, 2);
		scene.add(sun);
		scene.add(root);

		const centre = box.getCenter(new THREE.Vector3());
		const sizes = box.getSize(new THREE.Vector3());
		const dim = Math.max(sizes.x, sizes.y, sizes.z);
		const reach = Number.isFinite(dim) && dim > 0 ? dim : 1;
		const camera = new THREE.PerspectiveCamera(40, WIDTH / HEIGHT, reach / 100, reach * 100);
		const at = Number.isFinite(centre.x + centre.y + centre.z) ? centre : new THREE.Vector3();
		camera.position.set(at.x + VIEW[0] * reach, at.y + VIEW[1] * reach, at.z + VIEW[2] * reach);
		camera.lookAt(at);
		sun.position.copy(camera.position).add(new THREE.Vector3(0, reach * 2, 0));

		renderer.render(scene, camera);
		scene.remove(root);
		return canvas.toDataURL('image/png');
	} catch (e) {
		console.warn('GLB preview could not render:', e);
		return null;
	} finally {
		renderer?.dispose();
	}
}

export { disposeTree };
