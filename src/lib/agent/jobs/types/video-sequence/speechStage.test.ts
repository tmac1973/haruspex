/**
 * The Speech stage on its own: the speech helpers (`speech.ts`), the clip
 * planner and the progress file are stand-ins, so these check what the stage
 * itself decides and what it hands them.
 */
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { StepMarkers } from '#lib/agent/jobs/stepMarkers.ts';
import type { RunFiles } from '#lib/agent/jobs/types/video-sequence/files.ts';
import type { SpeechDeps } from '#lib/agent/jobs/types/video-sequence/speech.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';
import { SPEECH } from '#lib/agent/jobs/types/video-sequence/stages.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
const m = vi.hoisted(() => ({
	sections: [] as { lines: unknown[] }[],
	spoken: 0,
	joined: 0,
	plan: { items: [] as { kind: string; audio?: boolean }[] },
	deps: null as SpeechDeps | null,
	planClips: vi.fn(),
	writeProgress: vi.fn(async () => {}),
	speak: vi.fn(async () => ({ hash: 'h1', seconds: 2.5 }))
}));
vi.mock('#lib/agent/jobs/types/video-sequence/speech.ts', () => ({
	speakingSections: () => m.sections,
	// spec, progress, deps: the deps are what the stage built.
	speakLines: async (...args: [unknown, unknown, SpeechDeps]) => {
		m.deps = args[2];
		return m.spoken;
	},
	speechMap: () => ({ line1: 'spoken' }),
	joinWindows: async () => m.joined
}));
vi.mock('#lib/sequence/spec/plan.ts', () => ({ planClips: m.planClips }));
vi.mock('#lib/sequence/spec/progress.ts', () => ({
	emptyProgress: () => ({ clips: {} }),
	mergeProgress: (p: unknown) => p
}));
vi.mock('#lib/agent/jobs/types/video-sequence/files.ts', () => ({
	readProgress: async () => null,
	writeProgress: m.writeProgress
}));
vi.mock('#lib/audio/speak.ts', () => ({ speak: m.speak }));
vi.mock('#lib/video/binaries.ts', () => ({ videoOverrides: () => ({}) }));

import { speechStage, type SpeechRun } from './speechStage.ts';

const spec = { sections: [] } as unknown as SequenceSpec;
const video = { caps: { limits: { maxSecs: 10 } } } as unknown as SpeechRun['video'];
const speaking = { caps: { limits: { maxSecs: 20 } } } as unknown as SpeechRun['speaking'];

function steps() {
	return {
		start: vi.fn(),
		succeed: vi.fn(),
		abortIfCancelled: vi.fn()
	};
}

const ctx = {
	job: { working_dir: '/videos' },
	patchStep: vi.fn()
} as unknown as JobRunContext;
const files = {
	path: (rel: string) => `ep1/${rel}`,
	exists: vi.fn(async () => true)
} as unknown as RunFiles;

function run(over: Partial<SpeechRun> = {}) {
	const s = steps();
	const done = speechStage(ctx, s as unknown as StepMarkers, files, {
		spec,
		video,
		draws: true,
		speaking,
		...over
	});
	return { s, done };
}

beforeEach(() => {
	m.sections = [{ lines: [1, 2] }, { lines: [3] }];
	m.spoken = 2;
	m.joined = 1;
	m.plan = { items: [{ kind: 'generate', audio: true }, { kind: 'generate' }, { kind: 'still' }] };
	m.deps = null;
	m.planClips.mockReset();
	m.planClips.mockImplementation(() => m.plan);
	m.writeProgress.mockClear();
	m.speak.mockClear();
	vi.mocked(invoke).mockReset();
});

describe('speechStage', () => {
	it('plans the clips without speech when no section speaks', async () => {
		m.sections = [];
		const { s, done } = run({ speaking: null });
		expect(await done).toBe(m.plan);
		expect(m.planClips).toHaveBeenCalledWith(spec, video.caps, true);
		expect(s.succeed).toHaveBeenCalledWith(SPEECH, 'No speaking sections.');
		expect(m.deps).toBeNull();
	});

	it('needs the speaking model when a section speaks', async () => {
		const { done } = run({ speaking: null });
		await expect(done).rejects.toThrow('Speaking sections need the job’s speaking model.');
	});

	it('plans from the spoken lines with the speaking model’s limits, then joins', async () => {
		const { s, done } = run();
		expect(await done).toBe(m.plan);
		expect(m.planClips).toHaveBeenCalledWith(spec, video.caps, true, {
			limits: speaking!.caps.limits,
			speech: { line1: 'spoken' }
		});
		expect(m.writeProgress).toHaveBeenCalled();
		expect(s.succeed).toHaveBeenCalledWith(
			SPEECH,
			'3 lines (2 spoken now) in 1 speaking clip (1 joined now).'
		);
	});

	it('says one line and several clips in the right number', async () => {
		m.sections = [{ lines: [1] }];
		m.plan.items = [
			{ kind: 'generate', audio: true },
			{ kind: 'generate', audio: true }
		];
		const { s, done } = run();
		await done;
		expect(s.succeed).toHaveBeenCalledWith(
			SPEECH,
			'1 line (2 spoken now) in 2 speaking clips (1 joined now).'
		);
	});

	it('hands the speech helpers the engine and the episode’s paths', async () => {
		await run().done;
		const deps = m.deps!;
		expect(await deps.speak('Hello', undefined)).toEqual({ hash: 'h1', secs: 2.5 });
		expect(m.speak).toHaveBeenCalledWith({ text: 'Hello', voice: null, speed: 1 });

		await deps.save('h1', 'speech/a.wav');
		expect(invoke).toHaveBeenCalledWith('audio_save_in_folder', {
			hash: 'h1',
			workdir: '/videos',
			relPath: 'ep1/speech/a.wav'
		});

		await deps.join([{ path: 'speech/a.wav', from_secs: 0, to_secs: 1.5 }], 'speech/w1.wav');
		expect(invoke).toHaveBeenCalledWith('audio_join', {
			workingDir: '/videos',
			parts: [{ path: 'ep1/speech/a.wav', fromSecs: 0, toSecs: 1.5 }],
			out: 'ep1/speech/w1.wav',
			overrides: {}
		});

		deps.status('Speaking line 2');
		expect(ctx.patchStep).toHaveBeenCalledWith(SPEECH, { output: 'Speaking line 2' });
	});
});
