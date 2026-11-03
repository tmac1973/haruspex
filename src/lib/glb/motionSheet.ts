/**
 * One image a model can judge a clip's motion by: eight frames from the right
 * and the same eight from the front, then every frame overlaid from each side
 * with trails of the parts that move most. Same size as the still sheet, so
 * asking for it costs no more. `motionSheetLayout` is the pure framing;
 * `renderMotionSheet` draws it.
 */
import type { AnimationClip, Material, Object3D } from 'three';
import type { Three } from '#lib/glb/load.ts';
import {
	meshesOf,
	partCentre,
	partsOf,
	posedBox,
	poser,
	strideFor,
	type Poser
} from '#lib/glb/motionPose.ts';
import { sampleTimes } from '#lib/glb/motion.ts';
import type { Vec3 } from '#lib/glb/report.ts';
import { SHEET_HEIGHT, SHEET_WIDTH } from '#lib/glb/sheet.ts';

export const FRAMES = 8;
const STRIP_HEIGHT = 200;
const TRAIL_POINTS = 24;
const MARGIN = 1.1;
const TRAIL_COLOURS = ['#ff5a5a', '#ffd34d', '#4dd2ff', '#7dff6a', '#ff7de9'];

export type MotionView = 'right' | 'front';

export interface MotionCell {
	x: number;
	y: number;
	w: number;
	h: number;
	view: MotionView;
	/** The frame it shows, or null for an overlay of every frame. */
	frame: number | null;
	/** The orthographic camera's half width and half height. */
	halfW: number;
	halfH: number;
}

export interface MotionLayout {
	cells: MotionCell[];
	centre: Vec3;
	/** How far each camera sits from the centre. */
	distance: number;
	floorY: number;
}

const DIRS: Record<MotionView, Vec3> = { right: [1, 0, 0], front: [0, 0, 1] };

/** Frame `box` (every pose, already reaching down to the floor) in each cell. */
export function motionSheetLayout(box: { min: Vec3; max: Vec3 }, floorY: number): MotionLayout {
	const min: Vec3 = [box.min[0], Math.min(box.min[1], floorY), box.min[2]];
	const max = box.max;
	const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
	const fit = (view: MotionView, w: number, h: number) => {
		const across = view === 'right' ? size[2] : size[0];
		const halfH = (Math.max(size[1], (across * h) / w) / 2) * MARGIN || 0.5;
		return { halfW: (halfH * w) / h, halfH };
	};
	const cells: MotionCell[] = [];
	const w = SHEET_WIDTH / FRAMES;
	(['right', 'front'] as const).forEach((view, row) => {
		for (let f = 0; f < FRAMES; f++) {
			cells.push({
				x: f * w,
				y: row * STRIP_HEIGHT,
				w,
				h: STRIP_HEIGHT,
				view,
				frame: f,
				...fit(view, w, STRIP_HEIGHT)
			});
		}
	});
	const ow = SHEET_WIDTH / 2;
	const oh = SHEET_HEIGHT - 2 * STRIP_HEIGHT;
	(['right', 'front'] as const).forEach((view, i) => {
		cells.push({
			x: i * ow,
			y: 2 * STRIP_HEIGHT,
			w: ow,
			h: oh,
			view,
			frame: null,
			...fit(view, ow, oh)
		});
	});
	return {
		cells,
		centre: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
		distance: Math.max(...size) * 4 + 1,
		floorY
	};
}

function camera(THREE: Three, layout: MotionLayout, cell: MotionCell) {
	const d = layout.distance;
	const cam = new THREE.OrthographicCamera(
		-cell.halfW,
		cell.halfW,
		cell.halfH,
		-cell.halfH,
		d / 100,
		d * 4
	);
	const [cx, cy, cz] = layout.centre;
	const dir = DIRS[cell.view];
	cam.position.set(cx + dir[0] * d, cy, cz + dir[2] * d);
	cam.lookAt(cx, cy, cz);
	cam.updateMatrixWorld(true);
	return cam;
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
	ctx.font = '600 13px sans-serif';
	ctx.textBaseline = 'top';
	ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
	ctx.fillRect(x + 4, y + 4, ctx.measureText(text).width + 8, 18);
	ctx.fillStyle = '#ffffff';
	ctx.fillText(text, x + 8, y + 7);
}

type Vector = InstanceType<Three['Vector3']>;

/** Trails and their legend, over an overlay cell. */
function drawTrails(
	THREE: Three,
	ctx: CanvasRenderingContext2D,
	layout: MotionLayout,
	cell: MotionCell,
	trails: { name: string; points: Vector[] }[]
) {
	const cam = camera(THREE, layout, cell);
	const toPx = (p: Vector) => {
		const v = p.clone().project(cam);
		return [cell.x + ((v.x + 1) / 2) * cell.w, cell.y + ((1 - v.y) / 2) * cell.h];
	};
	trails.forEach((trail, i) => {
		const colour = TRAIL_COLOURS[i % TRAIL_COLOURS.length];
		ctx.strokeStyle = colour;
		ctx.fillStyle = colour;
		ctx.lineWidth = 2.5;
		ctx.beginPath();
		trail.points.forEach((p, k) => {
			const [x, y] = toPx(p);
			if (k === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		});
		ctx.stroke();
		const [sx, sy] = toPx(trail.points[0]);
		ctx.beginPath();
		ctx.arc(sx, sy, 5, 0, Math.PI * 2);
		ctx.fill();
	});
	ctx.font = '600 12px sans-serif';
	ctx.textBaseline = 'top';
	trails.forEach((trail, i) => {
		const y = cell.y + cell.h - 18 * (trails.length - i) - 6;
		ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
		ctx.fillRect(cell.x + 6, y - 2, ctx.measureText(trail.name).width + 24, 17);
		ctx.fillStyle = TRAIL_COLOURS[i % TRAIL_COLOURS.length];
		ctx.fillRect(cell.x + 10, y + 3, 10, 6);
		ctx.fillStyle = '#ffffff';
		ctx.fillText(trail.name, cell.x + 24, y);
	});
}

/** Labels and cell borders. */
function annotate(ctx: CanvasRenderingContext2D, layout: MotionLayout, times: number[]) {
	ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
	ctx.lineWidth = 1;
	for (const cell of layout.cells) {
		ctx.strokeRect(cell.x, cell.y, cell.w, cell.h);
		const side = cell.view === 'right' ? 'Right' : 'Front';
		if (cell.frame === null) label(ctx, `${side}, all frames + trails`, cell.x, cell.y);
		else {
			const t = `${times[cell.frame].toFixed(2)} s`;
			label(ctx, cell.frame === 0 ? `${side} ${t}` : t, cell.x, cell.y);
		}
	}
}

type Renderer = InstanceType<Three['WebGLRenderer']>;
type Scene = InstanceType<Three['Scene']>;
type Trail = { name: string; points: Vector[] };

/** Every pose's box, and each trailed part's path, sampled over the clip. */
function samplePoses(
	THREE: Three,
	root: Object3D,
	clip: AnimationClip,
	pose: Poser,
	times: number[],
	fastest: string[]
): { box: InstanceType<Three['Box3']>; trails: Trail[] } {
	const meshes = meshesOf(root);
	const stride = strideFor(meshes);
	const box = new THREE.Box3();
	for (const t of times) {
		pose.at(t);
		box.union(posedBox(THREE, meshes, stride));
	}
	const parts = partsOf(root).filter((p) => fastest.includes(p.name));
	parts.sort((a, b) => fastest.indexOf(a.name) - fastest.indexOf(b.name));
	const trails = parts.map((part) => ({ name: part.name, points: [] as Vector[] }));
	for (const t of sampleTimes(clip.duration, TRAIL_POINTS)) {
		pose.at(t);
		parts.forEach((part, i) => trails[i].points.push(partCentre(THREE, part, stride)));
	}
	return { box, trails };
}

/** Lights and a floor grid at the rest floor, around `root`. */
function stage(THREE: Three, layout: MotionLayout, root: Object3D): Scene {
	const scene = new THREE.Scene();
	scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 2));
	const key = new THREE.DirectionalLight(0xffffff, 1.4);
	key.position.set(2, 4, 3);
	scene.add(key);
	const span = layout.distance;
	const grid = new THREE.GridHelper(span, Math.max(2, Math.round(span / 0.1)), 0x5a5a5a, 0x5a5a5a);
	grid.position.set(layout.centre[0], layout.floorY, layout.centre[2]);
	scene.add(grid, root);
	return scene;
}

/** Render every cell: one pose per strip cell, every pose ghosted in an overlay. */
function drawCells(
	THREE: Three,
	r: Renderer,
	scene: Scene,
	layout: MotionLayout,
	pose: Poser,
	times: number[],
	materials: Saved
) {
	for (const cell of layout.cells) {
		const glY = SHEET_HEIGHT - cell.y - cell.h;
		r.setViewport(cell.x, glY, cell.w, cell.h);
		r.setScissor(cell.x, glY, cell.w, cell.h);
		r.clear();
		const cam = camera(THREE, layout, cell);
		if (cell.frame !== null) {
			pose.at(times[cell.frame]);
			r.render(scene, cam);
			continue;
		}
		// Earlier frames fainter, the last one solid on top.
		times.forEach((t, f) => {
			materials.ghost(f === times.length - 1 ? null : 0.12 + (0.5 * f) / (times.length - 1));
			pose.at(t);
			r.render(scene, cam);
		});
		materials.restore();
	}
}

interface Saved {
	ghost(opacity: number | null): void;
	restore(): void;
}

/** The meshes' materials, to fade for the overlays and put back after. */
function saveMaterials(root: Object3D): Saved {
	const mats = [
		...new Set(
			meshesOf(root).flatMap((m) => (Array.isArray(m.material) ? m.material : [m.material]))
		)
	] as Material[];
	const saved = mats.map((m) => ({
		transparent: m.transparent,
		opacity: m.opacity,
		depthWrite: m.depthWrite
	}));
	return {
		ghost(opacity) {
			for (const m of mats) {
				m.transparent = opacity !== null;
				m.opacity = opacity ?? 1;
				m.depthWrite = opacity === null;
				m.needsUpdate = true;
			}
		},
		restore() {
			mats.forEach((m, i) => Object.assign(m, saved[i], { needsUpdate: true }));
		}
	};
}

/**
 * Draw `clip`'s motion sheet as a PNG data URL, or null when WebGL can't.
 * `fastest` names the parts to trail (`ClipMotion.fastest`). Leaves the
 * scene in its rest pose and its materials as they were.
 */
export function renderMotionSheet(
	THREE: Three,
	root: Object3D,
	clip: AnimationClip,
	fastest: string[]
): string | null {
	root.updateMatrixWorld(true);
	const meshes = meshesOf(root);
	const floorY = posedBox(THREE, meshes, strideFor(meshes)).min.y;
	const times = sampleTimes(clip.duration, FRAMES);
	while (times.length < FRAMES) times.push(times[times.length - 1]);
	const pose = poser(THREE, root, clip);
	const materials = saveMaterials(root);
	const parent = root.parent;
	const glCanvas = document.createElement('canvas');
	glCanvas.width = SHEET_WIDTH;
	glCanvas.height = SHEET_HEIGHT;
	let renderer: Renderer | null = null;
	try {
		const { box, trails } = samplePoses(THREE, root, clip, pose, times, fastest);
		const layout = motionSheetLayout(
			{ min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] },
			floorY
		);
		renderer = new THREE.WebGLRenderer({
			canvas: glCanvas,
			antialias: true,
			preserveDrawingBuffer: true
		});
		renderer.setSize(SHEET_WIDTH, SHEET_HEIGHT, false);
		renderer.setScissorTest(true);
		renderer.autoClear = false;
		renderer.setClearColor(0x8a8a8a);
		drawCells(THREE, renderer, stage(THREE, layout, root), layout, pose, times, materials);

		const out = document.createElement('canvas');
		out.width = SHEET_WIDTH;
		out.height = SHEET_HEIGHT;
		const ctx = out.getContext('2d');
		if (!ctx) return glCanvas.toDataURL('image/png');
		ctx.drawImage(glCanvas, 0, 0);
		annotate(ctx, layout, times);
		for (const cell of layout.cells) {
			if (cell.frame === null) drawTrails(THREE, ctx, layout, cell, trails);
		}
		return out.toDataURL('image/png');
	} catch (e) {
		console.warn('Motion sheet could not draw:', e);
		return null;
	} finally {
		materials.restore();
		pose.stop();
		if (parent) parent.add(root);
		else root.removeFromParent();
		renderer?.dispose();
	}
}
