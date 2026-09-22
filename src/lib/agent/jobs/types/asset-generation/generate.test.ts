import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateEntries, escapesWorkdir, type GenerateDeps } from './generate';
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
		reference_strength: 0.6,
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

const FULL: ImageBackendCapabilities = {
	referenceConditioning: true,
	seamlessTiling: true,
	loras: true,
	maxLoras: 2
};

const STATS = { alpha: 0.5, entropy: 3, palette_distance: 0.01 };

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
		anchor: new Uint8Array([1, 2, 3]),
		concurrency: 1,
		maxEdge: 1024,
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
	invoke.mockReset().mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		// A texture's resolved profile really differs from the base — otherwise
		// "did it use the resolver?" is unobservable and the test is vacuous.
		if (cmd === 'image_effective_profile') {
			const base = args?.profile as NormalizeProfile;
			return args?.kind === 'texture' ? { ...base, upscale: 8, reference_strength: 0.9 } : base;
		}
		if (cmd === 'image_normalize') return { bytes: [1, 2, 3, 4], stats: STATS };
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
		expect(r.stats).toBeNull();
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
		expect(h.requests[1].referenceStrength).toBe(0.9);
	});

	it('normalizes with the resolved profile too', async () => {
		await generateEntries(specOf([{ kind: 'texture' }]), harness().deps);
		const call = invoke.mock.calls.find(([cmd]) => cmd === 'image_normalize');
		expect((call![1].profile as NormalizeProfile).reference_strength).toBe(0.9);
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
