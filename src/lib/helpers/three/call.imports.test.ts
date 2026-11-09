import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The 3D core (`glb/` and `helpers/three/`) is headed for a package of its
 * own that `check_3d` hosts outside the app use too (#1063), so it may import
 * only itself, three, the glTF validator and a few import-free utils. The
 * app's side stays out: Tauri, the agent, the sandbox frame, the jobs.
 */
const ROOT = join(__dirname, '..', '..');
const CORE_DIRS = ['glb', 'helpers/three'];
/** Files in those folders that are the app's, not the core's. */
const APP_FILES = new Set(['helpers/three/helper.ts']);
const UTILS = ['utils/base64.ts', 'utils/error.ts', 'utils/shellPath.ts'];
const PACKAGES = [/^three$/, /^three\/examples\/jsm\//, /^gltf-validator$/];

const SPECIFIER = /(?:from\s*|import\s*\(\s*)'([^']+)'/g;

function specifiers(rel: string): string[] {
	const text = readFileSync(join(ROOT, rel), 'utf8');
	return [...text.matchAll(SPECIFIER)].map((m) => m[1]);
}

function coreFiles(): string[] {
	return CORE_DIRS.flatMap((dir) =>
		readdirSync(join(ROOT, dir))
			.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
			.map((f) => `${dir}/${f}`)
	).filter((f) => !APP_FILES.has(f));
}

function allowed(spec: string, core: Set<string>): boolean {
	if (PACKAGES.some((p) => p.test(spec))) return true;
	if (!spec.startsWith('#lib/')) return false;
	const rel = spec.slice('#lib/'.length);
	return core.has(rel) || UTILS.includes(rel);
}

describe('the 3D core', () => {
	it('imports nothing from the app', () => {
		const files = coreFiles();
		const core = new Set(files);
		const bad = files.flatMap((f) =>
			specifiers(f)
				.filter((s) => !allowed(s, core))
				.map((s) => `${f} → ${s}`)
		);
		expect(bad).toEqual([]);
	});

	it('uses only utils that import nothing', () => {
		expect(UTILS.flatMap((f) => specifiers(f).map((s) => `${f} → ${s}`))).toEqual([]);
	});
});
