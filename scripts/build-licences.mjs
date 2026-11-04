#!/usr/bin/env node
// Build static/licences/third-party.json: the name, version, licence and
// licence text of every npm package the app ships, for Settings → About →
// Licences. MIT, Apache-2.0 and BSD all ask for the notice to travel with
// the binary. "Ships" is the production dependencies and everything they
// pull in, plus the dev dependencies whose runtime is bundled into the app
// (BUNDLED_DEV), from package-lock.json. The sidecar programs are listed by
// hand in SIDECARS. Skipped when the output is newer than the lock file and
// this script.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(root, 'package-lock.json');
const outDir = join(root, 'static/licences');
const out = join(outDir, 'third-party.json');

/** Dev dependencies whose runtime code is bundled into the app. */
const BUNDLED_DEV = ['svelte', '@sveltejs/kit'];

/** The programs the app runs beside itself, which carry their own licences. */
const SIDECARS = [
	{
		name: 'llama.cpp (llama-server)',
		licence: 'MIT',
		url: 'https://github.com/ggml-org/llama.cpp'
	},
	{
		name: 'whisper.cpp (whisper-server)',
		licence: 'MIT',
		url: 'https://github.com/ggml-org/whisper.cpp'
	},
	{ name: 'Kokoros (koko)', licence: 'Apache-2.0', url: 'https://github.com/lucasjinreal/Kokoros' },
	{
		name: 'stable-diffusion.cpp (sd-server)',
		licence: 'MIT',
		url: 'https://github.com/leejet/stable-diffusion.cpp'
	},
	{
		name: 'Node.js',
		licence: 'MIT and others',
		url: 'https://github.com/nodejs/node/blob/main/LICENSE'
	},
	{ name: 'uv', licence: 'MIT or Apache-2.0', url: 'https://github.com/astral-sh/uv' }
];

const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);
const self = fileURLToPath(import.meta.url);
if (existsSync(out) && [lockPath, self].every((p) => mtime(p) < mtime(out))) process.exit(0);

const lock = JSON.parse(readFileSync(lockPath, 'utf8')).packages;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** The lock entry a package at `from` gets for `name`: nearest node_modules up the tree. */
function resolve(from, name) {
	for (let at = from; ; at = at.slice(0, at.lastIndexOf('/node_modules/'))) {
		const key = `${at ? `${at}/` : ''}node_modules/${name}`;
		if (lock[key]) return key;
		if (!at.includes('/node_modules/')) {
			return lock[`node_modules/${name}`] ? `node_modules/${name}` : null;
		}
	}
}

const shipped = new Set();
const walk = (key) => {
	if (!key || shipped.has(key) || key.includes('node_modules/@types/')) return;
	shipped.add(key);
	// Optional dependencies are platform builds for Node (pdfjs's canvas), never bundled.
	for (const name of Object.keys(lock[key].dependencies ?? {})) walk(resolve(key, name));
};
for (const name of [...Object.keys(pkg.dependencies ?? {}), ...BUNDLED_DEV])
	walk(resolve('', name));

/** Where an installed package is: here, or in a checkout above (a worktree shares its parent's). */
function dirOf(key) {
	for (let dir = root; ; dir = dirname(dir)) {
		if (existsSync(join(dir, key, 'package.json'))) return join(dir, key);
		if (dirname(dir) === dir) return null;
	}
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;
const packages = [];
for (const key of [...shipped].sort()) {
	const dir = dirOf(key);
	const e = lock[key];
	const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
	const meta = dir ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) : {};
	const licence = e.license ?? meta.license ?? 'unknown';
	const files = dir
		? readdirSync(dir)
				.filter((f) => LICENCE_FILE.test(f))
				.sort()
		: [];
	const text = files.map((f) => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n');
	const repo = typeof meta.repository === 'string' ? meta.repository : meta.repository?.url;
	const url = meta.homepage ?? repo?.replace(/^git\+/, '').replace(/\.git$/, '') ?? '';
	packages.push({ name, version: e.version ?? meta.version ?? '', licence, url, text });
}

const missing = packages.filter((p) => !p.text).map((p) => p.name);
if (missing.length) console.warn(`licences: no licence file in ${missing.join(', ')}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(out, JSON.stringify({ packages, sidecars: SIDECARS }));
console.warn(`licences: wrote ${packages.length} packages to ${out}`);
