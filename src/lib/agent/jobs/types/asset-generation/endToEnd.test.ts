/**
 * The overview's success criteria, as tests.
 *
 * Each `it` below names a criterion rather than a function, and the ones that
 * can be checked mechanically are checked here. The two that cannot are
 * documented at the bottom of this file and in `docs/image-generation.md`,
 * because a criterion nobody can check is worse recorded as a passing test
 * than as a checklist item — that is the mistake this whole plan was written
 * after.
 *
 * Nothing here reaches a model or a server. The live variants are gated (see
 * `LIVE` below) so CI never downloads weights or expects a backend.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { escapesWorkdir } from './generate';
import { validateAssetSpec } from '$lib/assets/spec/validate';
import { parseAssetSpec } from '$lib/assets/spec/parse';
import { renderAssetSpec } from '$lib/assets/spec/write';
import { anchorPrompt, anchorNegativePrompt } from './anchor';
import { entryPrompt } from './request';
import type { AssetSpec, NormalizeProfile } from '$lib/assets/spec/types';

declare const process: { env: Record<string, string | undefined> };

/**
 * Live end-to-end runs are opt-in, the same way the verifier A/B probe is.
 *
 *   HARUSPEX_IMAGE_E2E=1 \
 *   HARUSPEX_IMAGE_BACKEND_URL=http://127.0.0.1:8188 \
 *   npx vitest run endToEnd
 *
 * Without both, the live cases skip. CI must never reach for a GPU.
 */
const LIVE = process.env.HARUSPEX_IMAGE_E2E === '1';
const BACKEND_URL = process.env.HARUSPEX_IMAGE_BACKEND_URL ?? '';
const live = LIVE && BACKEND_URL ? it : it.skip;

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

function profile(over: Partial<NormalizeProfile> = {}): NormalizeProfile {
	return {
		target_size: 32,
		upscale: 16,
		palette_size: 32,
		palette: [],
		background: {
			color: 0xff00ffff,
			tolerance: 40,
			hue_tolerance_deg: 20,
			min_saturation: 90,
			min_value: 60,
			auto_detect: true
		},
		crop: { enabled: true, margin: 1, min_island_fraction: 0.05 },
		outline: { enabled: true, color: 0x1a1a1aff, width: 2 },
		reference_strength: 0.6,
		checks: { alpha_min: 0.05, alpha_max: 0.95, entropy_min: 1, palette_distance_max: 0.15 },
		by_kind: {},
		...over
	} as NormalizeProfile;
}

function spec(over: Partial<AssetSpec> = {}): AssetSpec {
	return {
		version: 1,
		style: { prompt: 'flat pixel art, bold dark outline' },
		anchor: { image: 'assets/haruspex-anchor.png', recipe: 'assets/haruspex-anchor.json' },
		normalize: profile(),
		entries: [
			{ id: 'iron_sword', kind: 'sprite', prompt: 'an iron sword', out: 'a/sword.png' },
			{ id: 'cobblestone', kind: 'texture', prompt: 'cobbles', out: 'a/cobbles.png' }
		],
		...over
	} as AssetSpec;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('criterion: the spec, anchor and recipe reproduce the art from a fresh clone', () => {
	it('keeps every field a re-run depends on through a write/parse round trip', () => {
		// The claim is that a colleague cloning the repo regenerates the same
		// set. That only holds if the file carries everything: the style, the
		// palette, the anchor paths and each entry's own overrides.
		const original = spec({
			normalize: profile({ palette: [0x112233ff, 0x445566ff] }),
			style: { prompt: 'flat pixel art', negativePrompt: 'blurry', model: 'sd15' }
		});
		const round = parseAssetSpec(renderAssetSpec(original));
		expect('spec' in round, 'errors' in round ? round.errors.join('; ') : '').toBe(true);
		if (!('spec' in round)) return;

		expect(round.spec.style).toEqual(original.style);
		expect(round.spec.anchor).toEqual(original.anchor);
		expect(round.spec.normalize.palette).toEqual([0x112233ff, 0x445566ff]);
		expect(round.spec.entries.map((e) => e.id)).toEqual(['iron_sword', 'cobblestone']);
	});

	it('names the anchor image and recipe as project files, so they can be committed', () => {
		// An anchor living outside the project is an anchor that does not
		// travel, and the whole point is that the style is a versioned
		// artifact rather than something reconstructed from a recipe.
		const s = spec();
		for (const p of [s.anchor.image, s.anchor.recipe]) {
			expect(escapesWorkdir(p)).toBe(false);
			expect(p.startsWith('/')).toBe(false);
		}
	});

	it('rejects a spec whose output path leaves the project', () => {
		const bad = spec({
			entries: [{ id: 'evil', kind: 'sprite', prompt: 'x', out: '../evil.png' }]
		} as Partial<AssetSpec>);
		expect(validateAssetSpec(bad).join(' ')).toContain('evil');
	});
});

describe('criterion: a path check that passes on Linux must not fail on Windows', () => {
	it('treats a backslash path as the escape it is', () => {
		// The classic version of this bug: `..\\evil.png` is not an escape by
		// forward-slash rules, and Windows resolves it as one.
		for (const p of ['..\\evil.png', 'a\\..\\..\\evil.png', '..\\..\\x.png']) {
			expect(escapesWorkdir(p)).toBe(true);
		}
	});

	it('treats a drive-lettered path as absolute', () => {
		for (const p of ['C:\\evil.png', 'c:/evil.png', 'Z:\\x\\y.png']) {
			expect(escapesWorkdir(p)).toBe(true);
		}
	});

	it('leaves an ordinary relative path alone, whichever separator it uses', () => {
		for (const p of ['assets/generated/sprite/x.png', 'assets\\generated\\sprite\\x.png']) {
			expect(escapesWorkdir(p)).toBe(false);
		}
	});

	it('is not fooled by a directory whose name merely contains dots', () => {
		expect(escapesWorkdir('assets/..hidden/x.png')).toBe(false);
		expect(escapesWorkdir('assets/x..y/z.png')).toBe(false);
	});
});

describe('criterion: no workflow authoring is required of the user', () => {
	it('builds a complete prompt from a one-line style and a subject', () => {
		// The user writes "flat pixel art" and "an iron sword"; everything
		// that makes those into a usable asset — isolation, the background
		// colour, the negative prompt — is the runner's job.
		const p = entryPrompt(spec().entries[0], spec(), profile());
		expect(p).toContain('an iron sword');
		expect(p).toContain('flat pixel art');
		expect(p).toContain('magenta');
		expect(p).toContain('isolated');
	});

	it('builds the anchor prompt from the spec alone', () => {
		const p = anchorPrompt(spec(), profile());
		expect(p).toContain('an iron sword');
		expect(anchorNegativePrompt(spec())).toContain('grid');
	});
});

/**
 * Live runs. Skipped unless pointed at a backend.
 *
 * These are the criteria that only a real generation can answer, and they are
 * written out rather than left to a manual checklist so that whoever has a
 * backend running can check them with one command.
 */
describe('criterion: live end-to-end (opt-in)', () => {
	live('reaches the configured backend', async () => {
		const res = await fetch(`${BACKEND_URL}/system_stats`);
		expect(res.ok).toBe(true);
	});
});

/**
 * WHAT THIS FILE DELIBERATELY DOES NOT ASSERT
 *
 * Two of the overview's criteria cannot be made into tests, and recording
 * them as passing ones would be the exact failure this plan was written
 * after — a stage that reports success for work nobody checked.
 *
 *   1. "A contact sheet of the set reads as one game." A human looks at
 *      `contact-sheet.png`, which the report stage writes at a known path
 *      beside the spec. If it fails, the remedy is bounded to DATA — the
 *      profile defaults, the anchor prompt's wording, the templates' sampler
 *      settings — and anything larger is recorded as follow-up.
 *
 *   2. "Deleting ten outputs and re-running gets ten back in the same style."
 *      The mechanical half IS tested, in `runner.test.ts`: anchor reuse makes
 *      no backend call, skip-existing regenerates exactly the missing files,
 *      and the palette is restored from the recipe. Whether the ten that come
 *      back MATCH is the same human judgement as (1).
 *
 * Both are in the manual checklist in `docs/image-generation.md`.
 */
