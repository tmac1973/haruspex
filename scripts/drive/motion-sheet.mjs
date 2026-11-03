#!/usr/bin/env node
/**
 * Judge an agent's animation clips the way `check_3d` shows them, outside the
 * app, in Playwright's Chromium:
 *
 *   node scripts/drive/motion-sheet.mjs out.png file.glb Clip
 *     draws the clip's motion sheet and prints the clip checks and detail;
 *   node scripts/drive/motion-sheet.mjs --build module.js out.glb
 *     runs a build module with the bundled kit and writes its GLB.
 *
 * The first bundles `motion-sheet-entry.ts` (the app's own src/lib/glb code)
 * with esbuild; the second needs the kit, built by `npm run build:three-kit`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const KIT = join(ROOT, 'static/helpers/three-kit.js');
const usage = () => {
	console.error(
		'Usage: node scripts/drive/motion-sheet.mjs out.png file.glb Clip\n' +
			'       node scripts/drive/motion-sheet.mjs --build module.js out.glb'
	);
	process.exit(2);
};

async function withPage(fn) {
	const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader'] });
	try {
		const page = await browser.newPage();
		page.on('pageerror', (e) => console.error('page error:', e.message));
		await page.setContent('<!doctype html><html><body></body></html>');
		return await fn(page);
	} finally {
		await browser.close();
	}
}

async function buildModule(source, out) {
	if (!existsSync(KIT)) throw new Error('No kit: run npm run build:three-kit first.');
	const bytes = await withPage(async (page) => {
		await page.addScriptTag({ path: KIT });
		return page.evaluate(
			async (code) => {
				const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
				const mod = await import(url);
				const { THREE, GLTFExporter, kit } = window.HaruspexThreeKit;
				const made = await (typeof mod.default === 'function' ? mod.default : mod.build)(
					THREE,
					kit
				);
				const object = made.isObject3D ? made : made.object;
				const animations = made.isObject3D ? [] : made.animations || [];
				const glb = await new GLTFExporter().parseAsync(object, { binary: true, animations });
				return [...new Uint8Array(glb)];
			},
			readFileSync(source, 'utf8')
		);
	});
	writeFileSync(out, Buffer.from(bytes));
	console.warn(`Wrote ${out}.`);
}

async function drawSheet(out, glb, clip) {
	const bundle = await build({
		entryPoints: [join(ROOT, 'scripts/drive/motion-sheet-entry.ts')],
		absWorkingDir: ROOT,
		bundle: true,
		format: 'iife',
		write: false,
		logLevel: 'error'
	});
	const result = await withPage(async (page) => {
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		return page.evaluate(([b, c]) => window.motionSheet(b, c), [[...readFileSync(glb)], clip]);
	});
	if (result.error) throw new Error(result.error);
	console.warn(result.text);
	if (result.png) writeFileSync(out, Buffer.from(result.png.split(',')[1], 'base64'));
	else console.error('The sheet did not draw (no WebGL).');
}

const args = process.argv.slice(2);
if (args[0] === '--build') {
	if (args.length !== 3) usage();
	await buildModule(args[1], args[2]);
} else {
	if (args.length !== 3) usage();
	await drawSheet(args[0], args[1], args[2]);
}
