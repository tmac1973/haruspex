/**
 * An orbiting view of a GLB, for an editor window's `.glb` tab. `three` is
 * imported here and nowhere at the top level, so it stays in a chunk of its
 * own until the first model opens.
 */

import type { Mesh, Object3D } from 'three';
import { disposeTree } from '#lib/specialists/three/preview.ts';

export interface GlbStats {
	meshes: number;
	triangles: number;
	size: [number, number, number];
	animations: number;
}

export interface GlbView {
	stats: GlbStats;
	/** Put the camera back where it started. */
	resetCamera(): void;
	dispose(): void;
}

/** The preview's framing: the camera sits this far from the centre, in largest dimensions. */
const VIEW = [1.2, 0.8, 1.6] as const;

/**
 * Show `bytes` in `canvas`, filling its parent, with drag to orbit, wheel to
 * zoom and right-drag to pan. Rejects when the GLB does not parse.
 */
export async function mountGlbView(canvas: HTMLCanvasElement, bytes: Uint8Array): Promise<GlbView> {
	const THREE = await import('three');
	const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
	const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
	const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');

	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	const gltf = await new GLTFLoader().parseAsync(buffer as ArrayBuffer, '');
	const root = gltf.scene;

	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
	renderer.setPixelRatio(window.devicePixelRatio);
	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x3a3a3a);
	// Metal and glass need something to reflect; plain lights leave them black.
	const pmrem = new THREE.PMREMGenerator(renderer);
	const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
	scene.environment = envMap;
	scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1));
	scene.add(root);

	const box = new THREE.Box3().setFromObject(root);
	const centre = box.getCenter(new THREE.Vector3());
	const sizes = box.getSize(new THREE.Vector3());
	const dim = Math.max(sizes.x, sizes.y, sizes.z);
	const reach = Number.isFinite(dim) && dim > 0 ? dim : 1;
	const at = Number.isFinite(centre.x + centre.y + centre.z) ? centre : new THREE.Vector3();

	const grid = new THREE.GridHelper(reach * 4, 20, 0x666666, 0x4a4a4a);
	grid.position.y = Number.isFinite(box.min.y) ? box.min.y : 0;
	scene.add(grid);

	const camera = new THREE.PerspectiveCamera(40, 1, reach / 100, reach * 100);
	const controls = new OrbitControls(camera, canvas);
	controls.enableDamping = true;
	function resetCamera(): void {
		camera.position.set(at.x + VIEW[0] * reach, at.y + VIEW[1] * reach, at.z + VIEW[2] * reach);
		controls.target.copy(at);
		controls.update();
	}
	resetCamera();

	const mixer = gltf.animations.length > 0 ? new THREE.AnimationMixer(root) : null;
	for (const clip of gltf.animations) mixer?.clipAction(clip).play();
	const clock = new THREE.Clock();

	function resize(): void {
		const parent = canvas.parentElement;
		const w = parent?.clientWidth || 1;
		const h = parent?.clientHeight || 1;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}
	const observer = new ResizeObserver(resize);
	if (canvas.parentElement) observer.observe(canvas.parentElement);
	resize();

	renderer.setAnimationLoop(() => {
		mixer?.update(clock.getDelta());
		controls.update();
		renderer.render(scene, camera);
	});

	return {
		stats: countStats(root, [sizes.x, sizes.y, sizes.z], gltf.animations.length),
		resetCamera,
		dispose() {
			renderer.setAnimationLoop(null);
			observer.disconnect();
			controls.dispose();
			disposeTree(root);
			envMap.dispose();
			pmrem.dispose();
			renderer.dispose();
		}
	};
}

function countStats(root: Object3D, size: [number, number, number], animations: number): GlbStats {
	let meshes = 0;
	let triangles = 0;
	root.traverse((o) => {
		const mesh = o as Mesh;
		if (!mesh.isMesh) return;
		meshes++;
		const geo = mesh.geometry;
		const pos = geo.getAttribute('position');
		triangles += Math.floor((geo.index ? geo.index.count : (pos?.count ?? 0)) / 3);
	});
	return { meshes, triangles, size, animations };
}
