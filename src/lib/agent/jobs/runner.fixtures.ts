/**
 * Shared mocks and fixtures for the `runner.*.test.ts` files. Test-only: no
 * app code imports this.
 *
 * `vi.mock` is hoisted per test file and cannot live here, so each test file
 * loads this module through `vi.hoisted` and points its mock block at the
 * factories in `mockModules`:
 *
 *   const { mocks, mockModules: m, useRunnerFixtures } = await vi.hoisted(
 *     () => import('./runner.fixtures.ts')
 *   );
 *   vi.mock('@tauri-apps/api/core', () => m.tauriCore());
 *   …
 *   useRunnerFixtures();
 *
 * The state lives in the instance the test file captured, so it survives the
 * `vi.resetModules()` in `freshRunner()`.
 */
/* eslint-disable max-lines -- one module of fixtures for thirteen test files */
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';
import type { EphemeralTurnOptions } from '#lib/agent/runEphemeralTurn.ts';
import { invokeRouter, type InvokeRoute } from '#lib/testing/invoke.ts';

export const mocks = {
	runEphemeralTurn: vi.fn(),
	getJob: vi.fn(),
	createJob: vi.fn(),
	createJobRun: vi.fn(),
	markRunStarted: vi.fn(),
	markRunFinished: vi.fn(),
	markRunStepStarted: vi.fn(),
	markRunStepFinished: vi.fn(),
	setRunEnvironment: vi.fn(),
	setStepStatsProvider: vi.fn(),
	askUserQuestion: vi.fn(),
	invoke: vi.fn()
};

/**
 * The one settings field a test needs to change: the asset job's availability
 * gate reads it, so a run cannot even start without it.
 */
export const settingsState = {
	imageBackendKind: 'none' as string,
	imageComfyCheckpoint: '' as string,
	imageLocalModelId: '' as string,
	codeSubtasks: 'read' as 'off' | 'read' | 'write',
	agentFeedbackEnabled: false
};

/**
 * The image backend, mocked at the module rather than registered.
 *
 * `freshRunner()` resets modules, so the `#lib/image` barrel re-runs and
 * re-registers the real ComfyUI backend — a stub put in the registry by
 * `beforeEach` is clobbered on the next fresh import and the tests end up
 * talking to a backend that tries to reach a server.
 */
export const imageState = {
	kind: 'comfyui' as string,
	generated: [] as Array<Record<string, unknown>>,
	fail: null as Error | null,
	/** Fail the nth generation only, 1-based. The anchor is the first. */
	failNth: 0,
	caps: {
		// One image per entry: the runner tests predate sheets, which
		// generate.test.ts covers.
		transparency: false,
		seamlessTiling: true,
		loras: true,
		maxLoras: 2
	}
};

async function imageModule() {
	// Imported per call: after `resetModules` the runner checks errors against
	// the fresh module's class.
	const { ImageBackendError } = await import('#lib/image/types.ts');
	return {
		resolveImageBackend: () => ({
			kind: imageState.kind,
			capabilities: async () => imageState.caps,
			probe: async () => ({ ok: true, detail: 'stub' }),
			generate: async (req: Record<string, unknown>) => {
				imageState.generated.push(req);
				if (imageState.fail) throw imageState.fail;
				if (imageState.generated.length === imageState.failNth) {
					throw new ImageBackendError('rejected', 'the backend refused this prompt');
				}
				return {
					images: [
						{
							bytes: new Uint8Array([137, 80, 78, 71]),
							mimeType: 'image/png',
							width: req.width,
							height: req.height
						}
					],
					meta: {
						// The RESOLVED seed, as a real backend reports it — the recipe
						// must never record the null we may have sent.
						seed: req.seed ?? 4242,
						model: req.model ?? 'stub.safetensors',
						backend: 'comfyui',
						sampler: { name: 'euler_ancestral', steps: 28, cfg: 7 },
						loras: req.loras ?? [],
						durationMs: 1
					}
				};
			}
		})
	};
}

async function settingsModule(importOriginal: () => Promise<unknown>) {
	return {
		...((await importOriginal()) as Record<string, unknown>),
		getSettings: () => ({
			contextSize: 8192,
			imageBackendKind: settingsState.imageBackendKind,
			imageComfyCheckpoint: settingsState.imageComfyCheckpoint,
			imageLocalModelId: settingsState.imageLocalModelId,
			codeSubtasks: settingsState.codeSubtasks,
			agentFeedbackEnabled: settingsState.agentFeedbackEnabled,
			inferenceBackend: { mode: 'local' as const },
			// What a job inherits when it sets no reasoning policy of its own —
			// the runner records the RESOLVED values with the run.
			thinkingEnabled: true,
			reasoningEffort: 'medium',
			// A planning skill is read through the skills client, which asks which
			// folders it may search.
			skills: { extraDirs: [], disabled: [], autonomous: 'auto', trustedRepos: {} }
		}),
		// Read by resolveBackendDescriptor, which the runner now maps job
		// context-size / vision decisions through, and by the run environment —
		// llama-server ignores the model name, so the GGUF filename is the only
		// thing that identifies what answered.
		getActiveLocalModelFilename: () => 'Qwen3.6-35B-A3B-UD-Q8_K_XL.gguf',
		getApiKeyValue: () => undefined
	};
}

/** The factory behind each `vi.mock` line of a runner test file. */
export const mockModules = {
	tauriCore: () => ({ invoke: mocks.invoke }),
	runEphemeralTurn: () => ({ runEphemeralTurn: mocks.runEphemeralTurn }),
	userQuestion: () => ({ askUserQuestion: mocks.askUserQuestion }),
	jobs: () => ({ getJob: mocks.getJob, createJob: mocks.createJob }),
	jobRuns: () => ({
		createJobRun: mocks.createJobRun,
		markRunStarted: mocks.markRunStarted,
		markRunFinished: mocks.markRunFinished,
		markRunStepStarted: mocks.markRunStepStarted,
		markRunStepFinished: mocks.markRunStepFinished,
		setRunEnvironment: mocks.setRunEnvironment,
		// The runner registers its stats provider at module load; capturing it
		// here is what lets the persistence test call it directly.
		setStepStatsProvider: mocks.setStepStatsProvider
	}),
	image: imageModule,
	settings: settingsModule,
	tools: () => ({ getDisplayLabel: (name: string) => name }),
	approvalOverride: () => ({
		runWithAutoApprove: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
		isAutoApproveActive: () => false
	}),
	inferenceQueue: () => ({
		// Tests for the queue itself live in inferenceQueue.test.ts; here we
		// just want a pass-through so the runner's pipeline scheduling stays
		// observable without the queue's await-ready microtask in the middle.
		withInferenceSlot: async <T>(
			opts: { onAdmitted?: () => void },
			fn: () => Promise<T>
		): Promise<T> => {
			opts.onAdmitted?.();
			return fn();
		}
	})
};

/** Answer `invoke` by command name from `routes`; anything else gets null. */
export function routeInvoke(routes: Record<string, InvokeRoute>) {
	mocks.invoke.mockImplementation(invokeRouter(routes));
}

/**
 * The default `invoke` routes: the guided-planning write-verification sees the
 * files on disk (overview.md exists, the plan dir has a phase file). Tests that
 * exercise a hallucinated/missing write override this.
 */
export function defaultInvokeRoutes(): Record<string, InvokeRoute> {
	return {
		fs_path_exists: true,
		shell_platform_supported: true,
		fs_list_dir: () => ({
			path: '',
			entries: [{ name: 'phase-01-x.md', is_dir: false, size: 1 }],
			truncated: false
		})
	};
}

/** Registers the hooks every runner test file needs. Call at the top level. */
export function useRunnerFixtures() {
	// The first import transforms the runner's whole module graph. On a slow CI
	// runner that alone took most of a test's 5 s, and the first test timed out
	// on Windows. Pay it once here; later imports after resetModules reuse the
	// transformed modules.
	beforeAll(async () => {
		await import('#lib/agent/jobs/runner.svelte.ts');
	}, 60_000);

	beforeEach(() => {
		settingsState.codeSubtasks = 'read';
		settingsState.agentFeedbackEnabled = false;
		mocks.runEphemeralTurn.mockReset();
		mocks.getJob.mockReset();
		mocks.createJob.mockReset().mockResolvedValue(900);
		mocks.createJobRun.mockReset();
		mocks.markRunStarted.mockReset().mockResolvedValue(undefined);
		mocks.markRunFinished.mockReset().mockResolvedValue(undefined);
		mocks.markRunStepStarted.mockReset().mockResolvedValue(undefined);
		mocks.markRunStepFinished.mockReset().mockResolvedValue(undefined);
		// Default: the guided_planning review checkpoint is approved immediately.
		mocks.askUserQuestion.mockReset().mockResolvedValue({ kind: 'selected', labels: ['Approve'] });
		mocks.invoke.mockReset();
		routeInvoke(defaultInvokeRoutes());
		// Default: createJobRun assigns sequential ids starting at 100 so the
		// runner-issued ids never collide with the test's job ids (which start
		// at 1) — easier to spot a "did the runner use the persisted id?" bug.
		let nextId = 100;
		mocks.createJobRun.mockImplementation(async () => nextId++);
	});
}

export function makeJob(overrides: Partial<JobWithSteps> = {}): JobWithSteps {
	return {
		id: 1,
		name: 'Test job',
		description: null,
		working_dir: '/tmp/work',
		auto_approve_tools: true,
		job_type: 'research',
		schedule_kind: 'manual',
		schedule_config: null,
		next_due_at: null,
		created_at: 0,
		updated_at: 0,
		steps: [{ id: 1, ordering: 0, prompt: 'do step 1', deep_research: false }],
		type_config: null,
		model_remote_base_url: null,
		model_remote_api_key: null,
		model_remote_api_key_id: null,
		model_remote_model_id: null,
		model_remote_context_size: null,
		model_remote_vision_supported: null,
		model_advanced: null,
		...overrides
	};
}

export async function freshRunner() {
	vi.resetModules();
	return import('#lib/agent/jobs/runner.svelte.ts');
}

export function tick() {
	return new Promise((r) => setTimeout(r, 0));
}

/** Ticks until the run leaves `running`, for runs with many turns. */
export async function settle(getCurrentRun: () => { status: string } | null) {
	for (let i = 0; i < 300 && getCurrentRun()?.status === 'running'; i++) await tick();
}

/**
 * A `runEphemeralTurn` implementation for guided_planning runs: the outline turn
 * (forceFinalTool === submit_plan_outline) emits the given phases by invoking the
 * runner's onToolStart capture; every other turn returns a clean verifier verdict
 * so the run drives to completion.
 */
export function guidedTurns(
	phases: Array<{ id: string; title: string; depends_on?: string[]; summary: string }>,
	assets?: {
		style: { prompt: string };
		entries: Array<Record<string, unknown>>;
		targetSize?: number;
	}
) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return async (opts: any) => {
		if (opts.forceFinalTool === 'submit_plan_outline') {
			opts.onToolStart?.({ id: 'outline', name: 'submit_plan_outline', arguments: { phases } });
			return { finalText: 'outline submitted' };
		}
		if (opts.forceFinalTool === 'submit_plan_asset_spec') {
			opts.onToolStart?.({
				id: 'assets',
				name: 'submit_plan_asset_spec',
				arguments: assets ?? { style: { prompt: 'flat pixel art' }, entries: [] }
			});
			return { finalText: 'assets submitted' };
		}
		return { finalText: 'PLAN OK' };
	};
}

/** User messages of every phase-write turn the run issued. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function phaseWriteMessages(calls: any[]): string[] {
	return calls
		.map(([o]) => o.userMessage)
		.filter((m: unknown): m is string => typeof m === 'string' && m.includes('write ONLY Phase'));
}

// ---------------------------------------------------------------------------
// Autonomous coding
// ---------------------------------------------------------------------------

/** The phase verification command these runs settle on at preflight. */
export const VERIFY_CMD = 'npm test';

/** A DECISIONS file in the shape preflight writes, so the runner resolves
 *  the phase verification command the way a real run does. */
export const DECISIONS_WITH_VERIFY = [
	'# Coding decisions',
	'',
	'## Verification command',
	'',
	'```',
	VERIFY_CMD,
	'```',
	''
].join('\n');

export function codingJob(over: Partial<JobWithSteps> = {}): JobWithSteps {
	return makeJob({
		job_type: 'autonomous_coding',
		steps: [],
		working_dir: '/repo',
		type_config: JSON.stringify({ plan_dir: 'plan/x/' }),
		...over
	});
}

/** A successful `run_command_capture` result. */
export const COMMAND_OK = { stdout: '', stderr: '', exit_code: 0, duration_ms: 1, killed: false };

/**
 * Git-aware run_command_capture mock; `staged` controls the diff check,
 * `signFails` makes `git commit` fail unless signing is disabled via
 * `-c commit.gpgsign=false` (an expired 1Password authorization), and
 * `verifyFails` fails the phase verification command.
 */
export function wireGit(
	opts: { staged?: boolean; signFails?: boolean; verifyFails?: boolean } = {}
) {
	const commands: string[] = [];
	const ok = COMMAND_OK;
	routeInvoke({
		fs_path_exists: true,
		shell_platform_supported: true,
		// TODO/PROGRESS resume reads → undefined = nothing on disk.
		fs_read_text_full: (args) =>
			String(args?.relPath).includes('DECISIONS') ? DECISIONS_WITH_VERIFY : undefined,
		run_command_capture: (args) => {
			const command = String(args?.command ?? '');
			commands.push(command);
			if (command === VERIFY_CMD) {
				return opts.verifyFails ? { ...ok, exit_code: 1, stdout: '1 test failed' } : { ...ok };
			}
			// `git diff --cached --quiet` exits 1 when changes are staged.
			if (command.includes('--cached')) {
				return { ...ok, exit_code: (opts.staged ?? true) ? 1 : 0 };
			}
			if (command.includes('rev-parse HEAD')) return { ...ok, stdout: 'headhash' };
			if (
				opts.signFails &&
				command.includes('git commit') &&
				!command.includes('commit.gpgsign=false')
			) {
				return { ...ok, exit_code: 128, stderr: 'error: gpg failed to sign the data' };
			}
			return { ...ok };
		}
	});
	return commands;
}

/**
 * A runEphemeralTurn that drives the whole pipeline: preflight ready, a
 * two-item decompose, then a phase build turn that writes a file. `verdict`
 * answers the per-item iteration turns, which only REPAIR items reach.
 */
export function codingTurns(verdict: (itemId: string, attempt: number) => 'done' | 'failed') {
	const attempts: Record<string, number> = {};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return async (opts: any) => {
		if (opts.forceFinalTool === 'submit_preflight') {
			opts.onToolStart?.({
				id: 'p',
				name: 'submit_preflight',
				arguments: { ready: true, decisions_resolved: 2 }
			});
			return { finalText: 'ready' };
		}
		if (opts.forceFinalTool === 'submit_task_list') {
			opts.onToolStart?.({
				id: 't',
				name: 'submit_task_list',
				arguments: {
					items: [
						{ title: 'One', description: 'first thing' },
						{ title: 'Two', description: 'second thing' }
					]
				}
			});
			return { finalText: 'list' };
		}
		if (opts.forceFinalTool === 'submit_phase_result') {
			opts.onToolStart?.({
				id: 'w',
				name: 'fs_write_text',
				arguments: { path: 'src/app.ts' }
			});
			opts.onToolStart?.({
				id: 'ph',
				name: 'submit_phase_result',
				arguments: { note: 'phase built' }
			});
			return { finalText: 'phase' };
		}
		if (opts.forceFinalTool === 'submit_iteration_result') {
			const id = /checklist item: ([\w.]+)\./.exec(opts.userMessage)?.[1] ?? '??';
			attempts[id] = (attempts[id] ?? 0) + 1;
			opts.onToolStart?.({
				id: 'i',
				name: 'submit_iteration_result',
				arguments: {
					item_id: id,
					status: verdict(id, attempts[id]),
					note: `attempt ${attempts[id]}`
				}
			});
			return { finalText: 'iter' };
		}
		return { finalText: 'report written' }; // finalize
	};
}

// ---------------------------------------------------------------------------
// Asset generation
// ---------------------------------------------------------------------------

export const SPEC_PATH = 'assets/haruspex-assets.json';
export const ANCHOR_IMAGE = 'assets/haruspex-anchor.png';
export const ANCHOR_RECIPE = 'assets/haruspex-anchor.json';
export const PALETTE = [0x11111111, 0x22222222, 0x33333333];
/** A real content hash shape: the image cache rejects anything else. */
export const ANCHOR_HASH = 'a'.repeat(64);
/** Every request the stub backend was asked for, in order. */
export const generated = imageState.generated;
/** The anchor's prompt is the only one asking for a sheet of sprites. */
const isAnchor = (g: Record<string, unknown>) => String(g.prompt).includes('A sprite sheet');
/** Just the anchor sheets — the entries share the same list. */
export const anchorCalls = () => generated.filter(isAnchor);
export const entryCalls = () => generated.filter((g) => !isAnchor(g));
export const turnsOfKind = (kind: string) =>
	mocks.runEphemeralTurn.mock.calls.filter(
		(call) => (call[0] as EphemeralTurnOptions & { turnKind?: string })?.turnKind === kind
	);

/**
 * The asset-generation describe's hooks: a fresh stub backend, and ComfyUI
 * selected in Settings so the availability gate lets a run start.
 */
export function useAssetBackend() {
	beforeEach(() => {
		imageState.kind = 'comfyui';
		imageState.generated.length = 0;
		imageState.fail = null;
		imageState.failNth = 0;
		imageState.caps = {
			transparency: false,
			seamlessTiling: true,
			loras: true,
			maxLoras: 2
		};
		settingsState.imageBackendKind = 'comfyui';
		settingsState.imageComfyCheckpoint = '';
		settingsState.imageLocalModelId = '';
	});
	afterEach(() => {
		settingsState.imageBackendKind = 'none';
	});
}

/** Shaped like the Rust default, which is what the real command returns. */
export function profileFixture() {
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
		by_kind: {}
	};
}

export function goodSpec(entries = 2, over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		version: 1,
		style: { prompt: 'flat pixel art' },
		anchor: { image: ANCHOR_IMAGE, recipe: ANCHOR_RECIPE },
		normalize: profileFixture(),
		entries: Array.from({ length: entries }, (_, i) => ({
			id: `thing_${i}`,
			kind: i === 0 ? 'texture' : 'sprite',
			prompt: 'a thing',
			out: `assets/generated/thing_${i}.png`
		})),
		...over
	});
}

/** A committed recipe, as `tryReuse` expects to find one. */
export function goodRecipe(over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		version: 1,
		prompt: 'a reference sheet',
		negativePrompt: 'photo',
		seed: 99,
		backend: 'comfyui',
		model: 'pinned.safetensors',
		sampler: { name: 'euler', steps: 20, cfg: 6 },
		loras: [],
		size: 1024,
		palette: PALETTE,
		createdAt: '2026-01-01T00:00:00.000Z',
		...over
	});
}

export function assetJob(over: Record<string, unknown> = {}): JobWithSteps {
	return makeJob({
		job_type: 'asset_generation',
		steps: [],
		working_dir: '/repo',
		type_config: JSON.stringify({ spec_path: SPEC_PATH, ...over })
	});
}

const IMAGE_MODELS = [
	{
		id: 'sd15',
		filename: 'v1-5-pruned-emaonly-fp16.safetensors',
		description: 'Stable Diffusion 1.5',
		license: 'CreativeML OpenRAIL-M — commercial use allowed.',
		native_edge: 512
	},
	{
		id: 'sdxl',
		filename: 'sd_xl_base_1.0.safetensors',
		description: 'Stable Diffusion XL 1.0',
		license: 'CreativeML OpenRAIL++-M — commercial use allowed.',
		native_edge: 1024
	}
];

const PNG_BYTES = [137, 80, 78, 71];
const IMAGE_STATS = { alpha: 0.5, entropy: 3, palette_distance: 0.01 };

/**
 * `spec` null = no spec file on disk. `anchor` supplies a committed anchor
 * so a test can exercise the reuse path.
 */
export function wireFs(
	spec: string | null,
	anchor?: { recipe: string | null },
	present: string[] = [],
	checks: { passed: boolean; failed: string[] } = { passed: true, failed: [] },
	/** Share of the anchor palette in one hue bucket; >0.6 is unusable. */
	spread = 0.3
) {
	const written: Array<{ relPath: string; content: string }> = [];
	const wroteBytes: string[] = [];
	const rel = (args?: Record<string, unknown>) => String(args?.relPath ?? '');
	routeInvoke({
		shell_platform_supported: true,
		fs_read_text_full: (args) => {
			if (rel(args) === SPEC_PATH && spec !== null) return spec;
			if (rel(args) === ANCHOR_RECIPE && anchor?.recipe != null) return anchor.recipe;
			throw new Error('not found');
		},
		fs_read_bytes: (args) => {
			if (rel(args) === ANCHOR_IMAGE && anchor) return [...PNG_BYTES];
			// Anything this run wrote can be read back — the contact sheet
			// tiles the files the generation stage just produced.
			if (wroteBytes.includes(rel(args))) return [...PNG_BYTES];
			throw new Error('not found');
		},
		fs_write_text: (args) => {
			written.push({ relPath: rel(args), content: String(args?.content) });
			return undefined;
		},
		fs_write_bytes: (args) => {
			wroteBytes.push(rel(args));
			return undefined;
		},
		fs_path_exists: (args) => present.includes(rel(args)),
		image_effective_profile: (args) => args?.profile,
		image_normalize: () => ({ bytes: [1, 2, 3, 4], stats: { ...IMAGE_STATS } }),
		image_check: () => ({
			passed: checks.passed,
			stats: { ...IMAGE_STATS },
			failed: checks.failed
		}),
		image_contact_sheet: () => [...PNG_BYTES],
		texture_validate: () => undefined,
		texture_render: (args) =>
			Array.from({ length: Number(args?.variants ?? 1) }, () => [...PNG_BYTES]),
		texture_transition_validate: () => undefined,
		texture_transition_render: () => [...PNG_BYTES],
		texture_transition_preview: () => [...PNG_BYTES],
		image_models: () => structuredClone(IMAGE_MODELS),
		image_default_profile: () => profileFixture(),
		image_extract_palette: PALETTE,
		image_palette_spread: () => ({ dominant_fraction: spread, buckets_used: 6, ok: spread <= 0.6 }),
		image_store_bytes: ANCHOR_HASH
	});
	return Object.assign(written, { bytes: wroteBytes });
}
