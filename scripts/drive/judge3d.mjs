#!/usr/bin/env node
/**
 * Render GLBs side by side for judging what an agent made: one row per GLB,
 * four views each (front, three-quarter, side, back) in the same lit scene,
 * written to one PNG. Uses Playwright's Chromium and the repo's own three.
 *
 *   node scripts/drive/judge3d.mjs out.png a.glb [b.glb …]
 *
 * It prints each row's label (the GLB's parent folder and name), top to bottom.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import http from 'node:http';
import { basename, dirname, join } from 'node:path';
import { chromium } from 'playwright';

// three/build/three.cjs → the package folder, wherever node_modules is.
const THREE_DIR = dirname(dirname(createRequire(import.meta.url).resolve('three')));
const CELL = 320;

const [out, ...glbs] = process.argv.slice(2);
if (!out || !glbs.length) {
	console.error('Usage: node scripts/drive/judge3d.mjs out.png a.glb [b.glb …]');
	process.exit(2);
}
const labels = glbs.map((g) => `${basename(dirname(dirname(g)))}/${basename(g)}`);

const page = `<!doctype html><html><body style="margin:0;background:#2a2a2e">
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
const count = ${glbs.length}, W = ${CELL}, H = ${CELL};
const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
r.setSize(W * 4, H * count);
r.setScissorTest(true);
document.body.appendChild(r.domElement);
const env = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture;
const angles = [0, Math.PI / 4, Math.PI / 2, Math.PI];
for (let i = 0; i < count; i++) {
	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x2a2a2e);
	scene.environment = env;
	const sun = new THREE.DirectionalLight(0xffffff, 1.5);
	sun.position.set(2, 4, 3);
	scene.add(sun);
	const gltf = await new GLTFLoader().loadAsync('/glb/' + i);
	scene.add(gltf.scene);
	const box = new THREE.Box3().setFromObject(gltf.scene);
	const c = box.getCenter(new THREE.Vector3());
	const s = box.getSize(new THREE.Vector3());
	const d = Math.max(s.x, s.y, s.z) * 1.9;
	const cam = new THREE.PerspectiveCamera(35, 1, d / 100, d * 10);
	angles.forEach((a, j) => {
		cam.position.set(c.x + Math.sin(a) * d, c.y + d * 0.25, c.z + Math.cos(a) * d);
		cam.lookAt(c);
		const y = (count - 1 - i) * H;
		r.setViewport(j * W, y, W, H);
		r.setScissor(j * W, y, W, H);
		r.render(scene, cam);
	});
}
window.done = true;
</script></body></html>`;

const server = http
	.createServer((req, res) => {
		if (req.url === '/') return res.end(page);
		if (req.url.startsWith('/glb/')) return res.end(readFileSync(glbs[Number(req.url.slice(5))]));
		if (req.url.startsWith('/three/')) {
			res.setHeader('content-type', 'text/javascript');
			return res.end(readFileSync(join(THREE_DIR, req.url.slice('/three/'.length))));
		}
		res.statusCode = 404;
		res.end();
	})
	.listen(0);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader'] });
try {
	const tab = await browser.newPage({ viewport: { width: CELL * 4, height: CELL * glbs.length } });
	tab.on('pageerror', (e) => console.error('page error:', e.message));
	await tab.goto(`http://localhost:${server.address().port}/`);
	await tab.waitForFunction('window.done', null, { timeout: 120_000 });
	await tab.screenshot({ path: out });
	console.warn(labels.map((l, i) => `${i + 1}. ${l}`).join('\n'));
} finally {
	await browser.close();
	server.close();
}
