import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateEntries, escapesWorkdir, type GenerateDeps } from './generate';
import type { SheetOutcome } from './types';
import type { AssetEntry, AssetSpec, NormalizeProfile } from '$lib/assets/spec/types';
import { ImageBackendError } from '$lib/image/types';
import type { ImageBackendCapabilities, ImageRequest } from '$lib/image/types';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

function profile(over: Partial<NormalizeProfile> = {}): NormalizeProfile {
	return {
		target_size: 32,
		upscale: 16,
		palette_size: 16,
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
		checks: { alpha_min: 0.05, alpha_max: 0.95, entropy_min: 1, palette_distance_max: 0.15 },
		by_kind: {},
		...over
	} as NormalizeProfile;
}

function specOf(entries: Partial<AssetEntry>[]): AssetSpec {
	return {
		version: 1,
		style: { prompt: 'flat pixel art' },
		anchor: { image: 'a/anchor.png', recipe: 'a/anchor.json' },
		normalize: profile(),
		entries: entries.map((e, i) => ({
			id: `e${i}`,
			kind: 'sprite',
			prompt: 'a thing',
			out: `out/e${i}.png`,
			...e
		})) as AssetEntry[]
	} as AssetSpec;
}

/**
 * Everything but transparency: these tests drive the one-image-per-entry path,
 * which is what a backend without alpha gets. The sheet path has its own
 * `describe` below.
 */
const FULL: ImageBackendCapabilities = {
	transparency: false,
	seamlessTiling: true,
	loras: true,
	maxLoras: 2
};

const STATS = { alpha: 0.5, entropy: 3, palette_distance: 0.01 };

/** Verdicts `image_check` hands back, one per call, then the last repeats. */
const checkQueue: Array<{ passed: boolean; failed: string[] }> = [];

interface Harness {
	deps: GenerateDeps;
	requests: ImageRequest[];
	written: string[];
	/** Highest number of generations in flight at once. */
	peak: () => number;
	controller: AbortController;
}

function harness(over: Partial<GenerateDeps> = {}, present: string[] = []): Harness {
	const requests: ImageRequest[] = [];
	const written: string[] = [];
	const controller = new AbortController();
	let inFlight = 0;
	let peak = 0;

	const deps: GenerateDeps = {
		caps: FULL,
		concurrency: 1,
		maxEdge: 1024,
		maxAttempts: 1,
		judge: { visionSupported: false, enabled: false, judge: async () => null },
		signal: controller.signal,
		generate: async (req) => {
			requests.push(req);
			inFlight++;
			peak = Math.max(peak, inFlight);
			await Promise.resolve();
			inFlight--;
			return {
				images: [{ bytes: new Uint8Array([9]), mimeType: 'image/png', width: 512, height: 512 }],
				meta: {
					seed: 42,
					model: 'm',
					backend: 'comfyui' as const,
					sampler: { name: 'euler', steps: 20, cfg: 6 },
					loras: [],
					durationMs: 1
				}
			};
		},
		exists: async (rel) => present.includes(rel),
		writeBytes: async (rel) => {
			written.push(rel);
		},
		progress: () => {},
		...over
	};
	return { deps, requests, written, peak: () => peak, controller };
}

beforeEach(() => {
	checkQueue.length = 0;
	invoke.mockReset().mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		// A texture's resolved profile really differs from the base — otherwise
		// "did it use the resolver?" is unobservable and the test is vacuous.
		if (cmd === 'image_effective_profile') {
			const base = args?.profile as NormalizeProfile;
			return args?.kind === 'texture' ? { ...base, upscale: 8 } : base;
		}
		if (cmd === 'image_normalize') return { bytes: [1, 2, 3, 4], stats: STATS };
		if (cmd === 'image_check') {
			const v =
				checkQueue.length > 1
					? checkQueue.shift()!
					: (checkQueue[0] ?? { passed: true, failed: [] });
			return { passed: v.passed, stats: STATS, failed: v.failed };
		}
		return undefined;
	});
});

describe('escapesWorkdir', () => {
	it('catches the shapes validation catches', () => {
		expect(escapesWorkdir('../evil.png')).toBe(true);
		expect(escapesWorkdir('/etc/passwd')).toBe(true);
		expect(escapesWorkdir('C:\\evil.png')).toBe(true);
		expect(escapesWorkdir('a/../../evil.png')).toBe(true);
		expect(escapesWorkdir('out/fine.png')).toBe(false);
		// A directory whose NAME contains dots is not an escape.
		expect(escapesWorkdir('out/..hidden/f.png')).toBe(false);
	});
});

describe('skipping what already exists', () => {
	it('regenerates exactly the files that are missing', async () => {
		// Delete ten of a hundred, re-run, get exactly those ten back.
		const spec = specOf([{}, {}, {}, {}, {}]);
		const h = harness({}, ['out/e1.png', 'out/e3.png']);
		const results = await generateEntries(spec, h.deps);

		expect(h.requests).toHaveLength(3);
		expect(h.written).toEqual(['out/e0.png', 'out/e2.png', 'out/e4.png']);
		expect(results.map((r) => r.outcome.status)).toEqual([
			'done',
			'skipped',
			'done',
			'skipped',
			'done'
		]);
	});

	it('records no attempts and no seed for a skipped entry', async () => {
		const h = harness({}, ['out/e0.png']);
		const [r] = await generateEntries(specOf([{}]), h.deps);
		expect(r.outcome.attempts).toBe(0);
		expect(r.outcome.seed).toBeNull();
		expect(r.report).toBeNull();
	});
});

describe('a texture the backend could not tile', () => {
	const untiled = (over: Partial<GenerateDeps> = {}) =>
		harness({
			generate: async () => ({
				images: [{ bytes: new Uint8Array([9]), mimeType: 'image/png', width: 512, height: 512 }],
				meta: {
					seed: 42,
					model: 'qwen21',
					backend: 'local' as const,
					sampler: { name: 'euler', steps: 25, cfg: 1 },
					loras: [],
					durationMs: 1,
					seamFailed: 'vae encode compute failed'
				}
			}),
			...over
		});

	it('is kept, judged without the seam gate, and reported as not seamless', async () => {
		// The run that lost all nine of its textures to a failed seam pass.
		const h = untiled();
		const [r] = await generateEntries(specOf([{ kind: 'texture', seamless: true }]), h.deps);
		expect(r.outcome.status).toBe('done');
		expect(h.written).toEqual(['out/e0.png']);
		expect(r.outcome.degraded).toEqual(['not seamless']);
		const check = invoke.mock.calls.find(([cmd]) => cmd === 'image_check');
		expect((check![1].profile as NormalizeProfile).checks.seam_max).toBeUndefined();
	});

	it('still gates the seam on a texture that did tile', async () => {
		await generateEntries(specOf([{ kind: 'texture', seamless: true }]), harness().deps);
		const check = invoke.mock.calls.find(([cmd]) => cmd === 'image_check');
		expect((check![1].profile as NormalizeProfile).checks.seam_max).toBe(3);
	});
});

describe('per-kind profiles', () => {
	it('resolves each kind once, through the Rust resolver', async () => {
		// Once per KIND, not once per entry: the branch that disables cropping
		// for a texture must be decided in exactly one place.
		const spec = specOf([
			{ kind: 'sprite' },
			{ kind: 'sprite' },
			{ kind: 'texture' },
			{ kind: 'icon' }
		]);
		await generateEntries(spec, harness().deps);
		const kinds = invoke.mock.calls
			.filter(([cmd]) => cmd === 'image_effective_profile')
			.map(([, args]) => args.kind);
		expect(kinds.sort()).toEqual(['icon', 'sprite', 'texture']);
	});

	it('normalizes with the entry kind, so the texture branch applies', async () => {
		await generateEntries(specOf([{ kind: 'texture' }]), harness().deps);
		const call = invoke.mock.calls.find(([cmd]) => cmd === 'image_normalize');
		expect(call![1].kind).toBe('texture');
	});

	it('builds the request from the RESOLVED profile, not the base', async () => {
		// The request and the normalization have to agree about what a texture
		// is; they only do if both come from the same resolver.
		const spec = specOf([{ kind: 'sprite' }, { kind: 'texture' }]);
		const h = harness();
		await generateEntries(spec, h.deps);
		expect(h.requests[0].width).toBe(32 * 16);
		expect(h.requests[1].width).toBe(32 * 8);
	});

	it('normalizes with the resolved profile too', async () => {
		await generateEntries(specOf([{ kind: 'texture' }]), harness().deps);
		const call = invoke.mock.calls.find(([cmd]) => cmd === 'image_normalize');
		expect((call![1].profile as NormalizeProfile).upscale).toBe(8);
	});
});

describe('concurrency', () => {
	it('keeps at most `concurrency` generations in flight', async () => {
		const spec = specOf(Array.from({ length: 8 }, () => ({})));
		const h = harness({
			concurrency: 4,
			generate: async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise((r) => setTimeout(r, 1));
				inFlight--;
				return {
					images: [{ bytes: new Uint8Array([9]), mimeType: 'image/png', width: 512, height: 512 }],
					meta: {
						seed: 1,
						model: 'm',
						backend: 'comfyui' as const,
						sampler: { name: 'e', steps: 1, cfg: 1 },
						loras: [],
						durationMs: 1
					}
				};
			}
		});
		let inFlight = 0;
		let peak = 0;
		await generateEntries(spec, h.deps);
		expect(peak).toBe(4);
	});

	it('returns results in entry order despite out-of-order completion', async () => {
		// Two runs of the same spec must produce the same report.
		const spec = specOf([{ id: 'slow' }, { id: 'fast' }]);
		let n = 0;
		const h = harness({
			concurrency: 2,
			generate: async () => {
				const mine = n++;
				await new Promise((r) => setTimeout(r, mine === 0 ? 10 : 1));
				return {
					images: [{ bytes: new Uint8Array([9]), mimeType: 'image/png', width: 512, height: 512 }],
					meta: {
						seed: mine,
						model: 'm',
						backend: 'comfyui' as const,
						sampler: { name: 'e', steps: 1, cfg: 1 },
						loras: [],
						durationMs: 1
					}
				};
			}
		});
		const results = await generateEntries(spec, h.deps);
		expect(results.map((r) => r.outcome.id)).toEqual(['slow', 'fast']);
		expect(results.map((r) => r.outcome.seed)).toEqual([0, 1]);
	});
});

describe('failures', () => {
	it('fails one entry and carries on with the rest', async () => {
		// One missing model must not cost the other ninety-nine.
		const spec = specOf([{}, {}, {}]);
		let n = 0;
		const h = harness({
			generate: async () => {
				if (n++ === 1) throw new ImageBackendError('rejected', 'no such checkpoint');
				return {
					images: [{ bytes: new Uint8Array([9]), mimeType: 'image/png', width: 512, height: 512 }],
					meta: {
						seed: 1,
						model: 'm',
						backend: 'comfyui' as const,
						sampler: { name: 'e', steps: 1, cfg: 1 },
						loras: [],
						durationMs: 1
					}
				};
			}
		});
		const results = await generateEntries(spec, h.deps);
		expect(results.map((r) => r.outcome.status)).toEqual(['done', 'failed', 'done']);
		expect(results[1].outcome.reason).toContain('no such checkpoint');
		expect(h.written).toEqual(['out/e0.png', 'out/e2.png']);
	});

	it('does not retry a rejection — retrying it is theatre', async () => {
		const gen = vi.fn(async () => {
			throw new ImageBackendError('rejected', 'nope');
		});
		const h = harness({ generate: gen as unknown as GenerateDeps['generate'] });
		await generateEntries(specOf([{}]), h.deps);
		expect(gen).toHaveBeenCalledTimes(1);
	});

	it('re-queues a backend that vanished, once, at the end of the run', async () => {
		// The overview's "survive a backend that disappears mid-run": the
		// remaining entries still run and the run finishes with a report.
		const spec = specOf([{}, {}, {}]);
		const seen: string[] = [];
		let down = true;
		const h = harness({
			generate: async (req) => {
				seen.push(req.prompt);
				if (down && seen.length === 2) {
					down = false;
					throw new ImageBackendError('unreachable', 'connection refused');
				}
				return {
					images: [{ bytes: new Uint8Array([9]), mimeType: 'image/png', width: 512, height: 512 }],
					meta: {
						seed: 1,
						model: 'm',
						backend: 'comfyui' as const,
						sampler: { name: 'e', steps: 1, cfg: 1 },
						loras: [],
						durationMs: 1
					}
				};
			}
		});
		const results = await generateEntries(spec, h.deps);
		expect(results.map((r) => r.outcome.status)).toEqual(['done', 'done', 'done']);
		// Three entries, four calls: the second was tried twice.
		expect(seen).toHaveLength(4);
		expect(h.written).toEqual(['out/e0.png', 'out/e2.png', 'out/e1.png']);
	});

	it('gives up on a re-queued entry that fails twice, without a third try', async () => {
		const gen = vi.fn(async () => {
			throw new ImageBackendError('timeout', 'took too long');
		});
		const h = harness({ generate: gen as unknown as GenerateDeps['generate'] });
		const [r] = await generateEntries(specOf([{}]), h.deps);
		expect(gen).toHaveBeenCalledTimes(2);
		expect(r.outcome.status).toBe('failed');
		expect(r.outcome.reason).toContain('took too long');
	});

	it('fails an entry whose output path escapes, and writes nothing', async () => {
		// Re-checked here even though validation would also have caught it:
		// the spec may have been derived and rewritten since.
		const spec = specOf([{ out: '../evil.png' }, {}]);
		const h = harness();
		const results = await generateEntries(spec, h.deps);
		expect(results[0].outcome.status).toBe('failed');
		expect(results[0].outcome.reason).toContain('escapes');
		expect(h.requests).toHaveLength(1);
		expect(h.written).toEqual(['out/e1.png']);
	});

	it('fails the entry, not the run, when writing the file throws', async () => {
		const h = harness({
			writeBytes: async () => {
				throw new Error('read-only filesystem');
			}
		});
		const [r] = await generateEntries(specOf([{}]), h.deps);
		expect(r.outcome.status).toBe('failed');
		expect(r.outcome.reason).toContain('read-only');
	});
});

describe('cancellation', () => {
	it('stops the loop and writes no further files', async () => {
		const spec = specOf([{}, {}, {}, {}]);
		let calls = 0;
		const h: Harness = harness({
			generate: async () => {
				if (++calls >= 2) h.controller.abort();
				return {
					images: [{ bytes: new Uint8Array([9]), mimeType: 'image/png', width: 512, height: 512 }],
					meta: {
						seed: 1,
						model: 'm',
						backend: 'comfyui' as const,
						sampler: { name: 'e', steps: 1, cfg: 1 },
						loras: [],
						durationMs: 1
					}
				};
			}
		});
		await expect(generateEntries(spec, h.deps)).rejects.toThrow(/abort/i);
		expect(calls).toBe(2);
		expect(h.written.length).toBeLessThan(4);
	});

	it('propagates a backend cancellation rather than recording a failed entry', async () => {
		const h = harness({
			generate: async () => {
				throw new ImageBackendError('cancelled', 'stopped');
			}
		});
		await expect(generateEntries(specOf([{}]), h.deps)).rejects.toThrow('stopped');
	});
});

describe('progress', () => {
	it('counts every finished entry, skipped and failed included', async () => {
		const spec = specOf([{}, {}, { out: '../evil.png' }]);
		const seen: Array<[number, number, string]> = [];
		const h = harness({ progress: (n, t, id) => seen.push([n, t, id]) }, ['out/e1.png']);
		await generateEntries(spec, h.deps);
		expect(seen.map(([n]) => n)).toEqual([1, 2, 3]);
		expect(seen.every(([, t]) => t === 3)).toBe(true);
	});
});

describe('the quality gate', () => {
	function failing(rounds: Array<{ passed: boolean; failed: string[] }>) {
		checkQueue.push(...rounds);
	}

	it('accepts an asset that passes on the first attempt, writing it once', async () => {
		const h = harness({ maxAttempts: 3 });
		const [r] = await generateEntries(specOf([{}]), h.deps);
		expect(r.outcome.status).toBe('done');
		expect(r.outcome.attempts).toBe(1);
		expect(h.written).toEqual(['out/e0.png']);
	});

	it('retries a failed check with a new seed and an amended negative prompt', async () => {
		failing([
			{ passed: false, failed: ['entropy'] },
			{ passed: true, failed: [] }
		]);
		const h = harness({ maxAttempts: 3 });
		const [r] = await generateEntries(specOf([{}]), h.deps);

		expect(r.outcome.status).toBe('done');
		expect(r.outcome.attempts).toBe(2);
		expect(h.requests).toHaveLength(2);
		expect(h.requests[0].seed).not.toBe(h.requests[1].seed);
		expect(h.requests[1].negativePrompt).toContain('featureless');
		expect(h.requests[0].negativePrompt).not.toContain('featureless');
		expect(h.written).toEqual(['out/e0.png']);
	});

	it('re-says the style in the prompt when the result was off-palette', async () => {
		failing([
			{ passed: false, failed: ['palette_distance'] },
			{ passed: true, failed: [] }
		]);
		const h = harness({ maxAttempts: 2 });
		await generateEntries(specOf([{}]), h.deps);
		expect(h.requests[1].prompt).toContain('flat pixel art');
		expect(h.requests[1].prompt.split('flat pixel art').length - 1).toBe(2);
	});

	it('keeps the best attempt of an entry that never passes, and says so', async () => {
		// The code built on the set needs a file to load; the spec marks it
		// rejected so Review assets can send it back.
		failing([{ passed: false, failed: ['alpha_low'] }]);
		const h = harness({ maxAttempts: 3 });
		const [r] = await generateEntries(specOf([{}]), h.deps);

		expect(r.outcome.status).toBe('unresolved');
		expect(r.outcome.attempts).toBe(3);
		expect(r.outcome.kept).toBe(true);
		expect(h.written).toEqual(['out/e0.png']);
		expect(h.requests).toHaveLength(3);
	});

	it('writes the best attempt, not the last', async () => {
		failing([
			{ passed: false, failed: ['alpha_low', 'entropy'] },
			{ passed: false, failed: ['entropy'] },
			{ passed: false, failed: ['alpha_low', 'entropy', 'palette_distance'] }
		]);
		let n = 0;
		const base = invoke.getMockImplementation()!;
		invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) =>
			cmd === 'image_normalize' ? { bytes: [++n], stats: STATS } : base(cmd, args)
		);
		const bytes: number[][] = [];
		const h = harness({
			maxAttempts: 3,
			writeBytes: async (_rel: string, b: Uint8Array) => {
				bytes.push([...b]);
			}
		});
		await generateEntries(specOf([{}]), h.deps);
		expect(bytes).toEqual([[2]]);
	});

	it('keeps the best report across attempts, not the last', async () => {
		failing([
			{ passed: false, failed: ['alpha_low', 'entropy'] },
			{ passed: false, failed: ['entropy'] },
			{ passed: false, failed: ['alpha_low', 'entropy', 'palette_distance'] }
		]);
		const h = harness({ maxAttempts: 3 });
		const [r] = await generateEntries(specOf([{}]), h.deps);
		expect(r.report?.failed).toEqual(['entropy']);
	});

	it('varies the seed even for an entry that pinned one', async () => {
		// A pinned seed that fails every check retries identically until the
		// budget runs out.
		failing([{ passed: false, failed: ['entropy'] }]);
		const h = harness({ maxAttempts: 3 });
		await generateEntries(specOf([{ seed: 7 }]), h.deps);
		expect(h.requests[0].seed).toBe(7);
		expect(new Set(h.requests.map((r) => r.seed)).size).toBe(3);
	});

	it('retries an image normalization refuses, rather than failing the entry', async () => {
		// "Nothing left after removing the background" is a rejection like any
		// other — a blank generation, caught one step earlier.
		let n = 0;
		invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
			if (cmd === 'image_effective_profile') return args?.profile;
			if (cmd === 'image_normalize') {
				if (n++ === 0) throw new Error('Nothing left after removing the background');
				return { bytes: [1, 2, 3, 4], stats: STATS };
			}
			if (cmd === 'image_check') return { passed: true, stats: STATS, failed: [] };
			return undefined;
		});
		const h = harness({ maxAttempts: 3 });
		const [r] = await generateEntries(specOf([{}]), h.deps);
		expect(r.outcome.status).toBe('done');
		expect(r.outcome.attempts).toBe(2);
	});

	it('records unresolved with the refusal when normalization never succeeds', async () => {
		invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
			if (cmd === 'image_effective_profile') return args?.profile;
			if (cmd === 'image_normalize') throw new Error('the image is empty');
			return undefined;
		});
		const h = harness({ maxAttempts: 2 });
		const [r] = await generateEntries(specOf([{}]), h.deps);
		expect(r.outcome.status).toBe('unresolved');
		expect(r.outcome.reason).toContain('the image is empty');
		expect(h.written).toEqual([]);
	});
});

describe('the vision judge', () => {
	it('is not asked about an image that already failed the free checks', async () => {
		// There is nothing to ask about a blank.
		checkQueue.push({ passed: false, failed: ['alpha_low'] });
		const judge = vi.fn(async () => ({ ok: true, reason: 'fine' }));
		const h = harness({
			maxAttempts: 1,
			judge: { enabled: true, visionSupported: true, judge }
		});
		await generateEntries(specOf([{}]), h.deps);
		expect(judge).not.toHaveBeenCalled();
	});

	it('rejects a passing image and retries when the judge says no', async () => {
		let n = 0;
		const judge = vi.fn(async () => ({ ok: n++ > 0, reason: 'that is a hammer' }));
		const h = harness({
			maxAttempts: 3,
			judge: { enabled: true, visionSupported: true, judge }
		});
		const [r] = await generateEntries(specOf([{}]), h.deps);
		expect(r.outcome.status).toBe('done');
		expect(r.outcome.attempts).toBe(2);
		expect(h.written).toEqual(['out/e0.png']);
	});

	it('records the judge\u2019s own words when it exhausts the budget', async () => {
		const judge = vi.fn(async () => ({ ok: false, reason: 'that is a hammer' }));
		const h = harness({
			maxAttempts: 2,
			judge: { enabled: true, visionSupported: true, judge }
		});
		const [r] = await generateEntries(specOf([{}]), h.deps);
		expect(r.outcome.status).toBe('unresolved');
		expect(r.outcome.reason).toBe('that is a hammer');
		expect(r.outcome.kept).toBe(true);
		expect(h.written).toEqual(['out/e0.png']);
	});

	it('is handed the normalized bytes, not the raw generation', async () => {
		// It is judging the asset the project will ship, not an intermediate.
		const seen: Uint8Array[] = [];
		const judge = vi.fn(async (_e, image: Uint8Array) => {
			seen.push(image);
			return { ok: true, reason: 'fine' };
		});
		const h = harness({
			maxAttempts: 1,
			judge: { enabled: true, visionSupported: true, judge }
		});
		await generateEntries(specOf([{}]), h.deps);
		expect([...seen[0]]).toEqual([1, 2, 3, 4]);
	});

	it('accepts when the judge has no opinion', async () => {
		// A turn that produced no judgement must not read as a rejection.
		const h = harness({
			maxAttempts: 1,
			judge: { enabled: true, visionSupported: true, judge: async () => null }
		});
		const [r] = await generateEntries(specOf([{}]), h.deps);
		expect(r.outcome.status).toBe('done');
	});
});

describe('sheets', () => {
	const SHEETS: ImageBackendCapabilities = { ...FULL, transparency: true };

	/** What `image_split_sheet` returns, one per call, then the last repeats. */
	/** Each piece is [cx, cy] or [cx, cy, lobes]. */
	const splits: Array<{
		pieces: Array<[number, number] | [number, number, number]>;
		keyed?: boolean;
	}> = [];

	beforeEach(() => {
		splits.length = 0;
		const base = invoke.getMockImplementation()!;
		invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
			if (cmd === 'image_split_sheet') {
				const s = splits.length > 1 ? splits.shift()! : splits[0];
				return {
					keyed: s.keyed ?? false,
					palette: [0x123456ff],
					pieces: s.pieces.map(([cx, cy, lobes = 1]) => ({
						bytes: [7],
						x: cx - 100,
						y: cy - 100,
						width: 200,
						height: 200,
						cx,
						cy,
						area: 40_000,
						lobes
					}))
				};
			}
			return base(cmd, args);
		});
	});

	/** Centres of a 2×2 layout of three subjects on a 1024 sheet. */
	const THREE: Array<[number, number]> = [
		[256, 256],
		[768, 256],
		[512, 768]
	];

	it('makes three sprites from one transparent request', async () => {
		splits.push({ pieces: THREE });
		const seen: SheetOutcome[] = [];
		const h = harness({ caps: SHEETS, onSheet: (o) => seen.push(o) });
		const results = await generateEntries(specOf([{}, {}, {}]), h.deps);
		expect(h.requests).toHaveLength(1);
		expect(h.requests[0]).toMatchObject({ transparent: true, width: 1024, height: 1024 });
		expect(h.written).toEqual(['out/e0.png', 'out/e1.png', 'out/e2.png']);
		expect(results.every((r) => r.outcome.status === 'done' && r.outcome.seed === 42)).toBe(true);
		expect(seen).toEqual([
			expect.objectContaining({ id: 'sprites', round: 1, exact: true, missing: 0, merged: 0 })
		]);
	});

	it('regenerates the subject the sheet left out, drawn beside finished ones', async () => {
		// The retry is padded with the group's finished subjects so it is
		// drawn at their scale; only its own cell is kept.
		splits.push({ pieces: [THREE[0], THREE[2]] }, { pieces: THREE });
		const seen: SheetOutcome[] = [];
		const h = harness({ caps: SHEETS, maxAttempts: 2, onSheet: (o) => seen.push(o) });
		const results = await generateEntries(specOf([{}, {}, {}]), h.deps);
		expect(h.requests).toHaveLength(2);
		expect(h.requests[1].prompt).toMatch(/three separate game sprites/);
		expect(h.written).toEqual(['out/e0.png', 'out/e2.png', 'out/e1.png']);
		expect(results.map((r) => [r.outcome.status, r.outcome.attempts])).toEqual([
			['done', 1],
			['done', 2],
			['done', 1]
		]);
		expect(seen.map((s) => [s.round, s.subjects, s.missing])).toEqual([
			[1, ['e0', 'e1', 'e2'], 1],
			[2, ['e1'], 0]
		]);
	});

	it('records a subject the sheet never delivered, within budget, as unresolved', async () => {
		splits.push({ pieces: [THREE[0], THREE[2]] });
		const h = harness({ caps: SHEETS, maxAttempts: 1 });
		const results = await generateEntries(specOf([{}, {}, {}]), h.deps);
		expect(results[1].outcome).toMatchObject({ status: 'unresolved', attempts: 1 });
		expect(results[1].outcome.reason).toMatch(/Missing from its sheet/);
		// Nothing was drawn for it, so there is nothing to keep.
		expect(results[1].outcome.kept).toBeUndefined();
		expect(h.written).not.toContain('out/e1.png');
	});

	it('keeps the best cut of a subject every sheet rejected', async () => {
		splits.push({ pieces: THREE });
		const h = harness({
			caps: SHEETS,
			maxAttempts: 1,
			judge: {
				visionSupported: true,
				enabled: true,
				judge: async (e) => ({ ok: e.id !== 'e1', reason: 'that is a hammer' })
			}
		});
		const results = await generateEntries(specOf([{}, {}, {}]), h.deps);
		expect(results[1].outcome).toMatchObject({
			status: 'unresolved',
			kept: true,
			reason: 'that is a hammer'
		});
		expect(h.written).toContain('out/e1.png');
	});

	it('keeps textures on their own path', async () => {
		splits.push({ pieces: [[512, 512]] });
		const h = harness({ caps: SHEETS });
		await generateEntries(specOf([{ kind: 'texture' }, {}]), h.deps);
		expect(h.requests).toHaveLength(2);
		expect(h.requests[0].transparent).toBeUndefined();
		expect(h.requests[1].transparent).toBe(true);
	});

	it('regenerates only the subjects not already on disk, never overwriting the rest', async () => {
		// e1 is on disk. It is drawn again as padding, beside e0 and e2, but
		// its file is not touched.
		splits.push({ pieces: THREE });
		const h = harness({ caps: SHEETS }, ['out/e1.png']);
		const results = await generateEntries(specOf([{}, {}, {}]), h.deps);
		expect(results[1].outcome.status).toBe('skipped');
		expect(h.requests[0].prompt).toMatch(/three separate game sprites/);
		expect(h.written).toEqual(['out/e0.png', 'out/e2.png']);
	});

	it('pads a small sheet only from its own group', async () => {
		splits.push({ pieces: [[512, 512]] });
		const h = harness({ caps: SHEETS });
		await generateEntries(
			specOf([{ sheet: 'weapons' }, { sheet: 'items', prompt: 'a coin' }]),
			h.deps
		);
		// Two sheets of one, each with nothing else in its group to borrow.
		expect(h.requests.map((r) => r.prompt.includes('single game sprite'))).toEqual([true, true]);
	});

	it('shows a suspect piece to the judge even when the judge is off', async () => {
		// One subject missing makes the layout inexact, so the pieces that were
		// found were found by position alone — and a sword drawn where the
		// potion should be would pass every mechanical check.
		splits.push({ pieces: [THREE[0], THREE[2]] });
		const judged: string[] = [];
		const h = harness({
			caps: SHEETS,
			judge: {
				visionSupported: true,
				enabled: false,
				judge: async (e) => {
					judged.push(e.id);
					return { ok: true, reason: '' };
				}
			}
		});
		await generateEntries(specOf([{}, {}, {}]), h.deps);
		expect(judged).toEqual(['e0', 'e2']);
	});

	it('shows a piece with a neighbour stuck to it to the judge, saying what to look for', async () => {
		// The p25 player came out with a coin on its side; the layout was exact,
		// so nothing looked at it.
		splits.push({ pieces: [THREE[0], [768, 256, 2], THREE[2]] });
		const asked: Array<[string, string | undefined]> = [];
		const seen: SheetOutcome[] = [];
		const h = harness({
			caps: SHEETS,
			onSheet: (o) => seen.push(o),
			judge: {
				visionSupported: true,
				enabled: false,
				judge: async (e, _img, hint) => {
					asked.push([e.id, hint]);
					return { ok: true, reason: '' };
				}
			}
		});
		await generateEntries(specOf([{}, {}, {}]), h.deps);
		expect(asked.map(([id]) => id)).toEqual(['e1']);
		expect(asked[0][1]).toMatch(/second object drawn touching the subject.*besides e1/);
		// The layout still came out as asked.
		expect(seen[0].exact).toBe(true);
	});

	it('writes it anyway when nobody can look, and says it may be joined', async () => {
		splits.push({ pieces: [THREE[0], [768, 256, 2], THREE[2]] });
		const h = harness({ caps: SHEETS });
		const results = await generateEntries(specOf([{}, {}, {}]), h.deps);
		expect(h.written).toContain('out/e1.png');
		expect(results[1].outcome.degraded).toContain('may be joined to a neighbour');
		expect(results[0].outcome.degraded).not.toContain('may be joined to a neighbour');
	});

	it('does not judge an exact sheet when the judge is off', async () => {
		splits.push({ pieces: THREE });
		const judged: string[] = [];
		const h = harness({
			caps: SHEETS,
			judge: {
				visionSupported: true,
				enabled: false,
				judge: async (e) => {
					judged.push(e.id);
					return { ok: true, reason: '' };
				}
			}
		});
		await generateEntries(specOf([{}, {}, {}]), h.deps);
		expect(judged).toEqual([]);
	});

	it('reports a sheet keyed from an opaque backdrop', async () => {
		splits.push({ pieces: THREE, keyed: true });
		const seen: SheetOutcome[] = [];
		const h = harness({ caps: SHEETS, onSheet: (o) => seen.push(o) });
		await generateEntries(specOf([{}, {}, {}]), h.deps);
		expect(seen[0].keyed).toBe(true);
		const split = invoke.mock.calls.find(([cmd]) => cmd === 'image_split_sheet');
		// The background goes with the call, so an opaque sheet can be keyed.
		expect(split![1].background).toBeDefined();
	});

	it('re-queues a sheet once when the backend is briefly unreachable', async () => {
		splits.push({ pieces: THREE });
		let calls = 0;
		const base = harness({ caps: SHEETS });
		const h = harness({
			caps: SHEETS,
			generate: async (req, opts) => {
				calls++;
				if (calls === 1) throw new ImageBackendError('unreachable', 'down');
				return base.deps.generate(req, opts);
			}
		});
		const results = await generateEntries(specOf([{}, {}, {}]), h.deps);
		expect(calls).toBe(2);
		expect(results.every((r) => r.outcome.status === 'done')).toBe(true);
	});

	it('cuts the anchor sheet from the image the Anchor stage already made', async () => {
		// The approved anchor IS the first sheet: its assets must come from that
		// image, not from a fresh one nobody saw.
		splits.push({ pieces: THREE });
		const h = harness({ caps: SHEETS });
		const pre = await h.deps.generate(
			{ prompt: 'anchor', width: 1024, height: 1024, seed: 5 },
			{
				signal: h.controller.signal
			}
		);
		h.requests.length = 0;
		h.deps.pregenerated = new Map([['sprites', pre]]);
		const results = await generateEntries(specOf([{}, {}, {}]), h.deps);
		expect(h.requests).toHaveLength(0);
		expect(results.every((r) => r.outcome.status === 'done')).toBe(true);
	});

	it('does not reuse the anchor sheet when some of its assets are already on disk', async () => {
		// The cut would no longer line up with what is asked for.
		splits.push({ pieces: [THREE[0], THREE[1]] });
		const h = harness({ caps: SHEETS }, ['out/e1.png']);
		const pre = await h.deps.generate(
			{ prompt: 'anchor', width: 1024, height: 1024, seed: 5 },
			{
				signal: h.controller.signal
			}
		);
		h.requests.length = 0;
		h.deps.pregenerated = new Map([['sprites', pre]]);
		await generateEntries(specOf([{}, {}, {}]), h.deps);
		expect(h.requests).toHaveLength(1);
	});

	it('keeps a cut piece when the judge it was sent to cannot run, and says so', async () => {
		// The run that found this: an inexact anchor sheet made both sprites
		// suspect, the forced judge called a chat model that was not loaded,
		// and two sprites that had passed every check were recorded as failed.
		splits.push({ pieces: [THREE[0], THREE[2]] });
		const h = harness({
			caps: SHEETS,
			judge: {
				visionSupported: true,
				enabled: false,
				judge: async () => {
					throw new Error('Failed to connect to the AI model. Is it still loading?');
				}
			}
		});
		const results = await generateEntries(specOf([{}, {}, {}]), h.deps);
		expect(results[0].outcome.status).toBe('done');
		expect(results[0].outcome.degraded).toEqual([
			'not checked by the judge — Failed to connect to the AI model. Is it still loading?'
		]);
		expect(h.written).toContain('out/e0.png');
	});

	it("quantizes a sheet's pieces to that sheet's own palette, not the anchor's", async () => {
		// The run that found this: an anchor of a sword and a potion has no
		// gold, and a gold coin was rejected three times for being gold.
		splits.push({ pieces: THREE });
		const spec = specOf([{}, {}, {}]);
		spec.normalize = { ...spec.normalize, palette: [0xff0000ff] };
		await generateEntries(spec, harness({ caps: SHEETS }).deps);
		const split = invoke.mock.calls.find(([cmd]) => cmd === 'image_split_sheet');
		expect(split![1].paletteSize).toBe(16);
		const normalized = invoke.mock.calls.filter(([cmd]) => cmd === 'image_normalize');
		expect(normalized).toHaveLength(3);
		for (const [, args] of normalized) {
			expect((args.profile as NormalizeProfile).palette).toEqual([0x123456ff]);
		}
	});

	it('lets a lone image take its own palette too, on a backend with alpha', async () => {
		const spec = specOf([{ kind: 'texture' }]);
		spec.normalize = { ...spec.normalize, palette: [0xff0000ff] };
		await generateEntries(spec, harness({ caps: SHEETS }).deps);
		const call = invoke.mock.calls.find(([cmd]) => cmd === 'image_normalize');
		expect((call![1].profile as NormalizeProfile).palette).toEqual([]);
	});

	it('still imposes the anchor palette on the one-image-per-entry path', async () => {
		const spec = specOf([{}]);
		spec.normalize = { ...spec.normalize, palette: [0xff0000ff] };
		await generateEntries(spec, harness({ caps: FULL }).deps);
		const call = invoke.mock.calls.find(([cmd]) => cmd === 'image_normalize');
		expect((call![1].profile as NormalizeProfile).palette).toEqual([0xff0000ff]);
	});
});

describe('textures drawn in code', () => {
	const RECIPE = { base: { ramp: ['#000000', '#ffffff'] }, layers: [] };
	const tiles = (n: number) => Array.from({ length: n }, (_, k) => new Uint8Array([k]));

	function codeHarness(
		code: Partial<NonNullable<GenerateDeps['codeTextures']>>,
		over: Partial<GenerateDeps> = {},
		present: string[] = []
	) {
		const render = vi.fn(async (_r: unknown, _seed: number, n: number) => tiles(n));
		const revise = vi.fn(async () => null);
		const h = harness(
			{
				codeTextures: { variants: 4, render, revise, recipeFailures: new Map(), ...code },
				...over
			},
			present
		);
		return { ...h, render, revise };
	}

	it('never sends a texture to the image model, and writes every variant', async () => {
		const h = codeHarness({});
		const [r] = await generateEntries(specOf([{ kind: 'texture', recipe: RECIPE }]), h.deps);
		expect(h.requests).toHaveLength(0);
		expect(h.written).toEqual(['out/e0.png', 'out/e0_1.png', 'out/e0_2.png', 'out/e0_3.png']);
		expect(r.outcome).toMatchObject({
			status: 'done',
			codeDrawn: true,
			variants: ['out/e0.png', 'out/e0_1.png', 'out/e0_2.png', 'out/e0_3.png']
		});
	});

	it('still sends sprites to the image model', async () => {
		const h = codeHarness({});
		await generateEntries(specOf([{ kind: 'texture', recipe: RECIPE }, {}]), h.deps);
		expect(h.requests).toHaveLength(1);
	});

	it('fails a texture the recipe stage gave up on, with its reason', async () => {
		const h = codeHarness({ recipeFailures: new Map([['e0', 'layers[0].color: bad']]) });
		const [r] = await generateEntries(specOf([{ kind: 'texture' }]), h.deps);
		expect(r.outcome).toMatchObject({ status: 'failed', reason: 'layers[0].color: bad' });
		expect(h.written).toEqual([]);
	});

	it('skips a texture already on disk', async () => {
		const h = codeHarness({}, {}, ['out/e0.png']);
		const [r] = await generateEntries(specOf([{ kind: 'texture', recipe: RECIPE }]), h.deps);
		expect(r.outcome.status).toBe('skipped');
		expect(h.render).not.toHaveBeenCalled();
	});

	it('revises the recipe once on a no, and keeps the revision', async () => {
		const revised = { base: { ramp: ['#111111', '#eeeeee'] }, layers: [] };
		let n = 0;
		const judge = vi.fn(async () => ({ ok: n++ > 0, reason: 'looks like carpet' }));
		const h = codeHarness(
			{ revise: vi.fn(async () => revised) },
			{ judge: { enabled: true, visionSupported: true, judge } }
		);
		const [r] = await generateEntries(specOf([{ kind: 'texture', recipe: RECIPE }]), h.deps);
		expect(r.outcome).toMatchObject({ status: 'done', attempts: 2, recipe: revised });
		expect(h.render).toHaveBeenCalledTimes(2);
		expect(h.render.mock.calls[1][0]).toBe(revised);
	});

	it('keeps the tiles and marks them rejected after a second no', async () => {
		const judge = vi.fn(async () => ({ ok: false, reason: 'looks like carpet' }));
		const h = codeHarness(
			{ revise: vi.fn(async () => RECIPE) },
			{ judge: { enabled: true, visionSupported: true, judge } }
		);
		const [r] = await generateEntries(specOf([{ kind: 'texture', recipe: RECIPE }]), h.deps);
		expect(r.outcome).toMatchObject({
			status: 'unresolved',
			kept: true,
			reason: 'looks like carpet'
		});
		expect(judge).toHaveBeenCalledTimes(2);
	});

	it('draws the same seed for the same entry, run after run', async () => {
		const a = codeHarness({});
		await generateEntries(specOf([{ kind: 'texture', recipe: RECIPE, id: 'street' }]), a.deps);
		const b = codeHarness({});
		await generateEntries(specOf([{ kind: 'texture', recipe: RECIPE, id: 'street' }]), b.deps);
		expect(a.render.mock.calls[0][1]).toBe(b.render.mock.calls[0][1]);
	});
});
