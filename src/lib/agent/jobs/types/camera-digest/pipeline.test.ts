import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';
import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
import type { CameraEvent } from '#lib/ipc/gen/CameraEvent.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/jobRuns.svelte.ts', () => ({
	markRunStarted: vi.fn(async () => {}),
	markRunStepStarted: vi.fn(async () => {}),
	markRunStepFinished: vi.fn(async () => {})
}));

// The camera tools, registered as a job turn would find them.
import '#lib/agent/tools/camera.ts';
import '#lib/agent/tools/camera-log.ts';
import { executeTool, getToolSchemas } from '#lib/agent/tools/registry.ts';
import { ASK_IN_JOB, NOT_LOCAL } from '#lib/agent/tools/_cameraGate.ts';
import { runWithAutoApprove } from '#lib/stores/approvalOverride.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import { defaultWatcherConfig, updateSettings } from '#lib/stores/settings.ts';
import { cameraDigestJobType } from './definition';
import {
	cameraDigestDefaults,
	cameraDigestUsable,
	parseCameraDigestConfig,
	type CameraDigestConfig
} from './config';
import {
	NOTHING_LOGGED,
	NO_VISION,
	PER_CAMERA,
	digestToolAllowlist,
	parseDigest,
	periodStart,
	runCameraDigestPipeline,
	type CameraDigestResult
} from './pipeline';

function camera(id: string, name: string, permission: 'ask' | 'allow'): CameraConfig {
	return {
		id,
		name,
		source: {
			kind: 'rtsp',
			url: 'rtsp://192.168.1.50/ch0',
			substreamUrl: null,
			username: '',
			passwordRef: null
		},
		permission,
		ptz: 'none',
		onvif: null,
		watcher: { ...defaultWatcherConfig, enabled: true },
		caps: { hasAudio: true, width: 1920, height: 1080, videoCodec: 'h264' }
	};
}

const KITCHEN = camera('cam-1', 'Kitchen', 'allow');
const PORCH = camera('cam-2', 'Porch', 'ask');
const NOW = new Date(2026, 10, 12, 19, 0).getTime();

function event(id: number, cameraId: string, startedAt: number): CameraEvent {
	return {
		id,
		cameraId,
		startedAt,
		endedAt: startedAt + 4_000,
		trigger: 'both',
		levelDb: -30,
		transcript: `words ${id}`,
		caption: `caption ${id}`,
		captionStatus: 'done',
		hasThumb: true
	};
}

let log: CameraEvent[] = [];
let runs: { id: number; status: string; started_at: number | null; queued_at: number }[] = [];

afterEach(() => {
	vi.useRealTimers();
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'], now: NOW });
	log = [event(1, 'cam-1', NOW - 3_600_000), event(2, 'cam-2', NOW - 1_800_000)];
	runs = [];
	updateSettings({ cameras: [KITCHEN, PORCH], cameraTrustedServers: [] });
	vi.mocked(invoke).mockReset();
	vi.mocked(invoke).mockImplementation(async (cmd, args) => {
		const a = (args ?? {}) as Record<string, number | string | undefined>;
		if (cmd === 'camera_events_list') {
			return log
				.filter((e) => !a.cameraId || e.cameraId === a.cameraId)
				.filter((e) => a.since === undefined || e.startedAt >= (a.since as number))
				.sort((x, y) => y.startedAt - x.startedAt)
				.slice(0, a.limit as number);
		}
		if (cmd === 'db_list_job_runs') return runs;
		if (cmd === 'camera_snapshot') return 'data:image/jpeg;base64,AAAA';
		throw new Error(`unexpected invoke: ${cmd}`);
	});
});

interface TurnSeen {
	userMessage: string;
	toolAllowlist?: Iterable<string>;
	visionSupported?: boolean;
	interactive?: boolean;
}

function harness(
	config: Partial<CameraDigestConfig>,
	opts: {
		replies?: string[];
		vision?: boolean;
		job?: Partial<JobWithSteps>;
		onTurn?: (turn: TurnSeen) => Promise<void>;
	} = {}
) {
	const replies = [...(opts.replies ?? [])];
	const h = {
		result: undefined as CameraDigestResult | undefined,
		finished: null as { status: string; error: string | null } | null,
		turns: [] as TurnSeen[],
		steps: {} as Record<number, Record<string, unknown>>
	};
	const job = {
		id: 4,
		name: 'Kitchen evening',
		type_config: JSON.stringify({ ...cameraDigestDefaults(), ...config }),
		model_remote_base_url: null,
		...opts.job
	} as unknown as JobWithSteps;
	const ctx = {
		job,
		runId: 9,
		abort: new AbortController(),
		trigger: 'scheduled',
		runJobTurn: vi.fn(async (turn: TurnSeen) => {
			h.turns.push(turn);
			await opts.onTurn?.(turn);
			const text = replies.shift() ?? '';
			return { finalText: text, rawText: text };
		}),
		patchStep: (i: number, patch: Record<string, unknown>) => {
			h.steps[i] = { ...h.steps[i], ...patch };
		},
		buildStreamCallbacks: () => ({}),
		setCurrentStepIndex: () => {},
		liveStepIndex: () => 0,
		stepAuthored: () => '',
		isLive: () => true,
		contextSize: () => 8192,
		visionSupported: () => opts.vision ?? true,
		describeModel: () => ({ label: 'Settings default', vision: true, contextSize: 8192 }),
		finalizeRun: (status: string, error: string | null) => (h.finished = { status, error }),
		onSettled: () => {},
		startChainedRun: async () => null,
		setResult: async (value: unknown) => {
			h.result = value as CameraDigestResult;
		}
	} as unknown as JobRunContext;
	return { h, ctx };
}

const REPLY =
	'{"summary":"A parcel came.","highlights":[{"time":"18:00","camera":"Kitchen","text":"A box was left."}]}';

describe('camera digest config', () => {
	it('round-trips through the job row, trimming the focus', () => {
		const def = cameraDigestJobType;
		const config = {
			cameras: ['cam-1'],
			period: 'today',
			include_snapshot: true,
			focus: '  people and deliveries  '
		};
		const json = def.configToJson(config)!;
		expect(def.configFromJob(json)).toEqual({ ...config, focus: 'people and deliveries' });
	});

	it('takes defaults for anything missing or malformed', () => {
		expect(parseCameraDigestConfig(null)).toEqual(cameraDigestDefaults());
		expect(parseCameraDigestConfig('{not json')).toEqual(cameraDigestDefaults());
		expect(
			parseCameraDigestConfig('{"cameras":[1,"cam-1"],"period":"forever","include_snapshot":"y"}')
		).toEqual({ ...cameraDigestDefaults(), cameras: ['cam-1'] });
	});

	it('validates the period and the focus length', () => {
		const validate = cameraDigestJobType.validate!;
		const input = (config: Partial<CameraDigestConfig>) => ({
			name: 'x',
			workingDir: '',
			steps: [],
			config: { ...cameraDigestDefaults(), ...config }
		});
		expect(validate(input({}))).toBeNull();
		expect(validate(input({ period: 'week' as never }))).toBe('Choose a period.');
		expect(validate(input({ focus: 'x'.repeat(501) }))).toMatch(/under 500/);
	});

	it('is usable with an Allow camera and a model that may see it', async () => {
		expect(cameraDigestUsable()).toBe(true);
		expect(await cameraDigestJobType.available!()).toBe(true);
		expect(cameraDigestUsable({ baseUrl: 'https://openrouter.ai/api' })).toBe(false);
		updateSettings({ cameras: [PORCH] });
		expect(cameraDigestUsable()).toBe(false);
		expect(await cameraDigestJobType.available!()).toBe(false);
	});

	it('reads the period from the last finished run, else the last 24 hours', () => {
		const now = new Date(NOW);
		expect(periodStart('since_last_run', null, now)).toBe(NOW - 24 * 3_600_000);
		expect(periodStart('since_last_run', NOW - 3_600_000, now)).toBe(NOW - 3_600_000);
		expect(periodStart('last_24h', NOW - 3_600_000, now)).toBe(NOW - 24 * 3_600_000);
		expect(periodStart('today', null, now)).toBe(new Date(2026, 10, 12).getTime());
	});
});

describe('camera digest pipeline', () => {
	it('skips an Ask camera with a note naming Settings → Cameras', async () => {
		const { h, ctx } = harness({ cameras: ['cam-1', 'cam-2'] }, { replies: [REPLY] });
		await runCameraDigestPipeline(ctx);
		expect(h.steps[0].output).toContain('Skipped Porch: set to Ask (Settings → Cameras)');
		const reads = vi.mocked(invoke).mock.calls.filter((c) => c[0] === 'camera_events_list');
		expect(reads.map((c) => (c[1] as { cameraId: string }).cameraId)).toEqual(['cam-1']);
		expect(reads[0][1]).toMatchObject({ limit: PER_CAMERA });
		expect(h.turns[0].userMessage).toContain('Kitchen');
		expect(h.turns[0].userMessage).not.toContain('Porch');
		expect(h.result).toEqual(parseDigest(REPLY));
		expect(h.steps[1].output).toContain('18:00 · Kitchen — A box was left.');
		expect(h.finished).toEqual({ status: 'succeeded', error: null });
	});

	it('reads every Allow camera when none are chosen', async () => {
		const { h, ctx } = harness({}, { replies: [REPLY] });
		await runCameraDigestPipeline(ctx);
		expect(h.turns[0].userMessage).toContain('words 1');
		expect(h.turns[0].userMessage).not.toContain('words 2');
	});

	it('fails without a camera set to Allow', async () => {
		const { h, ctx } = harness({ cameras: ['cam-2'] });
		await runCameraDigestPipeline(ctx);
		expect(h.finished?.status).toBe('failed');
		expect(h.finished?.error).toContain('Skipped Porch');
		expect(h.turns).toEqual([]);
	});

	it('refuses a job on a model that may not see the cameras', async () => {
		const { h, ctx } = harness({}, { job: { model_remote_base_url: 'https://openrouter.ai/api' } });
		await runCameraDigestPipeline(ctx);
		expect(h.finished).toEqual({ status: 'failed', error: NOT_LOCAL });
		expect(invoke).not.toHaveBeenCalled();
	});

	it('says nothing was logged without calling the model', async () => {
		log = [];
		const { h, ctx } = harness({ include_snapshot: true });
		await runCameraDigestPipeline(ctx);
		expect(h.turns).toEqual([]);
		expect(h.result).toEqual({ summary: NOTHING_LOGGED, highlights: [] });
		expect(h.finished).toEqual({ status: 'succeeded', error: null });
	});

	it('starts the period at the last finished run', async () => {
		runs = [
			{ id: 9, status: 'running', started_at: NOW, queued_at: NOW },
			{ id: 8, status: 'succeeded', started_at: NOW - 7_200_000, queued_at: NOW - 7_200_000 }
		];
		const { ctx } = harness({ period: 'since_last_run' }, { replies: [REPLY] });
		await runCameraDigestPipeline(ctx);
		const read = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'camera_events_list');
		expect((read![1] as { since: number }).since).toBe(NOW - 7_200_000);
	});

	it('offers camera_snapshot only when asked for, and only to a model that can see', async () => {
		expect(digestToolAllowlist(false, true)).toEqual(['camera_log']);
		expect(digestToolAllowlist(true, true)).toEqual(['camera_log', 'camera_snapshot']);
		expect(digestToolAllowlist(true, false)).toEqual(['camera_log']);

		const on = harness({ include_snapshot: true }, { replies: [REPLY] });
		await runCameraDigestPipeline(on.ctx);
		expect([...on.h.turns[0].toolAllowlist!]).toEqual(['camera_log', 'camera_snapshot']);
		expect(on.h.turns[0].userMessage).toContain('camera_snapshot');

		const blind = harness({ include_snapshot: true }, { replies: [REPLY], vision: false });
		await runCameraDigestPipeline(blind.ctx);
		expect([...blind.h.turns[0].toolAllowlist!]).toEqual(['camera_log']);
		expect(blind.h.steps[1].output).toContain(NO_VISION);
	});

	it('asks again once when the reply is not the JSON it wants', async () => {
		const { h, ctx } = harness({}, { replies: ['Lots happened.', REPLY] });
		await runCameraDigestPipeline(ctx);
		expect(h.turns).toHaveLength(2);
		expect(h.turns[1].userMessage).toContain('could not be used');
		expect(h.finished?.status).toBe('succeeded');
	});

	it('passes the focus to the model', async () => {
		const { h, ctx } = harness({ focus: 'Only deliveries' }, { replies: [REPLY] });
		await runCameraDigestPipeline(ctx);
		expect(h.turns[0].userMessage).toContain('Focus: Only deliveries');
	});
});

describe("the digest's job turn and the camera gate", () => {
	// What a job turn sees: the digest's allowlist through the same registry,
	// and a tool context with nobody there and auto-approve on.
	async function turnCalls(name: string, args: Record<string, unknown>, turn: TurnSeen) {
		const offered = getToolSchemas({
			hasWorkingDir: false,
			interactive: turn.interactive ?? false,
			toolAllowlist: turn.toolAllowlist
		}).map((s) => s.function.name);
		expect(offered).toContain(name);
		const ctx = makeToolContext({ interactive: turn.interactive ?? false });
		return runWithAutoApprove(() => executeTool(name, args, ctx));
	}

	it('is offered camera_log and reads an Allow camera, and is refused an Ask camera', async () => {
		const results: string[] = [];
		const { h, ctx } = harness(
			{ include_snapshot: true },
			{
				replies: [REPLY],
				onTurn: async (turn) => {
					results.push((await turnCalls('camera_log', { camera: 'Kitchen' }, turn)).result);
					results.push((await turnCalls('camera_log', { camera: 'Porch' }, turn)).result);
					results.push((await turnCalls('camera_snapshot', { camera: 'Porch' }, turn)).result);
				}
			}
		);
		await runCameraDigestPipeline(ctx);
		expect(h.finished?.status).toBe('succeeded');
		expect(results[0]).toContain('Kitchen');
		expect(results[0]).toContain('words 1');
		expect(JSON.parse(results[1]).error).toBe(ASK_IN_JOB);
		expect(JSON.parse(results[2]).error).toBe(ASK_IN_JOB);
	});
});
