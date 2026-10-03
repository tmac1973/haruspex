import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AssetEntry, AssetSpec, NormalizeProfile } from '$lib/assets/spec/types';
import type { ImageBackendCapabilities, ImageRequest } from '$lib/image/types';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const asked = vi.hoisted(() => ({ answers: [] as string[], questions: 0 }));
vi.mock('$lib/stores/userQuestion.svelte', () => ({
	askUserQuestion: async () => {
		asked.questions++;
		return { kind: 'selected', labels: [asked.answers.shift() ?? 'Approve'] };
	}
}));
vi.mock('$lib/images/resolve.svelte', () => ({ registerLocalImage: () => 'haruspex-img://x' }));

const backend = vi.hoisted(() => ({ requests: [] as ImageRequest[] }));
vi.mock('$lib/image', () => ({
	resolveImageBackend: () => ({
		generate: async (req: ImageRequest) => {
			backend.requests.push(req);
			return {
				images: [{ bytes: new Uint8Array([1]), mimeType: 'image/png', width: 1024, height: 1024 }],
				meta: {
					seed: req.seed ?? 77,
					model: 'ming.safetensors',
					backend: 'comfyui',
					sampler: { name: 'euler', steps: 12, cfg: 1 },
					loras: [],
					durationMs: 1
				}
			};
		}
	})
}));

import { anchorSheetPlan, establishAnchor, type AnchorDeps } from './anchor';

const PALETTE = [0x202020ff, 0x806040ff, 0xc0a080ff];

function entry(id: string, over: Partial<AssetEntry> = {}): AssetEntry {
	return { id, kind: 'sprite', prompt: `a ${id}`, out: `out/${id}.png`, ...over };
}

function spec(over: Partial<AssetSpec> = {}): AssetSpec {
	return {
		version: 1,
		style: { prompt: '16-bit pixel art' },
		anchor: { image: 'a/anchor.png', recipe: 'a/anchor.json' },
		normalize: { palette_size: 16, background: { color: 0xff00ffff } } as NormalizeProfile,
		entries: [
			entry('ghoul', { sheet: 'characters' }),
			entry('sword', { sheet: 'items' }),
			entry('potion', { sheet: 'items' }),
			entry('grass', { kind: 'texture', seamless: true })
		],
		...over
	};
}

const ALPHA: ImageBackendCapabilities = {
	transparency: true,
	seamlessTiling: false,
	loras: false,
	maxLoras: 0
};

function deps(over: Partial<AnchorDeps> = {}): { deps: AnchorDeps; written: Map<string, string> } {
	const written = new Map<string, string>();
	return {
		written,
		deps: {
			workingDir: '/w',
			profile: spec().normalize,
			anchorAttempts: 3,
			attended: false,
			signal: new AbortController().signal,
			present: () => {},
			readFile: async () => null,
			readBytes: async () => null,
			writeFile: async (rel, content) => {
				written.set(rel, content);
			},
			writeBytes: async (rel) => {
				written.set(rel, '<bytes>');
			},
			caps: ALPHA,
			...over
		}
	};
}

beforeEach(() => {
	backend.requests.length = 0;
	asked.answers.length = 0;
	asked.questions = 0;
	invoke.mockReset().mockImplementation(async (cmd: string) => {
		if (cmd === 'image_split_sheet') return { pieces: [], keyed: false, palette: PALETTE };
		if (cmd === 'image_palette_spread')
			return { ok: true, dominant_fraction: 0.2, buckets_used: 5 };
		if (cmd === 'image_store_bytes') return 'hash';
		if (cmd === 'image_extract_palette') return [0xff0000ff];
		return undefined;
	});
});

describe('anchorSheetPlan', () => {
	it('takes the sheet the spec names', () => {
		const s = spec({ anchor: { image: 'a', recipe: 'b', sheet: 'items' } });
		expect(anchorSheetPlan(s)?.entries.map((e) => e.id)).toEqual(['sword', 'potion']);
	});

	it('falls back to the first sheet of sprites', () => {
		expect(anchorSheetPlan(spec())?.id).toBe('characters');
	});

	it('is null when nothing goes on a sheet', () => {
		expect(anchorSheetPlan(spec({ entries: [entry('grass', { kind: 'texture' })] }))).toBeNull();
	});
});

describe('a sheet anchor', () => {
	it('is the named sheet itself, generated transparent at the sheet edge', async () => {
		const s = spec({ anchor: { image: 'a/anchor.png', recipe: 'a/anchor.json', sheet: 'items' } });
		const r = await establishAnchor(s, deps().deps, 1024);
		expect(backend.requests).toHaveLength(1);
		expect(backend.requests[0]).toMatchObject({ transparent: true, width: 1024, height: 1024 });
		expect(backend.requests[0].prompt).toContain('a sword; a potion');
		expect(r.pregenerated?.sheetId).toBe('items');
	});

	it('takes its palette from the CUT sheet, not the raw image', async () => {
		const r = await establishAnchor(spec(), deps().deps, 1024);
		expect(r.spec.normalize.palette).toEqual(PALETTE);
		const split = invoke.mock.calls.find(([cmd]) => cmd === 'image_split_sheet');
		expect(split![1].paletteSize).toBe(16);
		expect(invoke.mock.calls.some(([cmd]) => cmd === 'image_extract_palette')).toBe(false);
	});

	it('records which sheet and entries it is in the recipe', async () => {
		const { deps: d, written } = deps();
		await establishAnchor(spec(), d, 1024);
		const recipe = JSON.parse(written.get('a/anchor.json')!);
		expect(recipe).toMatchObject({
			sheet: 'characters',
			entries: ['ghoul'],
			seed: 77,
			palette: PALETTE
		});
		expect(recipe.prompt).toContain('A single game sprite of a ghoul');
	});

	it('tells the person approving it that these are real assets', async () => {
		let shown = '';
		await establishAnchor(spec(), deps({ attended: true, present: (m) => (shown = m) }).deps, 1024);
		expect(shown).toContain('This sheet is real assets — ghoul');
		expect(asked.questions).toBe(1);
	});

	it('is the old separate picture on a backend without alpha', async () => {
		const r = await establishAnchor(
			spec(),
			deps({ caps: { ...ALPHA, transparency: false } }).deps,
			1024
		);
		expect(backend.requests[0].transparent).toBeUndefined();
		expect(r.pregenerated).toBeUndefined();
		expect(r.spec.normalize.palette).toEqual([0xff0000ff]);
	});

	it('is reused, not regenerated, when committed', async () => {
		const recipe = JSON.stringify({ palette: PALETTE, sheet: 'characters' });
		const r = await establishAnchor(
			spec(),
			deps({ readBytes: async () => new Uint8Array([1]), readFile: async () => recipe }).deps,
			1024
		);
		expect(backend.requests).toHaveLength(0);
		expect(r.outcome.source).toBe('reused');
		expect(r.pregenerated).toBeUndefined();
	});

	it('is not re-rolled for a palette that leans on one colour', async () => {
		// Its palette is imposed on nothing: each sheet takes its own.
		invoke.mockImplementation(async (cmd: string) => {
			if (cmd === 'image_split_sheet') return { pieces: [], keyed: false, palette: PALETTE };
			if (cmd === 'image_palette_spread')
				return { ok: false, dominant_fraction: 0.9, buckets_used: 1 };
			return undefined;
		});
		const r = await establishAnchor(spec(), deps().deps, 1024);
		expect(backend.requests).toHaveLength(1);
		expect(r.outcome.rejected).toBe(0);
	});
});
