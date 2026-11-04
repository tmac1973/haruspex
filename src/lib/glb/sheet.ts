/**
 * One image a model can judge a 3D asset by: six views (front, right, back,
 * left, top, three-quarter) over a floor grid, with the asset's height marked
 * in the front view. `sheetLayout` is the pure framing; `renderSheet` draws it.
 * A close-up frames one part the same way, and draws only what is near it.
 */
import type { Mesh, Object3D } from 'three';
import type { Three } from '#lib/glb/load.ts';
import type { Bounds, Vec3 } from '#lib/glb/report.ts';

export const CELL = 400;
export const COLUMNS = 3;
export const ROWS = 2;
export const SHEET_WIDTH = CELL * COLUMNS;
export const SHEET_HEIGHT = CELL * ROWS;
/** Space around the framed box, as a share of it. */
const MARGIN = 0.1;
/** The three-quarter camera's direction from the centre (the old single preview's). */
export const THREE_QUARTER: Vec3 = [1.2, 0.8, 1.6];

export interface SheetCell {
	label: string;
	/** Top-left corner, in sheet pixels. */
	x: number;
	y: number;
	/** Unit vector from the centre to the camera. */
	dir: Vec3;
	up: Vec3;
	/** Orthographic half-extent, or null for the perspective three-quarter view. */
	half: number | null;
}

export interface SheetLayout {
	cells: SheetCell[];
	/** What the cameras look at. */
	centre: Vec3;
	/** Camera distance from the centre. */
	distance: number;
	/** The floor grid: its edge length and line spacings, in metres. */
	grid: { size: number; major: number; minor: number | null; centre: [number, number] };
}

const VIEWS: { label: string; dir: Vec3; up: Vec3; across: [number, number] }[] = [
	{ label: 'front', dir: [0, 0, 1], up: [0, 1, 0], across: [0, 1] },
	{ label: 'right', dir: [1, 0, 0], up: [0, 1, 0], across: [2, 1] },
	{ label: 'back', dir: [0, 0, -1], up: [0, 1, 0], across: [0, 1] },
	{ label: 'left', dir: [-1, 0, 0], up: [0, 1, 0], across: [2, 1] },
	{ label: 'top', dir: [0, 1, 0], up: [0, 0, -1], across: [0, 2] }
];

function normalise(v: Vec3): Vec3 {
	const l = Math.hypot(...v) || 1;
	return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * The box the views frame: the asset's bounds, stretched down to the floor
 * when the asset floats near it, so a gap under the feet shows.
 */
export function framedBounds(b: Bounds): { min: Vec3; max: Vec3 } {
	const min: Vec3 = [...b.min];
	const max: Vec3 = [...b.max];
	const height = b.size[1];
	if (min[1] > 0 && min[1] <= 2 * height) min[1] = 0;
	if (max[1] < 0 && -max[1] <= 2 * height) max[1] = 0;
	return { min, max };
}

/** The six cells' framing for an asset with these bounds. */
export function sheetLayout(b: Bounds): SheetLayout {
	const { min, max } = framedBounds(b);
	const ext: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
	const dim = Math.max(...ext) || 1;
	const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
	const cells: SheetCell[] = VIEWS.map((v, i) => ({
		label: v.label,
		x: (i % COLUMNS) * CELL,
		y: Math.floor(i / COLUMNS) * CELL,
		dir: v.dir,
		up: v.up,
		half: (Math.max(ext[v.across[0]], ext[v.across[1]], dim * 0.05) / 2) * (1 + MARGIN * 2)
	}));
	cells.push({
		label: 'three-quarter',
		x: 2 * CELL,
		y: CELL,
		dir: normalise(THREE_QUARTER),
		up: [0, 1, 0],
		half: null
	});
	const footprint = Math.max(ext[0], ext[2], 1);
	return {
		cells,
		centre,
		distance: dim * 3,
		grid: {
			size: Math.ceil(footprint * 1.5) + 1,
			major: 1,
			minor: b.size[1] < 1 ? 0.1 : null,
			centre: [centre[0], centre[2]]
		}
	};
}

function addGrid(THREE: Three, scene: InstanceType<Three['Scene']>, layout: SheetLayout) {
	const { size, minor, centre } = layout.grid;
	const major = new THREE.GridHelper(size, size, 0x3c3c3c, 0x3c3c3c);
	major.position.set(centre[0], 0, centre[1]);
	scene.add(major);
	if (minor) {
		const n = Math.round(size / minor);
		const fine = new THREE.GridHelper(size, n, 0x6a6a6a, 0x6a6a6a);
		fine.position.set(centre[0], -0.0005, centre[1]);
		scene.add(fine);
	}
}

function camera(THREE: Three, layout: SheetLayout, cell: SheetCell) {
	const d = layout.distance;
	const cam =
		cell.half === null
			? new THREE.PerspectiveCamera(35, 1, d / 100, d * 10)
			: new THREE.OrthographicCamera(-cell.half, cell.half, cell.half, -cell.half, d / 100, d * 10);
	const [cx, cy, cz] = layout.centre;
	const k = cell.half === null ? d * 0.75 : d;
	cam.position.set(cx + cell.dir[0] * k, cy + cell.dir[1] * k, cz + cell.dir[2] * k);
	cam.up.set(...cell.up);
	cam.lookAt(cx, cy, cz);
	cam.updateMatrixWorld(true);
	return cam;
}

/** Labels, and the height ruler in the front cell. */
function annotate(THREE: Three, ctx: CanvasRenderingContext2D, layout: SheetLayout, b: Bounds) {
	ctx.font = '600 15px sans-serif';
	ctx.textBaseline = 'top';
	for (const cell of layout.cells) {
		ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
		ctx.fillRect(cell.x + 8, cell.y + 8, ctx.measureText(cell.label).width + 12, 22);
		ctx.fillStyle = '#ffffff';
		ctx.fillText(cell.label, cell.x + 14, cell.y + 12);
	}
	ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
	for (let i = 1; i < COLUMNS; i++) ctx.strokeRect(i * CELL, 0, 0, SHEET_HEIGHT);
	ctx.strokeRect(0, CELL, SHEET_WIDTH, 0);

	const front = layout.cells[0];
	const cam = camera(THREE, layout, front);
	const toPx = (p: Vec3) => {
		const v = new THREE.Vector3(...p).project(cam);
		return [front.x + ((v.x + 1) / 2) * CELL, front.y + ((1 - v.y) / 2) * CELL];
	};
	const right = b.max[0];
	const [x, yBottom] = toPx([right, b.min[1], b.max[2]]);
	const [, yTop] = toPx([right, b.max[1], b.max[2]]);
	const rx = Math.min(x + 14, front.x + CELL - 70);
	ctx.strokeStyle = '#ffd34d';
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.moveTo(rx, yBottom);
	ctx.lineTo(rx, yTop);
	ctx.moveTo(rx - 5, yBottom);
	ctx.lineTo(rx + 5, yBottom);
	ctx.moveTo(rx - 5, yTop);
	ctx.lineTo(rx + 5, yTop);
	ctx.stroke();
	ctx.fillStyle = '#ffd34d';
	ctx.textBaseline = 'middle';
	ctx.fillText(`${b.size[1].toFixed(2)} m`, rx + 8, (yBottom + yTop) / 2);
}

/** Names that stand for the head when no node is called `head`. */
const HEAD = /head|helmet|skull|helm\b|face/i;
/** A close-up also draws what lies within this share of the part's size around it. */
const NEARBY = 0.5;

const boundsOf = (box: { min: { x: number; y: number; z: number }; max: typeof box.min }) => {
	const min: Vec3 = [box.min.x, box.min.y, box.min.z];
	const max: Vec3 = [box.max.x, box.max.y, box.max.z];
	return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] as Vec3 };
};

/**
 * What a close-up of `view` frames: the node of that name (or for "head", the
 * first node named like one, else the top quarter of the asset), or why there
 * is none.
 */
export function closeUpBounds(
	THREE: Three,
	root: Object3D,
	view: string,
	whole: Bounds
): { bounds: Bounds; label: string } | { error: string } {
	root.updateMatrixWorld(true);
	let node =
		root.getObjectByName(view) ??
		root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(view));
	if (!node && /^head$/i.test(view)) {
		root.traverse((o) => {
			if (!node && o !== root && HEAD.test(o.name)) node = o;
		});
		if (!node) {
			const min: Vec3 = [whole.min[0], whole.max[1] - whole.size[1] / 4, whole.min[2]];
			const box = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...whole.max));
			return { bounds: boundsOf(box), label: 'the top quarter' };
		}
	}
	if (!node) return { error: `No node named ${view}: pass a mesh or pivot name, or "head".` };
	const box = new THREE.Box3().setFromObject(node);
	if (box.isEmpty()) return { error: `${view} has no meshes under it to show.` };
	return { bounds: boundsOf(box), label: node.name };
}

/**
 * Hide the meshes that lie away from `b` (by more than `NEARBY` of its size),
 * so they don't block a close-up; returns a function that shows them again.
 */
function hideAwayFrom(THREE: Three, root: Object3D, b: Bounds): () => void {
	const pad = Math.max(...b.size) * NEARBY;
	const near = new THREE.Box3(
		new THREE.Vector3(...b.min),
		new THREE.Vector3(...b.max)
	).expandByScalar(pad);
	const hidden: Mesh[] = [];
	root.traverse((o) => {
		const m = o as Mesh;
		if (!m.isMesh || !m.visible) return;
		if (!near.intersectsBox(new THREE.Box3().setFromObject(m))) {
			m.visible = false;
			hidden.push(m);
		}
	});
	return () => hidden.forEach((m) => (m.visible = true));
}

/**
 * Draw the sheet as a PNG data URL, or null when WebGL can't. With `closeUp`,
 * `b` is one part's bounds and only what lies near it is drawn.
 */
export function renderSheet(
	THREE: Three,
	root: Object3D,
	b: Bounds,
	closeUp = false
): string | null {
	const layout = sheetLayout(b);
	const show = closeUp ? hideAwayFrom(THREE, root, b) : () => {};
	const glCanvas = document.createElement('canvas');
	glCanvas.width = SHEET_WIDTH;
	glCanvas.height = SHEET_HEIGHT;
	let renderer: InstanceType<Three['WebGLRenderer']> | null = null;
	try {
		renderer = new THREE.WebGLRenderer({
			canvas: glCanvas,
			antialias: true,
			preserveDrawingBuffer: true
		});
		renderer.setSize(SHEET_WIDTH, SHEET_HEIGHT, false);
		renderer.setScissorTest(true);
		const scene = new THREE.Scene();
		scene.background = new THREE.Color(0x8a8a8a);
		scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 2));
		const key = new THREE.DirectionalLight(0xffffff, 1.6);
		scene.add(key);
		addGrid(THREE, scene, layout);
		const parent = root.parent;
		scene.add(root);
		for (const cell of layout.cells) {
			const cam = camera(THREE, layout, cell);
			key.position.copy(cam.position).add(new THREE.Vector3(0, layout.distance, 0));
			const glY = SHEET_HEIGHT - cell.y - CELL;
			renderer.setViewport(cell.x, glY, CELL, CELL);
			renderer.setScissor(cell.x, glY, CELL, CELL);
			renderer.render(scene, cam);
		}
		scene.remove(root);
		parent?.add(root);

		const out = document.createElement('canvas');
		out.width = SHEET_WIDTH;
		out.height = SHEET_HEIGHT;
		const ctx = out.getContext('2d');
		if (!ctx) return glCanvas.toDataURL('image/png');
		ctx.drawImage(glCanvas, 0, 0);
		annotate(THREE, ctx, layout, b);
		return out.toDataURL('image/png');
	} catch (e) {
		console.warn('GLB render sheet could not draw:', e);
		return null;
	} finally {
		show();
		renderer?.dispose();
	}
}
