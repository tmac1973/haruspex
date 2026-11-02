#!/usr/bin/env node
// Build static/helpers/three-kit.js: three, GLTFExporter and the modelling
// kit as one classic (IIFE) script, for build modules run by check_3d in the
// sandboxed artifact page (src/lib/helpers/three/kitEntry.ts). Skipped when
// the output is newer than three and the kit's sources.
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'src/lib/helpers/three/kitEntry.ts');
const outDir = join(root, 'static/helpers');
const out = join(outDir, 'three-kit.js');
const inputs = [
	entry,
	join(root, 'src/lib/helpers/three/noise.ts'),
	join(root, 'node_modules/three/package.json'),
	fileURLToPath(import.meta.url)
];

const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);
if (existsSync(out) && inputs.every((p) => mtime(p) < mtime(out))) process.exit(0);

await build({
	configFile: false,
	logLevel: 'warn',
	resolve: { alias: { '#lib': join(root, 'src/lib') } },
	build: {
		lib: {
			entry,
			formats: ['iife'],
			name: 'HaruspexThreeKitBundle',
			fileName: () => 'three-kit.js'
		},
		outDir,
		emptyOutDir: false,
		minify: true,
		copyPublicDir: false
	}
});
console.warn(`three-kit: wrote ${out}`);
