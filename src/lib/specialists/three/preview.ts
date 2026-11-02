import type { Material, Mesh, Object3D, Texture } from 'three';

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
 * broken geometry, and render a PNG. `three` is imported here and nowhere at
 * the top level, so it stays in a chunk of its own until the first preview.
 */
export async function previewGlb(bytes: Uint8Array): Promise<GlbPreview> {
	const THREE = await import('three');
	const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
	const empty: GlbPreview = {
		ok: false,
		problems: [],
		meshes: 0,
		triangles: 0,
		animations: [],
		size: [0, 0, 0],
		png: null
	};

	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	let gltf;
	try {
		gltf = await new GLTFLoader().parseAsync(buffer as ArrayBuffer, '');
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return { ...empty, problems: [`The GLB did not load: ${message}`] };
	}
	const root = gltf.scene;
	const problems: string[] = [];

	let meshes = 0;
	let triangles = 0;
	root.traverse((o) => {
		if (!(o as Mesh).isMesh) return;
		const mesh = o as Mesh;
		meshes++;
		const geo = mesh.geometry;
		const pos = geo.getAttribute('position');
		triangles += Math.floor((geo.index ? geo.index.count : (pos?.count ?? 0)) / 3);
		if (pos && Array.from(pos.array as ArrayLike<number>).some(Number.isNaN)) {
			problems.push(`Mesh '${mesh.name || '(unnamed)'}' has NaN vertex positions.`);
		}
	});
	if (meshes === 0) problems.push('The GLB has no meshes.');

	const box = new THREE.Box3().setFromObject(root);
	const v = box.getSize(new THREE.Vector3());
	const size: [number, number, number] = [v.x, v.y, v.z];
	if (!size.every(Number.isFinite) || size.every((n) => n === 0)) {
		problems.push('The GLB has zero or non-finite size.');
	}

	const animations = gltf.animations.map((a) => ({ name: a.name, tracks: a.tracks.length }));
	const png = render(THREE, root, box);
	disposeTree(root);
	return { ok: problems.length === 0, problems, meshes, triangles, animations, size, png };
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

function disposeTree(root: Object3D): void {
	root.traverse((o) => {
		const mesh = o as Mesh;
		if (!mesh.isMesh) return;
		mesh.geometry.dispose();
		const mats: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
		for (const m of mats) {
			for (const value of Object.values(m)) {
				if ((value as Texture | null)?.isTexture) (value as Texture).dispose();
			}
			m.dispose();
		}
	});
}
