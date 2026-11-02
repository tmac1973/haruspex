/**
 * The asset-generation run, driven whole.
 *
 * Only the module boundaries are stand-ins: Tauri's `invoke` (an in-memory
 * working directory plus the Rust image commands), the image backend, the
 * settings, and the runner's context (whose `runJobTurn` is the model). Every
 * stage between them — spec, anchor, generation, report, handoff — is the real
 * code, so each test reads what a run leaves behind: its steps, the files in
 * the working directory, and the coding job it hands on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invokeCalls, invokeRouter } from '#lib/testing/invoke.ts';
import { renderAssetSpec } from '#lib/assets/spec/write.ts';
import { parseAssetSpec } from '#lib/assets/spec/parse.ts';
import { ImageBackendError } from '#lib/image/types.ts';
import type { ImageBackendCapabilities, ImageRequest, ImageResult } from '#lib/image/types.ts';
import type { AssetSpec, NormalizeProfile } from '#lib/assets/spec/types.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';
import type { RunStepState, RunTrigger } from '#lib/agent/jobs/runner.svelte.ts';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import type { EphemeralTurnResult } from '#lib/agent/runEphemeralTurn.ts';
import { ANCHOR, GENERATE, HANDOFF, REPORT, SPEC, reportPathFor } from './pipeline';
import { runAssetGenerationPipeline } from './pipeline';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

/** The image backend the run reaches through `#lib/image/index.ts`. */
const image = vi.hoisted(() => ({
	kind: 'comfyui' as string,
	caps: null as unknown as ImageBackendCapabilities,
	generate: null as unknown as (req: ImageRequest) => Promise<ImageResult>
}));
vi.mock('#lib/image/index.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/image/index.ts')>()),
	resolveImageBackend: () => ({ kind: image.kind }),
	routedImageBackend: () => ({
		kind: image.kind,
		capabilities: async () => image.caps,
		probe: async () => ({ ok: true }),
		generate: (req: ImageRequest) => image.generate(req)
	})
}));

// No image models configured: nothing names a model, so the report says so.
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: { imageModels: [], imageLocalModelPath: '' },
		overDefaults: true
	})
);

const SPEC_PATH = 'assets/haruspex-assets.json';
const ANCHOR_IMAGE = 'assets/haruspex-anchor.png';
const ANCHOR_RECIPE = 'assets/haruspex-anchor.json';
const PALETTE = [0x112233ff, 0x445566ff];

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
		checks: { alpha_min: 0.05, alpha_max: 0.95, entropy_min: 1, palette_distance_max: 0.15 },
		by_kind: {},
		...over
	} as NormalizeProfile;
}

function makeSpec(over: Partial<AssetSpec> = {}): AssetSpec {
	return {
		version: 1,
		style: { prompt: 'flat pixel art, bold dark outline' },
		anchor: { image: ANCHOR_IMAGE, recipe: ANCHOR_RECIPE },
		normalize: profile({ palette: PALETTE }),
		entries: [
			{ id: 'iron_sword', kind: 'sprite', prompt: 'an iron sword', out: 'a/sword.png' },
			{ id: 'coin', kind: 'icon', prompt: 'a gold coin', out: 'a/coin.png' }
		],
		...over
	} as AssetSpec;
}

const STATS = { alpha: 0.4, entropy: 3, palette_distance: 0.01 };

/** The working directory, as the fs commands see it. */
let files: Map<string, string | Uint8Array>;
/** Every path written, in order — a rewrite with the same text still counts. */
let written: string[];
/** The catalogue `image_models` answers with. */
let catalogue: unknown[];

function text(rel: string): string | undefined {
	const v = files.get(rel);
	return typeof v === 'string' ? v : undefined;
}

function specOnDisk(): AssetSpec {
	const parsed = parseAssetSpec(text(SPEC_PATH) ?? '');
	if ('errors' in parsed) throw new Error(parsed.errors.join('; '));
	return parsed.spec;
}

function routes() {
	const missing = (rel: unknown) => {
		throw `No such file: ${String(rel)}`;
	};
	return invokeRouter({
		fs_path_exists: (a) => files.has(a!.relPath as string),
		fs_read_text_full: (a) => text(a!.relPath as string) ?? missing(a!.relPath),
		fs_read_bytes: (a) => {
			const v = files.get(a!.relPath as string);
			return v instanceof Uint8Array ? Array.from(v) : missing(a!.relPath);
		},
		fs_write_text: (a) => {
			written.push(a!.relPath as string);
			files.set(a!.relPath as string, a!.content as string);
		},
		fs_write_bytes: (a) => {
			written.push(a!.relPath as string);
			files.set(a!.relPath as string, new Uint8Array(a!.bytes as number[]));
		},
		image_models: () => catalogue,
		image_default_profile: () => profile(),
		image_effective_profile: (a) => a!.profile,
		image_normalize: () => ({ bytes: [9, 9, 9], stats: STATS }),
		image_check: () => ({ passed: true, stats: STATS, failed: [] }),
		image_extract_palette: () => PALETTE,
		image_palette_spread: () => ({ dominant_fraction: 0.2, buckets_used: 6, ok: true }),
		image_contact_sheet: () => [7, 7, 7],
		db_create_job: () => 41
	});
}

function imageResult(seed = 1234): ImageResult {
	return {
		images: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', width: 64, height: 64 }],
		meta: {
			seed,
			model: 'test-model',
			backend: 'comfyui',
			sampler: { name: 'euler', steps: 20, cfg: 7 },
			loras: [],
			durationMs: 5
		}
	};
}

/** A model turn: what tool the model calls, if any. */
type Turn = (opts: Parameters<JobRunContext['runJobTurn']>[0]) => ResolvedToolCall | null;

interface Harness {
	ctx: JobRunContext;
	steps: Array<Partial<RunStepState>>;
	finished: { status: string; error: string | null } | null;
	turns: Array<Parameters<JobRunContext['runJobTurn']>[0]>;
	chained: number[];
}

function harness(opts: {
	config?: Record<string, unknown>;
	workingDir?: string | null;
	trigger?: RunTrigger;
	vision?: boolean;
	turn?: Turn;
	startChainedRun?: (jobId: number) => number | null;
}): Harness {
	const h: Harness = {
		steps: [{}, {}, {}, {}, {}],
		finished: null,
		turns: [],
		chained: [],
		ctx: null as unknown as JobRunContext
	};
	let current = 0;
	const job = {
		id: 7,
		name: 'Dungeon art',
		working_dir: opts.workingDir === undefined ? '/proj' : opts.workingDir,
		type_config: JSON.stringify({ run_mode: 'unattended', ...opts.config }),
		steps: []
	} as unknown as JobWithSteps;
	h.ctx = {
		job,
		runId: 99,
		abort: new AbortController(),
		trigger: opts.trigger ?? 'manual',
		runJobTurn: async (turnOpts) => {
			h.turns.push(turnOpts);
			const call = opts.turn?.(turnOpts) ?? null;
			if (call) turnOpts.onToolStart?.(call);
			return {} as EphemeralTurnResult;
		},
		patchStep: (i, patch) => Object.assign(h.steps[i], patch),
		buildStreamCallbacks: () => ({}),
		setCurrentStepIndex: (i) => (current = i),
		liveStepIndex: () => current,
		stepAuthored: () => '',
		isLive: () => true,
		contextSize: () => 32768,
		visionSupported: () => opts.vision ?? false,
		finalizeRun: (status, error) => (h.finished = { status, error }),
		onSettled: () => {},
		startChainedRun: async (jobId) => {
			h.chained.push(jobId);
			return opts.startChainedRun ? opts.startChainedRun(jobId) : 501;
		}
	};
	return h;
}

/** A spec on disk with its committed anchor, so the anchor stage reuses it. */
function seedProject(spec: AssetSpec = makeSpec()) {
	files.set(SPEC_PATH, renderAssetSpec(spec));
	files.set(ANCHOR_IMAGE, new Uint8Array([5, 5, 5]));
	files.set(ANCHOR_RECIPE, JSON.stringify({ version: 1, palette: PALETTE }));
}

function call(name: string, args: Record<string, unknown>): ResolvedToolCall {
	return { id: 'c1', name, arguments: args };
}

beforeEach(() => {
	vi.clearAllMocks();
	files = new Map();
	written = [];
	catalogue = [];
	image.kind = 'comfyui';
	image.caps = { transparency: false, seamlessTiling: false, loras: false, maxLoras: 0 };
	image.generate = async () => imageResult();
	tauri.invoke.mockImplementation(routes());
});

describe('reportPathFor', () => {
	it('puts the report beside the spec', () => {
		expect(reportPathFor('art/spec.json')).toBe('art/REPORT-assets.md');
		expect(reportPathFor('spec.json')).toBe('REPORT-assets.md');
	});
});

describe('a run over an existing spec', () => {
	it('generates every entry, writes the report and contact sheet, and succeeds', async () => {
		seedProject();
		const requests: ImageRequest[] = [];
		image.generate = async (req) => {
			requests.push(req);
			return imageResult();
		};
		const h = harness({});

		await runAssetGenerationPipeline(h.ctx);

		expect(h.finished).toEqual({ status: 'succeeded', error: null });
		expect(h.steps.map((s) => s.status)).toEqual([
			'succeeded',
			'succeeded',
			'succeeded',
			'succeeded',
			'succeeded'
		]);
		expect(h.steps[SPEC].output).toBe(`${SPEC_PATH} — 2 asset(s): 1 sprite, 1 icon`);
		expect(h.steps[ANCHOR].output).toContain(`Reused the committed anchor at ${ANCHOR_IMAGE}`);
		expect(h.steps[ANCHOR].output).toContain('Palette: 2 colour(s).');
		expect(h.steps[GENERATE].output).toContain('2 generated, 0 already present, 0 failed of 2.');
		// One request per entry, each prompt carrying its own subject.
		expect(requests.map((r) => r.prompt)).toEqual([
			expect.stringContaining('an iron sword'),
			expect.stringContaining('a gold coin')
		]);
		// The normalized image is what lands on disk, not the raw generation.
		expect(files.get('a/sword.png')).toEqual(new Uint8Array([9, 9, 9]));
		expect(files.get('a/coin.png')).toEqual(new Uint8Array([9, 9, 9]));
		expect(files.get('assets/contact-sheet.png')).toEqual(new Uint8Array([7, 7, 7]));
		expect(text('assets/REPORT-assets.md')).toContain('# Asset report');
		expect(h.steps[REPORT].output).toBe(
			'Every asset passed.\n' +
				'Report: assets/REPORT-assets.md, contact sheet: assets/contact-sheet.png'
		);
		expect(h.steps[HANDOFF].output).toBe(
			'Nothing chained — this run carried no coding configuration.'
		);
		// Nothing changed in the user's spec, so it is not rewritten.
		expect(written).not.toContain(SPEC_PATH);
	});

	it('skips entries already on disk and generates nothing for them', async () => {
		seedProject();
		files.set('a/sword.png', new Uint8Array([4]));
		files.set('a/coin.png', new Uint8Array([4]));
		const requests: ImageRequest[] = [];
		image.generate = async (req) => {
			requests.push(req);
			return imageResult();
		};
		const h = harness({});

		await runAssetGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('succeeded');
		expect(requests).toEqual([]);
		expect(files.get('a/sword.png')).toEqual(new Uint8Array([4]));
		expect(h.steps[GENERATE].output).toContain('0 generated, 2 already present, 0 failed of 2.');
	});

	it('refuses a spec it cannot parse, and leaves the file alone', async () => {
		files.set(SPEC_PATH, '{ not json');
		const h = harness({});

		await runAssetGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('failed');
		expect(h.finished?.error).toContain(`The spec at ${SPEC_PATH} could not be read`);
		expect(h.steps[SPEC]).toMatchObject({ status: 'failed' });
		expect(text(SPEC_PATH)).toBe('{ not json');
	});

	it('refuses a spec that fails validation', async () => {
		seedProject(
			makeSpec({ entries: [{ id: 'evil', kind: 'sprite', prompt: 'x', out: '../evil.png' }] })
		);
		const h = harness({});

		await runAssetGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('failed');
		expect(h.finished?.error).toContain(`The spec at ${SPEC_PATH} has problems`);
		expect(h.finished?.error).toContain('evil');
	});

	it("rewrites the spec at the job's asset size, and says so", async () => {
		seedProject();
		const h = harness({ config: { target_size: 64 } });

		await runAssetGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('succeeded');
		expect(specOnDisk().normalize.target_size).toBe(64);
		expect(h.steps[SPEC].output).toContain('Asset size changed from 32 to 64 px to match the job.');
	});
});

describe('the run refuses to start', () => {
	it('without a working directory', async () => {
		const h = harness({ workingDir: null });

		await runAssetGenerationPipeline(h.ctx);

		expect(h.finished).toEqual({
			status: 'failed',
			error: 'No working directory — the job needs somewhere to write assets.'
		});
	});

	it('when no image backend is configured any more', async () => {
		seedProject();
		image.kind = 'none';
		const h = harness({});

		await runAssetGenerationPipeline(h.ctx);

		expect(h.finished).toEqual({
			status: 'failed',
			error: 'No image backend configured — Settings → Image.'
		});
		expect(files.has('a/sword.png')).toBe(false);
	});

	it('with no spec and nothing to write one from', async () => {
		const h = harness({});

		await runAssetGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('failed');
		expect(h.finished?.error).toContain(`No spec at ${SPEC_PATH} and nothing to write one from`);
	});
});

describe('deriving a spec from a description', () => {
	const payload = {
		style: { prompt: 'chunky pixel art' },
		entries: [{ title: 'Iron sword', kind: 'sprite', prompt: 'an iron sword' }]
	};

	it('asks again with the problem quoted, then writes the spec it gets', async () => {
		let n = 0;
		const h = harness({
			config: { description: 'A dungeon crawler' },
			// The first turn ends without calling the tool.
			turn: (o) =>
				o.turnKind === 'spec.derive' && n++ > 0 ? call('submit_asset_spec', payload) : null
		});

		await runAssetGenerationPipeline(h.ctx);

		const derive = h.turns.filter((t) => t.turnKind === 'spec.derive');
		expect(derive).toHaveLength(2);
		expect(derive[0].systemPrompt).toContain('A dungeon crawler');
		expect(derive[1].userMessage).toContain('No spec was submitted — call the tool.');
		const written = specOnDisk();
		expect(written.style.prompt).toBe('chunky pixel art');
		expect(written.entries.map((e) => e.id)).toEqual(['iron_sword']);
		expect(h.steps[SPEC].output).toContain(`Wrote ${SPEC_PATH} — 1 asset(s): 1 sprite`);
		expect(h.steps[SPEC].output).toContain('Style: chunky pixel art');
		expect(h.finished?.status).toBe('succeeded');
	});

	it('fails the stage after two unusable answers, writing nothing', async () => {
		const h = harness({ config: { description: 'A dungeon crawler' } });

		await runAssetGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('failed');
		expect(h.finished?.error).toContain('Could not write a usable spec after 2 attempts');
		expect(h.steps[SPEC].status).toBe('failed');
		expect(files.has(SPEC_PATH)).toBe(false);
	});
});

describe('the style anchor', () => {
	it('is generated when none is committed, and its palette is saved into the spec', async () => {
		files.set(SPEC_PATH, renderAssetSpec(makeSpec({ normalize: profile() })));
		const h = harness({});

		await runAssetGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('succeeded');
		expect(files.get(ANCHOR_IMAGE)).toEqual(new Uint8Array([1, 2, 3]));
		expect(JSON.parse(text(ANCHOR_RECIPE)!)).toMatchObject({ seed: 1234, palette: PALETTE });
		expect(specOnDisk().normalize.palette).toEqual(PALETTE);
		expect(h.steps[ANCHOR].output).toContain(
			`Generated a style anchor in 1 attempt(s) → ${ANCHOR_IMAGE}`
		);
		expect(h.steps[ANCHOR].output).toContain('Accepted automatically — nobody saw it.');
	});
});

describe('entries that do not come out', () => {
	it('reports a backend refusal as missing and hands the gap to the coding run', async () => {
		seedProject();
		image.generate = async (req) => {
			if (req.prompt.includes('gold coin')) throw new ImageBackendError('rejected', 'bad prompt');
			return imageResult();
		};
		const h = harness({ config: { coding_run: { plan_dir: 'plan' } }, trigger: 'chained' });

		await runAssetGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('succeeded');
		expect(files.has('a/coin.png')).toBe(false);
		expect(h.steps[GENERATE].output).toContain('1 generated, 0 already present, 1 failed of 2.');
		expect(h.steps[REPORT].output).toMatch(
			/^1 asset\(s\) could not be produced — see assets\/REPORT-assets\.md\./
		);
		const [created] = invokeCalls(tauri.invoke, 'db_create_job');
		const input = created!.input as Record<string, unknown>;
		expect(input).toMatchObject({
			name: 'Dungeon art — coding',
			job_type: 'autonomous_coding',
			working_dir: '/proj',
			parent_job_id: 7,
			parent_run_id: 99
		});
		expect(input.description).toContain('NOT on disk: coin.');
		expect(JSON.parse(input.type_config as string)).toEqual({
			plan_dir: 'plan',
			asset_spec_path: SPEC_PATH,
			missing_assets: ['coin']
		});
		expect(h.chained).toEqual([41]);
		expect(h.steps[HANDOFF].output).toContain(
			`Started coding job 41 (run 501) against ${SPEC_PATH}.`
		);
	});

	it('keeps the best attempt of an entry the judge turns down, and marks it in the spec', async () => {
		seedProject(makeSpec({ entries: [makeSpec().entries[0]] }));
		const h = harness({
			config: { max_attempts: 2 },
			vision: true,
			turn: (o) =>
				o.turnKind === 'asset.judge'
					? call('submit_asset_judgement', { ok: false, reason: 'Wrong outline colour.' })
					: null
		});

		await runAssetGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('succeeded');
		// Both attempts were judged against the anchor and the asset.
		const judged = h.turns.filter((t) => t.turnKind === 'asset.judge');
		expect(judged).toHaveLength(2);
		expect(judged[0].history?.[0].content).toHaveLength(2);
		expect(files.get('a/sword.png')).toEqual(new Uint8Array([9, 9, 9]));
		expect(specOnDisk().entries[0].rejected).toContain('Wrong outline colour.');
		expect(h.steps[REPORT].output).toContain('Every asset is on disk.');
		expect(h.steps[REPORT].output).toContain(
			'1 kept despite failing their checks — marked for Review assets.'
		);
	});
});

describe('the handoff', () => {
	it('starts nothing for a run started by hand with the handoff off', async () => {
		seedProject();
		const h = harness({ config: { coding_run: {}, hand_off: false } });

		await runAssetGenerationPipeline(h.ctx);

		expect(h.steps[HANDOFF].output).toBe(
			'Nothing chained — this run was started by hand, with the coding handoff off.'
		);
		expect(invokeCalls(tauri.invoke, 'db_create_job')).toEqual([]);
	});

	it('still succeeds when the coding run cannot be started', async () => {
		seedProject();
		const h = harness({ config: { coding_run: {} }, startChainedRun: () => null });

		await runAssetGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('succeeded');
		expect(h.steps[HANDOFF].output).toContain('Created coding job 41, but it could not be started');
	});

	it('still succeeds when the coding job cannot be created', async () => {
		seedProject();
		tauri.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
			if (cmd === 'db_create_job') throw 'db locked';
			return routes()(cmd, args as Record<string, unknown>);
		});
		const h = harness({ config: { coding_run: {} } });

		await runAssetGenerationPipeline(h.ctx);

		expect(h.finished?.status).toBe('succeeded');
		expect(h.steps[HANDOFF].output).toBe('Could not create the coding job — nothing was started.');
		expect(h.chained).toEqual([]);
	});
});

describe('licensing in the report', () => {
	it("names the catalogue's licence when the spec's model is one Haruspex knows", async () => {
		seedProject(makeSpec({ style: { prompt: 'pixel art', model: 'ming.gguf' } }));
		catalogue = [
			{
				id: 'ming',
				filename: 'ming.gguf',
				license: 'MIT',
				description: 'Ming-Image',
				native_edge: 1024
			}
		];
		const h = harness({});

		await runAssetGenerationPipeline(h.ctx);

		expect(text('assets/REPORT-assets.md')).toContain('Model: **Ming-Image** — MIT');
	});

	it('says the licence is unknown for a model it cannot place', async () => {
		seedProject();
		const h = harness({});

		await runAssetGenerationPipeline(h.ctx);

		expect(text('assets/REPORT-assets.md')).toContain(
			"Model: **the backend's configured default** — licence unknown."
		);
	});
});

describe('cancellation', () => {
	it('marks the live step and the run cancelled, with no error', async () => {
		seedProject();
		const h = harness({});
		image.generate = async () => {
			h.ctx.abort.abort();
			throw new DOMException('Aborted', 'AbortError');
		};

		await runAssetGenerationPipeline(h.ctx);

		expect(h.finished).toEqual({ status: 'cancelled', error: null });
		expect(h.steps[GENERATE].status).toBe('cancelled');
		expect(files.has('assets/REPORT-assets.md')).toBe(false);
	});
});
