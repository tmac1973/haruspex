import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTask as tick } from '#lib/testing/flush.ts';
import type { SubtaskEnv, SubtaskSpec } from '#lib/code/subtaskRun.ts';

const mocks = vi.hoisted(() => ({
	runSubtaskSpec: vi.fn(),
	withInferenceSlot: vi.fn(),
	discard: vi.fn()
}));
vi.mock('#lib/code/subtaskRun.ts', () => ({ runSubtaskSpec: mocks.runSubtaskSpec }));
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	withInferenceSlot: mocks.withInferenceSlot
}));
vi.mock('#lib/code/subtaskApply.ts', () => ({ discardQuietly: mocks.discard }));

import {
	BACKGROUND_SUBTASKS_RUNNING,
	BackgroundSubtasks,
	buildSubtaskNotification,
	isSubtaskNotification,
	perWriteGuard,
	type BackgroundSubtaskHost,
	type CompletedSubtask
} from '#lib/code/backgroundSubtasks.ts';
import { newSubtaskState, SubtaskStops, type SubtaskState } from '#lib/code/subtask.ts';

const spec = (id: string): SubtaskSpec => ({
	id,
	label: id,
	task: `do ${id}`,
	mode: 'read',
	wt: null
});

/** Runs that end when `finish(id)` is called, or when stopped. */
function heldRuns() {
	const finishers = new Map<string, () => void>();
	const envs = new Map<string, SubtaskEnv>();
	mocks.runSubtaskSpec.mockImplementation(
		(s: SubtaskSpec, env: SubtaskEnv) =>
			new Promise((resolve) => {
				envs.set(s.id, env);
				const end = (text: string) => resolve({ text, failed: false, state: {} });
				finishers.set(s.id, () => end(`report ${s.id}`));
				env.signal.addEventListener('abort', () => end(`stopped ${s.id}`));
			})
	);
	return { finish: (id: string) => finishers.get(id)?.(), envs, started: () => [...envs.keys()] };
}

function host() {
	const done: CompletedSubtask[] = [];
	const states: SubtaskState[] = [];
	const stops = new SubtaskStops();
	const leaseDone = vi.fn(async () => {});
	const h: BackgroundSubtaskHost = {
		place: () => ({
			sessionId: 's1',
			folder: '/proj',
			wslDistro: null,
			backend: null,
			effort: null,
			requester: () => 'Code · proj'
		}),
		lease: () => ({ guard: { acquire: async () => null, changed: () => {} }, done: leaseDone }),
		stops,
		onState: (s) => states.push(s),
		onDone: (d) => done.push(d)
	};
	return { h, done, states, stops, leaseDone };
}

beforeEach(() => {
	mocks.runSubtaskSpec.mockReset();
	mocks.withInferenceSlot.mockReset().mockImplementation((_o, fn: () => Promise<unknown>) => fn());
	mocks.discard.mockReset();
});

describe('BackgroundSubtasks', () => {
	it(`runs ${BACKGROUND_SUBTASKS_RUNNING} at once and queues the rest`, async () => {
		const runs = heldRuns();
		const { h, done } = host();
		const bg = new BackgroundSubtasks(h);
		for (let i = 1; i <= 5; i++) bg.start(spec(`t${i}`), newSubtaskState(`t${i}`, 'l', 't'));
		await tick();
		expect(runs.started()).toEqual(['t1', 't2', 't3', 't4']);
		expect(bg.active).toBe(5);
		runs.finish('t2');
		await tick();
		expect(runs.started()).toContain('t5');
		expect(done).toEqual([{ id: 't2', label: 't2', text: 'report t2' }]);
		expect(bg.active).toBe(4);
	});

	it('gives each its own slot, never the turn’s', async () => {
		const runs = heldRuns();
		const { h } = host();
		new BackgroundSubtasks(h).start(spec('a'), newSubtaskState('a', 'l', 't'));
		await tick();
		const lend = runs.envs.get('a')!.runInSlot!;
		await lend(async () => 'x', { onAdmitted: () => {} });
		expect(mocks.withInferenceSlot).toHaveBeenCalledWith(
			expect.objectContaining({ consumer: 'subagent' }),
			expect.any(Function)
		);
	});

	it('stops with its card, or with the session, not with a turn’s Stop', async () => {
		const runs = heldRuns();
		const { h, done, stops } = host();
		const bg = new BackgroundSubtasks(h);
		bg.start(spec('a'), newSubtaskState('a', 'l', 't', 'read', true));
		bg.start(spec('b'), newSubtaskState('b', 'l', 't', 'read', true));
		await tick();
		stops.stopAll({ background: false });
		await tick();
		expect(done).toEqual([]);
		stops.stop('a');
		await tick();
		expect(done.map((d) => d.text)).toEqual(['stopped a']);
		expect(runs.envs.get('a')!.stoppedByUser()).toBe(true);
		stops.stopAll();
		await bg.settle();
		expect(done.map((d) => d.id)).toEqual(['a', 'b']);
		expect(bg.active).toBe(0);
	});

	it('never starts one stopped while it waited, and drops its worktree', async () => {
		heldRuns();
		const { h, done, states, stops } = host();
		const bg = new BackgroundSubtasks(h);
		for (let i = 1; i <= 4; i++) bg.start(spec(`t${i}`), newSubtaskState(`t${i}`, 'l', 't'));
		const wt = { path: '/w', root: '/w', base: 'b', linked: [] };
		bg.start({ ...spec('late'), mode: 'write', wt }, newSubtaskState('late', 'late', 't', 'write'));
		const onEnd = vi.fn();
		bg.start(
			{ ...spec('late3d'), profile: { onEnd } as unknown as SubtaskSpec['profile'] },
			newSubtaskState('late3d', 'late', 't', 'write')
		);
		stops.stop('late');
		stops.stop('late3d');
		stops.stopAll();
		await bg.settle();
		expect(mocks.runSubtaskSpec).toHaveBeenCalledTimes(4);
		expect(mocks.discard).toHaveBeenCalledWith(wt, null);
		expect(states.find((s) => s.id === 'late')?.status).toBe('stopped');
		expect(done.find((d) => d.id === 'late')?.text).toContain('before it started');
		// A profile that never ran still gives back what it held.
		expect(onEnd).toHaveBeenCalledTimes(1);
	});

	it('asks for the lease only to apply, and lets it go after', async () => {
		const { h, leaseDone } = host();
		mocks.runSubtaskSpec.mockImplementation(async (_s: SubtaskSpec, env: SubtaskEnv) => {
			await env.guard!.acquire();
			return { text: 'ok', failed: false, state: {} };
		});
		const bg = new BackgroundSubtasks(h);
		bg.start(spec('w'), newSubtaskState('w', 'l', 't', 'write'));
		await bg.settle();
		expect(leaseDone).toHaveBeenCalledTimes(1);
		mocks.runSubtaskSpec.mockResolvedValue({ text: 'ok', failed: false, state: {} });
		bg.start(spec('r'), newSubtaskState('r', 'l', 't'));
		await bg.settle();
		expect(leaseDone).toHaveBeenCalledTimes(1);
	});

	it('runs a profiled spec with its profile, and reports what its finish said', async () => {
		const { h, done } = host();
		const profile = {
			backend: { baseUrl: 'https://openrouter.ai/api', modelId: 'vendor/big' },
			writablePaths: ['a.js', 'a.anim.js', 'a.glb']
		} as unknown as NonNullable<SubtaskSpec['profile']>;
		mocks.runSubtaskSpec.mockResolvedValue({
			text: '3D delegate "3D: a.glb" (done, 4 tool calls):\n\nBuilt it.\n\nFinal check: clean.',
			failed: false,
			state: {},
			png: 'data:image/png;base64,AA'
		});
		const bg = new BackgroundSubtasks(h);
		bg.start({ ...spec('d3'), mode: 'write', profile }, newSubtaskState('d3', 'l', 't', 'write'));
		await bg.settle();
		expect(mocks.runSubtaskSpec.mock.calls[0][0].profile).toBe(profile);
		expect(done[0].text).toContain('Final check: clean.');
		expect(buildSubtaskNotification(done)).toContain('Built it.');
	});
});

describe('a profiled background subtask’s writes', () => {
	function leases() {
		const made: {
			acquire: ReturnType<typeof vi.fn>;
			changed: ReturnType<typeof vi.fn>;
			done: ReturnType<typeof vi.fn>;
		}[] = [];
		const lease = () => {
			const l = {
				acquire: vi.fn(async () => null as string | null),
				changed: vi.fn(),
				done: vi.fn(async () => {})
			};
			made.push(l);
			return { guard: { acquire: l.acquire, changed: l.changed }, done: l.done };
		};
		return { made, lease };
	}

	it('take the lease for each write and give it back with what changed', async () => {
		const { made, lease } = leases();
		const { guard, settle } = perWriteGuard(lease);
		expect(await guard.acquire()).toBeNull();
		guard.changed(['a.js']);
		expect(made[0].changed).toHaveBeenCalledWith(['a.js']);
		expect(made[0].done).toHaveBeenCalledTimes(1);
		await guard.acquire();
		guard.changed(['a.glb']);
		expect(made).toHaveLength(2);
		expect(made[1].changed).toHaveBeenCalledWith(['a.glb']);
		await settle();
		expect(made[1].done).toHaveBeenCalledTimes(1);
	});

	it('give back a refused or unfinished write’s lease', async () => {
		const { made, lease } = leases();
		const { guard, settle } = perWriteGuard(lease);
		await guard.acquire();
		await guard.acquire();
		expect(made[0].done).toHaveBeenCalledTimes(1);
		await settle();
		expect(made[1].done).toHaveBeenCalledTimes(1);
	});

	it('are what a profiled spec runs with', async () => {
		const { h } = host();
		const leaseSpy = vi.spyOn(h, 'lease');
		mocks.runSubtaskSpec.mockImplementation(async (_s: SubtaskSpec, env: SubtaskEnv) => {
			for (const path of ['a.js', 'a.glb']) {
				await env.guard!.acquire();
				env.guard!.changed([path]);
			}
			return { text: 'ok', failed: false, state: {} };
		});
		const profile = {} as NonNullable<SubtaskSpec['profile']>;
		const bg = new BackgroundSubtasks(h);
		bg.start({ ...spec('p'), mode: 'write', profile }, newSubtaskState('p', 'l', 't', 'write'));
		await bg.settle();
		expect(leaseSpy).toHaveBeenCalledTimes(2);
	});
});

describe('subtask notifications', () => {
	it('open with a fixed line the transcript knows', () => {
		const one = buildSubtaskNotification([{ id: 'a', label: 'a', text: 'Subtask "a" (done): r' }]);
		expect(one.startsWith('A subtask you started in the background has finished.')).toBe(true);
		expect(one).toContain('Subtask "a" (done): r');
		const two = buildSubtaskNotification([
			{ id: 'a', label: 'a', text: 'x' },
			{ id: 'b', label: 'b', text: 'y' }
		]);
		expect(two.startsWith('2 subtasks you started')).toBe(true);
		expect(isSubtaskNotification(one) && isSubtaskNotification(two)).toBe(true);
		expect(isSubtaskNotification('A subtask, please')).toBe(false);
	});
});
