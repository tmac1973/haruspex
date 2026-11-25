import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import type { SubtaskSpec } from '#lib/code/subtaskRun.ts';
import type { FinalCheck3d } from '#lib/helpers/three/delegateCheck.ts';

const m = vi.hoisted(() => ({
	runSubtaskSpec: vi.fn(),
	finalCheck3d: vi.fn(),
	files: new Set<string>(),
	config: {} as Record<string, unknown>
}));

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore({
		fs_path_exists: (a) => m.files.has((a as { relPath: string }).relPath),
		fs_read_bytes: (a) => {
			const path = (a as { relPath: string }).relPath;
			if (!m.files.has(path)) throw 'No such file';
			return path.includes('huge') ? { length: 9 * 1024 * 1024 } : [1, 2, 3];
		},
		fs_read_image: (a) => `data:image/jpeg;base64,${(a as { relPath: string }).relPath}`
	})
);
vi.mock('#lib/code/subtaskRun.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/code/subtaskRun.ts')>()),
	runSubtaskSpec: m.runSubtaskSpec
}));
vi.mock('#lib/helpers/three/delegateCheck.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/helpers/three/delegateCheck.ts')>()),
	finalCheck3d: m.finalCheck3d
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		overDefaults: true,
		settings: () => ({ codeHelperConfig: { '3d': m.config } })
	})
);

import {
	DELEGATE_3D_TOOLS,
	delegate3dNudge,
	delegate3dResultText,
	executeDelegate3d
} from '#lib/agent/tools/delegate-3d.ts';
import { SUBTASKS_PER_TURN } from '#lib/agent/tools/delegate.ts';

const backend = {
	baseUrl: 'https://openrouter.ai/api',
	modelId: 'vendor/big',
	visionSupported: true
};
const PNG = 'data:image/png;base64,SHEET';
const clean: FinalCheck3d = { ok: true, text: 'Wrote assets/crate.glb.', problems: [], png: PNG };
const failing: FinalCheck3d = {
	ok: false,
	text: 'The check failed.',
	problems: ['- line 3: boom']
};

const ctx = (over = {}) =>
	makeToolContext({
		workingDir: '/proj',
		codeMode: true,
		codeSessionId: 's1',
		visionSupported: true,
		subtasksStartedThisTurn: { count: 0 },
		toolCallId: 'call-1',
		...over
	});

const call = (args: Record<string, unknown>, c = ctx()) =>
	executeDelegate3d({ path: 'assets/crate.glb', task: 'A wooden crate, 0.6 m.', ...args }, c);
const lastSpec = () => m.runSubtaskSpec.mock.calls.at(-1)![0] as SubtaskSpec;
const errorOf = (out: { result: string }) => (JSON.parse(out.result) as { error: string }).error;

beforeEach(() => {
	m.config = { backend, maxRounds: 40, maxCostUsd: 2 };
	m.files.clear();
	m.finalCheck3d.mockReset().mockResolvedValue(clean);
	m.runSubtaskSpec.mockReset().mockImplementation(async (spec: SubtaskSpec) => {
		const fin = await spec.profile!.finish!(
			{ outcome: 'done', report: 'Built a crate.', steps: [], stopReason: 'complete' },
			{ tokens: 1200, costUsd: 0.05 }
		);
		return { text: fin.text, failed: false, state: {}, png: fin.png };
	});
});

describe('delegate_3d refuses', () => {
	const cases: [string, Record<string, unknown>, object, RegExp][] = [
		['a subtask', {}, { subtask: { depth: 1 } }, /subtask cannot/],
		['no folder', {}, { workingDir: null }, /No project folder/],
		['a read-only session', {}, { codeReadOnly: true }, /read-only/],
		['a path not ending in .glb', { path: 'assets/crate.js' }, {}, /ending in \.glb/],
		['a path outside the folder', { path: '../crate.glb' }, {}, /inside the project/],
		['an empty task', { task: '  ' }, {}, /requires a task/],
		['too many images', { images: ['a.png', 'b.png', 'c.png', 'd.png'] }, {}, /at most 3/],
		['an image of another kind', { images: ['refs/a.gif'] }, {}, /PNG, JPEG or WebP/],
		['background with no session to run it', { background: true }, {}, /Background calls/],
		[
			'past the per-turn limit',
			{},
			{ subtasksStartedThisTurn: { count: SUBTASKS_PER_TURN } },
			/already started/
		]
	];
	it.each(cases)('%s', async (_name, args, over, why) => {
		expect(errorOf(await call(args, ctx(over)))).toMatch(why);
		expect(m.runSubtaskSpec).not.toHaveBeenCalled();
	});

	it('with no delegate model set, naming the setting', async () => {
		m.config = {};
		expect(errorOf(await call({}))).toBe(
			'No 3D delegate model is set. Set one in Settings → Code → Helpers → 3D.'
		);
	});

	it('an image over 8 MB, or one it cannot read', async () => {
		m.files.add('refs/huge.png');
		expect(errorOf(await call({ images: ['refs/huge.png'] }))).toMatch(/over 8 MB/);
		expect(errorOf(await call({ images: ['refs/missing.png'] }))).toMatch(/Could not read/);
	});
});

describe('delegate_3d’s profile', () => {
	it('carries the config’s model, caps, tools and the three writable files', async () => {
		await call({});
		const spec = lastSpec();
		expect(spec).toMatchObject({ mode: 'write', wt: null, label: '3D: crate.glb' });
		expect(spec.profile).toMatchObject({
			backend,
			maxRounds: 40,
			maxCostUsd: 2,
			tools: DELEGATE_3D_TOOLS,
			helpers: ['3d'],
			writablePaths: ['assets/crate.js', 'assets/crate.anim.js', 'assets/crate.glb'],
			images: []
		});
		expect(spec.profile!.firstMessage).not.toContain('exists');
		expect(spec.profile!.finalReport('cost')).toContain('cost limit');
	});

	it('says which modules exist, and sends the reference images', async () => {
		m.files.add('assets/crate.js').add('refs/crate.png');
		await call({ images: ['./refs/crate.png'], label: 'Crate' });
		const profile = lastSpec().profile!;
		expect(lastSpec().label).toBe('Crate');
		expect(profile.firstMessage).toContain('assets/crate.js exists');
		expect(profile.firstMessage).not.toContain('assets/crate.anim.js exists');
		expect(profile.images).toEqual([
			{ path: 'refs/crate.png', dataUrl: 'data:image/jpeg;base64,refs/crate.png' }
		]);
	});

	it('nudges once from the final check on disk, not from the steps', async () => {
		await call({});
		const done = lastSpec().profile!.doneCheck!;
		m.finalCheck3d.mockResolvedValueOnce(failing);
		expect(await done([])).toBe(
			'The final check still fails:\n- line 3: boom\nFix them, run check_3d, then give your report.'
		);
		expect(await done([])).toBeNull();
		const [files] = m.finalCheck3d.mock.calls[0];
		expect(files).toEqual({
			module: 'assets/crate.js',
			anim: 'assets/crate.anim.js',
			glb: 'assets/crate.glb'
		});
	});

	it('counts toward the turn’s subtasks', async () => {
		const c = ctx();
		await call({}, c);
		expect(c.subtasksStartedThisTurn!.count).toBe(1);
	});
});

describe('delegate_3d’s result', () => {
	it('attaches the final sheet in the foreground when the model can see', async () => {
		const c = ctx();
		const out = await call({}, c);
		expect(out.result).toContain('Built a crate.');
		expect(out.result).toContain('Final check: clean.');
		expect(out.thumbDataUrl).toBe(PNG);
		expect(c.pendingImages).toEqual([{ path: 'assets/crate.glb', dataUrl: PNG }]);
	});

	it('leaves the sheet out for a model without vision', async () => {
		const c = ctx({ visionSupported: false });
		await call({}, c);
		expect(c.pendingImages).toEqual([]);
	});

	it('returns at once in the background, handing the spec to the session', async () => {
		const start = vi.fn();
		const onSubtask = vi.fn();
		const out = await call({ background: true }, ctx({ startBackgroundSubtask: start, onSubtask }));
		expect(m.runSubtaskSpec).not.toHaveBeenCalled();
		expect(out.result).toMatch(/in the background \(id call-1\)/);
		const [spec, initial] = start.mock.calls[0];
		expect(spec.profile.writablePaths).toContain('assets/crate.glb');
		expect(initial).toMatchObject({ background: true, mode: 'write', status: 'queued' });
	});

	it('says plainly when errors remain', () => {
		const res = { outcome: 'done' as const, report: 'Done.', steps: [], stopReason: null };
		const text = delegate3dResultText('3D: crate.glb', res, failing, ['assets/crate.js'], {
			tokens: 0,
			costUsd: null
		});
		expect(text).toBe(
			[
				'3D delegate "3D: crate.glb" (done, 0 tool calls):',
				'',
				'Done.',
				'',
				'Final check: errors remain:',
				'- line 3: boom',
				'Files: assets/crate.js.'
			].join('\n')
		);
	});

	it('gives the files written and the cost on a clean check', async () => {
		m.files.add('assets/crate.js').add('assets/crate.glb');
		const out = await call({});
		expect(out.result).toContain('Files: assets/crate.js, assets/crate.glb.');
		expect(out.result).toContain('Cost: $0.05 (1.2k tokens).');
	});

	it('has no nudge for a clean check', () => {
		expect(delegate3dNudge(clean)).toBeNull();
	});
});
