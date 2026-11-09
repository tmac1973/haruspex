/**
 * An orbiting view of a GLB, for an editor window's `.glb` tab. `three` is
 * imported here and nowhere at the top level, so it stays in a chunk of its
 * own until the first model opens.
 */

import type { AnimationClip, AnimationMixer, Mesh, Object3D } from 'three';
import { disposeTree } from '#lib/glb/load.ts';
import { rigOf, trackNodes, type Rig } from '#lib/glb/rig.ts';

export interface GlbStats {
	meshes: number;
	triangles: number;
	size: [number, number, number];
	animations: number;
	/** How it moves; null for a model with no skin and no clips. */
	rig: Rig | null;
}

export interface GlbView {
	stats: GlbStats;
	/** The clips' names, in the file's order. */
	clips: string[];
	/** Loop one clip by index, or none (null) for the rest pose. */
	playClip(index: number | null): void;
	/** Put the camera back where it started. */
	resetCamera(): void;
	/** Where the camera is, for the next model to start from. */
	angle(): CameraAngle;
	dispose(): void;
}

/** The camera's offset from the model's centre, in largest dimensions. */
export type CameraAngle = readonly [number, number, number];

/** The preview's framing: the camera sits this far from the centre, in largest dimensions. */
const VIEW: CameraAngle = [1.2, 0.8, 1.6];

/**
 * Show `bytes` in `canvas`, filling its parent, with drag to orbit, wheel to
 * zoom and right-drag to pan. `start` puts the camera where it was on the
 * last model, scaled to this one. Rejects when the GLB does not parse.
 */
export async function mountGlbView(
	canvas: HTMLCanvasElement,
	bytes: Uint8Array,
	start: CameraAngle | null = null
): Promise<GlbView> {
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
	function place(offset: CameraAngle): void {
		camera.position
			.set(...offset)
			.multiplyScalar(reach)
			.add(at);
		controls.target.copy(at);
		controls.update();
	}
	place(start && start.every(Number.isFinite) ? start : VIEW);

	const { mixer, playClip } = clipPlayer(THREE, root, gltf.animations);
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
		stats: countStats(THREE, root, [sizes.x, sizes.y, sizes.z], gltf.animations),
		clips: gltf.animations.map((clip, i) => clip.name || `Clip ${i + 1}`),
		playClip,
		resetCamera: () => place(VIEW),
		angle() {
			const d = camera.position.clone().sub(controls.target).divideScalar(reach);
			return [d.x, d.y, d.z];
		},
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

/** Loop one clip at a time, starting on the first: a walk and a run played together are neither. */
function clipPlayer(
	THREE: typeof import('three'),
	root: Object3D,
	animations: AnimationClip[]
): { mixer: AnimationMixer | null; playClip(index: number | null): void } {
	const mixer = animations.length > 0 ? new THREE.AnimationMixer(root) : null;
	const actions = mixer ? animations.map((clip) => mixer.clipAction(clip)) : [];
	function playClip(index: number | null): void {
		mixer?.stopAllAction();
		if (index !== null) actions[index]?.play();
	}
	playClip(actions.length ? 0 : null);
	return { mixer, playClip };
}

function countStats(
	THREE: typeof import('three'),
	root: Object3D,
	size: [number, number, number],
	animations: AnimationClip[]
): GlbStats {
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
	// Skinned, or rigid when clips move it; a model with neither has no rig.
	const rig = rigOf(root, trackNodes(THREE, animations));
	const moves = rig.rig === 'skinned' || animations.length > 0;
	return { meshes, triangles, size, animations: animations.length, rig: moves ? rig : null };
}
