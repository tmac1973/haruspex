import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => new Map<string, number[]>());
const io = vi.hoisted(() => ({
	read: vi.fn(async (path: string) => {
		const f = files.get(path);
		if (!f) throw 'No such file';
		return f;
	}),
	write: vi.fn(async (path: string, bytes: number[], overwrite: boolean, dryRun: boolean) => {
		if (files.has(path) && !overwrite) throw 'File already exists';
		if (!dryRun) files.set(path, bytes);
	})
}));
vi.mock('#lib/agent/tools/_assetIo.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/agent/tools/_assetIo.ts')>()),
	assetIo: () => io
}));
const call = vi.hoisted(() => ({ callSpecialist: vi.fn() }));
vi.mock('#lib/specialists/call.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/specialists/call.ts')>()),
	callSpecialist: call.callSpecialist
}));
const runner = vi.hoisted(() => ({ runAssetHtml: vi.fn() }));
vi.mock('#lib/specialists/three/runHtml.ts', () => runner);
const snapshot = vi.hoisted(() => ({ snapshotProblems: vi.fn() }));
vi.mock('#lib/specialists/three/snapshot.ts', () => snapshot);
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => ({ specialists: [] })
}));

import { specialistKind } from '#lib/specialists/kinds.ts';
import '#lib/specialists/kinds/index.ts';
import { effectiveSampling, newSpecialistEntry } from '#lib/specialists/entries.ts';
import type { SpecialistRun } from '#lib/specialists/types.ts';
import { PORTING_NOTE } from './threejs';

const PAGE = '<!DOCTYPE html><html><body>tower</body></html>';
const PNG = 'data:image/png;base64,AA';
const entry = { ...newSpecialistEntry('threejs', []), name: '3D Coder', url: 'http://a:3000' };

function ctx(over: Record<string, unknown> = {}) {
	return {
		workingDir: '/proj',
		codeMode: true,
		visionSupported: true,
		pendingImages: [] as { path: string; dataUrl: string }[],
		...over
	};
}

function run(args: Record<string, unknown>, request?: string, c = ctx()) {
	const r = { entry, request, images: [], args, ctx: c } as unknown as SpecialistRun;
	return specialistKind('threejs')!.run(r);
}

beforeEach(() => {
	files.clear();
	call.callSpecialist
		.mockReset()
		.mockResolvedValue({ content: '```html\n' + PAGE + '\n```', finishReason: 'stop' });
	runner.runAssetHtml.mockReset().mockResolvedValue({ glb: null, png: PNG, errors: [] });
	snapshot.snapshotProblems.mockReset().mockResolvedValue([]);
});

describe('the threejs kind', () => {
	it('turns thinking off and sends the request as written', async () => {
		expect(effectiveSampling(entry)).toMatchObject({ thinking: false, top_k: 20 });
		await run({ path: 'scenes/tower.html' }, 'An air traffic control tower.');
		expect(call.callSpecialist.mock.calls[0][1]).toBe('An air traffic control tower.');
	});

	it('saves the scene at the path, runs it without export and shows the screenshot', async () => {
		const c = ctx();
		const out = await run({ path: 'scenes/tower.html' }, 'A tower.', c);
		expect(files.has('/proj/scenes/tower.html')).toBe(true);
		expect(runner.runAssetHtml.mock.calls[0][1]).toMatchObject({ export: false });
		expect(out.result).toContain('Saved scenes/tower.html; it runs cleanly.');
		expect(out.result).toContain(PORTING_NOTE);
		expect(out.result).toContain('Check the screenshot');
		expect(out.thumbDataUrl).toBe(PNG);
		expect(c.pendingImages).toEqual([{ path: 'scenes/tower.html', dataUrl: PNG }]);
	});

	it("doesn't attach the screenshot for a model without vision", async () => {
		const c = ctx({ visionSupported: false });
		const out = await run({ path: 'a.html' }, 'x', c);
		expect(c.pendingImages).toEqual([]);
		expect(out.result).not.toContain('Check the screenshot');
	});

	it('refuses a path that is not .html, or an existing file without overwrite', async () => {
		expect((await run({ path: 'a.js' }, 'x')).result).toMatch(/path must end in \.html/);
		files.set('/proj/a.html', [1]);
		expect((await run({ path: 'a.html' }, 'x')).result).toMatch(/a\.html already exists/);
		expect(call.callSpecialist).not.toHaveBeenCalled();
		await run({ path: 'a.html', overwrite: true }, 'x');
		expect(call.callSpecialist).toHaveBeenCalledOnce();
	});

	it('fails a scene that drew no canvas, drew nothing, or threw', async () => {
		runner.runAssetHtml.mockResolvedValueOnce({ glb: null, png: null, errors: [] });
		expect((await run({ path: 'a.html' }, 'x')).result).toContain('- The page drew no canvas.');

		snapshot.snapshotProblems.mockResolvedValueOnce(['The scene rendered nothing visible.']);
		const blank = await run({ path: 'a.html', overwrite: true }, 'x');
		expect(blank.result).toContain('- The scene rendered nothing visible.');
		expect(blank.result).toContain("recheck 'a.html'");

		runner.runAssetHtml.mockResolvedValueOnce({
			glb: null,
			png: PNG,
			errors: [{ kind: 'error', message: 'birds is not defined', line: 312 }]
		});
		const thrown = await run({ path: 'a.html', overwrite: true }, 'x');
		expect(thrown.result).toContain('- line 312: birds is not defined');
		// The failing scene stays for the agent to fix.
		expect(files.has('/proj/a.html')).toBe(true);
	});

	it('rechecks the file in place without generating', async () => {
		files.set('/proj/scenes/tower.html', [...new TextEncoder().encode(PAGE)]);
		const out = await run({ recheck: 'scenes/tower.html' });
		expect(call.callSpecialist).not.toHaveBeenCalled();
		expect(runner.runAssetHtml.mock.calls[0][0]).toBe(PAGE);
		expect(out.result).toContain('Saved scenes/tower.html; it runs cleanly.');
	});
});
