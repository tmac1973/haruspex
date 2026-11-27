#!/usr/bin/env node
// Build static/licences/third-party.json for Settings → About → Licences:
// the name, version, licence and licence text of everything the app ships
// that someone else wrote. MIT, Apache-2.0 and BSD all ask for the notice to
// travel with the binary.
//
// - npm: the production dependencies and everything they pull in, plus the dev
//   dependencies whose runtime is bundled into the app (BUNDLED_DEV), from
//   package-lock.json.
// - crate: every crate compiled into the Tauri binary, from `cargo metadata`
//   (left out, with a warning, where cargo is not installed).
// - python: the wheels fetch-pyodide.sh vendors into static/pyodide/, read from
//   each wheel's .dist-info. plotly.min.js and BokehJS come out of the plotly and
//   bokeh wheels.
// - programs: the sidecars, listed by hand in PROGRAMS, with texts from
//   licences/ (fetched by fetch-licence-texts.sh) or from the files the bundle
//   already carries.
//
// A package that ships no licence file gets its text from licences/npm/<name>/,
// or else the standard text of its licence from licences/spdx/, with its
// authors as the copyright holder. Each licence file is stored once and
// referenced by index, since most crates carry the same Apache-2.0 text.
//
// Skipped when the output is newer than every input.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(root, 'package-lock.json');
const cargoLock = join(root, 'src-tauri/Cargo.lock');
const vendored = join(root, 'licences');
const pyodideDir = join(root, 'static/pyodide');
const outDir = join(root, 'static/licences');
const out = join(outDir, 'third-party.json');

/** Dev dependencies whose runtime code is bundled into the app. */
const BUNDLED_DEV = ['svelte', '@sveltejs/kit'];

const MEDIA = 'src-tauri/binaries/media/LICENSES';
const NODE = 'src-tauri/binaries/node-modules';
/** The programs the app runs beside itself. `files` are relative to the repo root. */
const PROGRAMS = [
	{
		name: 'llama.cpp (llama-server)',
		licence: 'MIT',
		url: 'https://github.com/ggml-org/llama.cpp',
		files: ['licences/sidecars/llama.cpp']
	},
	{
		name: 'whisper.cpp (whisper-server)',
		licence: 'MIT',
		url: 'https://github.com/ggml-org/whisper.cpp',
		files: ['licences/sidecars/whisper.cpp']
	},
	{
		name: 'Kokoros (koko), with espeak-ng',
		licence: 'Apache-2.0; espeak-ng GPL-3.0-or-later',
		url: 'https://github.com/lucasjinreal/Kokoros',
		files: ['licences/sidecars/kokoros']
	},
	{
		name: 'stable-diffusion.cpp (sd-server)',
		licence: 'MIT',
		url: 'https://github.com/leejet/stable-diffusion.cpp',
		files: ['licences/sidecars/stable-diffusion.cpp']
	},
	{
		name: 'FFmpeg (ffmpeg, ffprobe), with x264',
		licence: 'GPL-3.0-or-later',
		url: 'https://github.com/FFmpeg/FFmpeg',
		files: [
			`${MEDIA}/README`,
			...[
				'ffmpeg-LICENSE.md',
				'ffmpeg-COPYING.GPLv3',
				'x264-COPYING',
				'lame-COPYING',
				'dav1d-COPYING',
				'opus-COPYING',
				'libvpx-LICENSE',
				'libvpx-PATENTS',
				'libxml2-Copyright',
				'libva-COPYING',
				'libvpl-LICENSE'
			].map((f) => `${MEDIA}/${f}`)
		]
	},
	{
		name: 'MLT (melt), with Qt 6',
		licence: 'LGPL-2.1-or-later; Qt LGPL-3.0',
		url: 'https://github.com/mltframework/mlt',
		files: [`${MEDIA}/mlt-COPYING`, `${MEDIA}/qt`]
	},
	{
		name: 'Node.js',
		licence: 'MIT and others',
		url: 'https://github.com/nodejs/node',
		files: [`${NODE}/node-LICENSE`]
	},
	{
		name: 'npm',
		licence: 'Artistic-2.0',
		url: 'https://github.com/npm/cli',
		files: [`${NODE}/npm/LICENSE`]
	},
	{
		name: 'uv',
		licence: 'MIT or Apache-2.0',
		url: 'https://github.com/astral-sh/uv',
		files: ['licences/sidecars/uv']
	},
	{
		name: 'Ruff',
		licence: 'MIT',
		url: 'https://github.com/astral-sh/ruff',
		files: ['licences/sidecars/ruff']
	},
	{
		name: 'PDFium',
		licence: 'BSD-3-Clause and others',
		url: 'https://pdfium.googlesource.com/pdfium',
		files: ['licences/sidecars/pdfium']
	},
	{
		name: 'Pyodide, with CPython',
		licence: 'MPL-2.0; CPython PSF-2.0',
		url: 'https://github.com/pyodide/pyodide',
		files: ['licences/npm/pyodide/LICENSE', 'licences/sidecars/pyodide/CPython-LICENSE']
	}
];

const LICENCE_FILE = /^(licen[cs]e|copying|copyright|notice)(\.|-|_|$)/i;

/** Every file under `path`, sorted; [path] when it is a file; [] when it is missing. */
function filesUnder(path) {
	if (!existsSync(path)) return [];
	if (!statSync(path).isDirectory()) return [path];
	return readdirSync(path)
		.sort()
		.flatMap((f) => filesUnder(join(path, f)));
}

const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);
const wheels = () =>
	[pyodideDir, join(pyodideDir, 'wheels')].flatMap((d) =>
		existsSync(d)
			? readdirSync(d)
					.filter((f) => f.endsWith('.whl'))
					.sort()
					.map((f) => join(d, f))
			: []
	);
const self = fileURLToPath(import.meta.url);
const inputs = [
	lockPath,
	cargoLock,
	self,
	...filesUnder(vendored),
	...wheels(),
	...filesUnder(join(root, MEDIA)),
	join(root, NODE, 'node-LICENSE')
];
if (existsSync(out) && inputs.every((p) => mtime(p) < mtime(out))) process.exit(0);

// One copy of each licence file; entries hold the indexes of theirs.
const texts = [];
const textIds = new Map();
function textIdsOf(parts) {
	return [...new Set(parts.map((t) => t.trim()).filter(Boolean))].map((t) => {
		if (!textIds.has(t)) {
			textIds.set(t, texts.length);
			texts.push(t);
		}
		return textIds.get(t);
	});
}
const readAll = (paths) => paths.map((p) => readFileSync(p, 'utf8'));

/** The standard text of the licences in `expr` that licences/spdx/ has, for `holder`. */
function standardText(expr, holder) {
	const ids = String(expr ?? '').match(/[A-Za-z0-9.+-]+/g) ?? [];
	const known = ids.filter(
		(id) => !['AND', 'OR', 'WITH'].includes(id) && existsSync(join(vendored, 'spdx', `${id}.txt`))
	);
	// Under OR any one licence will do; under AND each applies.
	const chosen = /\bAND\b/.test(expr) ? [...new Set(known)] : known.slice(0, 1);
	return chosen.map((id) =>
		readFileSync(join(vendored, 'spdx', `${id}.txt`), 'utf8').replace('{holder}', holder)
	);
}
const holderOf = (authors, name) =>
	(authors.length ? authors.join(', ') : `the ${name} authors`).replace(/\s*<[^>]*>/g, '');

const packages = [];
const missing = [];
function add(source, name, version, licence, url, parts) {
	const text = textIdsOf(parts);
	if (!text.length) missing.push(`${source} ${name}`);
	packages.push({ source, name, version, licence, url, text });
}

// --- npm ---
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

for (const key of [...shipped].sort()) {
	const dir = dirOf(key);
	const e = lock[key];
	const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
	const meta = dir ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) : {};
	const licence = e.license ?? meta.license ?? 'see text';
	const own = dir ? readdirSync(dir).filter((f) => LICENCE_FILE.test(f)) : [];
	let text = readAll(own.sort().map((f) => join(dir, f)));
	if (!text.length) text = readAll(filesUnder(join(vendored, 'npm', name)));
	if (!text.length) {
		const a = typeof meta.author === 'string' ? meta.author : meta.author?.name;
		text = standardText(licence, holderOf(a ? [a] : [], name));
	}
	const repo = typeof meta.repository === 'string' ? meta.repository : meta.repository?.url;
	const url = meta.homepage ?? repo?.replace(/^git\+/, '').replace(/\.git$/, '') ?? '';
	add('npm', name, e.version ?? meta.version ?? '', licence, url, text);
}

// --- crates ---
function cargoMetadata() {
	const args = ['metadata', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml'];
	// Tauri sets the target for a build; otherwise the host's.
	let triple = process.env.TAURI_ENV_TARGET_TRIPLE;
	try {
		triple ??= /host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1];
		if (triple) args.push('--filter-platform', triple);
		return JSON.parse(
			execFileSync('cargo', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
		);
	} catch (err) {
		console.warn(`licences: no Rust crates listed (cargo metadata failed: ${err.message})`);
		return null;
	}
}

const meta = cargoMetadata();
if (meta) {
	const byId = new Map(meta.packages.map((p) => [p.id, p]));
	const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
	const crates = new Set();
	// Normal dependencies only: build scripts, dev dependencies and proc macros
	// run on the build machine and never reach the binary.
	const walkCrate = (id) => {
		const p = byId.get(id);
		if (crates.has(id) || p.targets.every((t) => t.kind.includes('proc-macro'))) return;
		crates.add(id);
		for (const d of nodes.get(id).deps)
			if (d.dep_kinds.some((k) => k.kind === null)) walkCrate(d.pkg);
	};
	walkCrate(meta.resolve.root);
	const list = [...crates]
		.map((id) => byId.get(id))
		.filter((p) => p.source) // path crates are this repo's own
		.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
	for (const p of list) {
		const dir = dirname(p.manifest_path);
		const own = readdirSync(dir).filter((f) => LICENCE_FILE.test(f));
		if (p.license_file) own.push(p.license_file);
		const files = [...new Set(own)].sort().map((f) => join(dir, f));
		let text = readAll(files.filter((f) => existsSync(f) && statSync(f).isFile()));
		if (!text.length) text = standardText(p.license, holderOf(p.authors ?? [], p.name));
		const url = p.repository ?? p.homepage ?? `https://crates.io/crates/${p.name}`;
		add('crate', p.name, p.version, p.license ?? 'see text', url, text);
	}
}

// --- python ---
const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const seenWheels = new Set();
for (const path of wheels()) {
	const zip = await JSZip.loadAsync(readFileSync(path));
	const names = Object.keys(zip.files);
	const info = names.find((n) => /^[^/]+\.dist-info\/METADATA$/.test(n));
	if (!info) continue;
	const distInfo = info.slice(0, -'METADATA'.length);
	const md = await zip.file(info).async('string');
	const header = md.split(/\r?\n\r?\n/)[0];
	const field = (k) => new RegExp(`^${k}: (.*)$`, 'mi').exec(header)?.[1]?.trim();
	const name = field('Name') ?? path;
	const version = field('Version') ?? '';
	if (seenWheels.has(`${name}@${version}`)) continue;
	seenWheels.add(`${name}@${version}`);
	// A one-line License field, not the first line of a pasted licence text.
	const short = field('License');
	const plain =
		short && short.length <= 40 && /^[\w .,+()/-]+$/.test(short) && !/copyright/i.test(short);
	const classifier = [...header.matchAll(/^Classifier: License :: (?:OSI Approved :: )?(.*)$/gm)]
		.map((m) => m[1])
		.join(', ');
	const licence =
		field('License-Expression') ?? (plain ? short : null) ?? (classifier || 'see text');
	const files = names
		.filter((n) => n.startsWith(distInfo) && !n.endsWith('/'))
		.filter((n) => {
			const rest = n.slice(distInfo.length);
			return rest.startsWith('licenses/') || LICENCE_FILE.test(rest) || rest === 'AUTHORS';
		})
		.sort();
	const parts = [];
	for (const f of files) parts.push(await zip.file(f).async('string'));
	const url =
		field('Home-page') ??
		/^Project-URL: [^,]*,\s*(.*)$/m.exec(header)?.[1] ??
		`https://pypi.org/project/${name}/`;
	add('python', name, version, licence, url, parts);
}

// --- programs ---
const sidecars = PROGRAMS.map(({ files, ...p }) => {
	const paths = files.flatMap((f) => filesUnder(join(root, f)));
	if (!paths.length) missing.push(`program ${p.name}`);
	return { ...p, text: textIdsOf(readAll(paths)) };
});

if (missing.length) console.warn(`licences: no licence text for ${missing.join(', ')}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(out, JSON.stringify({ texts, packages, sidecars }));
const count = (s) => packages.filter((p) => p.source === s).length;
console.warn(
	`licences: wrote ${count('npm')} npm packages, ${count('crate')} crates, ` +
		`${count('python')} Python packages and ${sidecars.length} programs to ${out}`
);
