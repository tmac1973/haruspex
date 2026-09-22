import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSettings, updateSettings } from '$lib/stores/settings';
import { registerImageBackend } from './registry';
import { generateOneImage, DEFAULT_EDGE } from './generateOne';
import { ImageBackendError, type ImageRequest } from './types';
import type { ImageBackend } from './backend';

/**
 * `src/lib/image/generateOne.ts` and its imports, without a bundler. Only the
 * two import shapes this tree uses need resolving: `$lib/...` and relative.
 */
const nodeFs = 'node:fs';
const { readFileSync, existsSync } = (await import(nodeFs)) as {
	readFileSync: (path: string, encoding: string) => string;
	existsSync: (path: string) => boolean;
};

function resolveSpecifier(importPath: string, from: string): string | null {
	let base: string;
	if (importPath.startsWith('$lib/')) {
		base = `src/lib/${importPath.slice(5)}`;
	} else if (importPath.startsWith('.')) {
		const dir = from.split('/').slice(0, -1);
		for (const part of importPath.split('/')) {
			if (part === '.') continue;
			else if (part === '..') dir.pop();
			else dir.push(part);
		}
		base = dir.join('/');
	} else {
		return null; // A package; not ours to police.
	}
	for (const cand of [`${base}.ts`, `${base}.svelte`, `${base}/index.ts`, base]) {
		if (existsSync(cand)) return cand;
	}
	return null;
}

const saved = getSettings().imageBackendKind;
const seen: ImageRequest[] = [];
let fail: ImageBackendError | null = null;

const stub: ImageBackend = {
	kind: 'comfyui',
	capabilities: async () => ({
		referenceConditioning: true,
		seamlessTiling: true,
		loras: true,
		maxLoras: 2
	}),
	probe: async () => ({ ok: true, detail: 'stub' }),
	generate: async (req) => {
		seen.push(req);
		if (fail) throw fail;
		return {
			images: [{ bytes: new Uint8Array([1]), mimeType: 'image/png', width: 512, height: 512 }],
			meta: {
				seed: 1,
				model: 'm',
				backend: 'comfyui',
				sampler: { name: 's', steps: 1, cfg: 1 },
				loras: [],
				durationMs: 1
			}
		};
	}
};

beforeEach(() => {
	seen.length = 0;
	fail = null;
	registerImageBackend(stub);
	updateSettings({ imageBackendKind: 'comfyui' });
});
afterEach(() => updateSettings({ imageBackendKind: saved }));

describe('generateOneImage', () => {
	it('calls the configured backend once with the prompt', async () => {
		await generateOneImage({ prompt: 'a red apple' });
		expect(seen).toHaveLength(1);
		expect(seen[0].prompt).toBe('a red apple');
	});

	it('defaults to a square every catalogue model can produce', async () => {
		await generateOneImage({ prompt: 'x' });
		expect(seen[0].width).toBe(DEFAULT_EDGE);
		expect(seen[0].height).toBe(DEFAULT_EDGE);
	});

	it('leaves the seed null so two presses differ', async () => {
		// A fixed seed would make the Test generation button look broken.
		await generateOneImage({ prompt: 'x' });
		expect(seen[0].seed).toBeNull();
	});

	it('adds nothing the caller did not ask for', async () => {
		// The layer above adds palettes and style references. A chat turn
		// asking for a picture of a cat must not come back quantized to
		// somebody's tileset.
		await generateOneImage({ prompt: 'a cat' });
		expect(seen[0].referenceImage).toBeUndefined();
		expect(seen[0].referenceStrength).toBeUndefined();
		expect(seen[0].loras).toBeUndefined();
		expect(seen[0].seamless).toBeUndefined();
	});

	it('passes an explicit size, seed and model through', async () => {
		await generateOneImage({ prompt: 'x', width: 64, height: 128, seed: 9, model: 'sdxl' });
		expect(seen[0]).toMatchObject({ width: 64, height: 128, seed: 9, model: 'sdxl' });
	});

	it('surfaces a backend failure unchanged, kind included', async () => {
		fail = new ImageBackendError('unreachable', 'nope');
		await expect(generateOneImage({ prompt: 'x' })).rejects.toMatchObject({ kind: 'unreachable' });
	});

	it('fails with the unconfigured message when no backend is set', async () => {
		updateSettings({ imageBackendKind: 'none' });
		await expect(generateOneImage({ prompt: 'x' })).rejects.toThrow(/Settings → Image/);
	});
});

/**
 * The additive proof.
 *
 * The overview commits to a later image tab or inline chat image being
 * additive work rather than a refactor. `layering.test.ts` checks the files in
 * this module; this checks the whole REACHABLE graph from the single-image
 * call, which is the thing a future consumer would actually pull in. It is the
 * transitive version, and it is what catches the boundary eroding through a
 * dependency rather than through a direct import.
 */
describe('a single image needs no job machinery', () => {
	it('reaches nothing under agent/jobs, transitively', () => {
		const start = 'src/lib/image/generateOne.ts';
		const seen = new Set<string>();
		const stack = [start];
		while (stack.length > 0) {
			const file = stack.pop()!;
			if (seen.has(file)) continue;
			seen.add(file);
			let src: string;
			try {
				src = readFileSync(file, 'utf8');
			} catch {
				continue;
			}
			for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
				const resolved = resolveSpecifier(m[1], file);
				if (resolved) stack.push(resolved);
			}
		}
		// A walk that found nothing would pass forever.
		expect(seen.size).toBeGreaterThan(5);
		expect([...seen].filter((f) => f.includes('agent/jobs'))).toEqual([]);
	});

	it('still completes a generation end to end', async () => {
		const result = await generateOneImage({ prompt: 'a red apple' });
		expect(result.images).toHaveLength(1);
	});
});
