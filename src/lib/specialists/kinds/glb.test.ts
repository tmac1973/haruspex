import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A folder of files the fake IO reads and writes; outside it, Rust refuses. */
const inside = vi.hoisted(
	() => (path: string) => path.startsWith('/proj/') && !path.includes('/../')
);
const files = vi.hoisted(() => new Map<string, number[]>());
const io = vi.hoisted(() => ({
	read: vi.fn(async (path: string) => {
		if (!inside(path)) throw 'path escapes working directory';
		const f = files.get(path);
		if (!f) throw 'No such file';
		return f;
	}),
	write: vi.fn(async (path: string, bytes: number[], overwrite: boolean, dryRun: boolean) => {
		if (!inside(path)) throw 'path escapes working directory';
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
const glb = vi.hoisted(() => ({ checkGlb: vi.fn() }));
vi.mock('#lib/glb/check.ts', () => glb);
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => ({ specialists: [] })
}));

import { specialistKind } from '#lib/specialists/kinds.ts';
import '#lib/specialists/kinds/index.ts';
import { newSpecialistEntry } from '#lib/specialists/entries.ts';
import type { SpecialistRun } from '#lib/specialists/types.ts';
import { GLB_REQUEST_SUFFIX, SHEET_NOTE } from './glb';

const PAGE = '<!DOCTYPE html><html><body>potion</body></html>';
const GLB = new Uint8Array([103, 108, 84, 70]);
const PNG = 'data:image/png;base64,AA';
const entry = { ...newSpecialistEntry('glb', []), name: 'GLB Coder', url: 'http://a:3000' };

function ctx(over: Record<string, unknown> = {}) {
	return {
		workingDir: '/proj',
		codeMode: true,
		visionSupported: true,
		pendingImages: [] as { path: string; dataUrl: string }[],
		onProgress: vi.fn(),
		...over
	};
}

function run(
	args: Record<string, unknown>,
	request?: string,
	c = ctx()
): Promise<{ result: string; thumbDataUrl?: string }> {
	const r = { entry, request, images: [], args, ctx: c } as unknown as SpecialistRun;
	return specialistKind('glb')!.run(r);
}

const REPORT = 'Size: 1.56 × 1.66 × 1.64 m (x × y × z).\n21 meshes, 1856 triangles.';
const good = { bytes: GLB, report: {}, text: REPORT, png: PNG };

beforeEach(() => {
	files.clear();
	io.read.mockClear();
	io.write.mockClear();
	call.callSpecialist.mockReset().mockResolvedValue({
		content: '```html\n' + PAGE + '\n```',
		finishReason: 'stop'
	});
	runner.runAssetHtml.mockReset().mockResolvedValue({ glb: GLB, png: PNG, errors: [] });
	glb.checkGlb.mockReset().mockResolvedValue(good);
});

describe('the glb kind', () => {
	it('generates, saves the page beside the GLB, checks it and writes the GLB', async () => {
		const c = ctx();
		const out = await run({ path: 'assets/potion.glb' }, 'A mana potion.', c);
		expect(call.callSpecialist.mock.calls[0][1]).toBe(`A mana potion.${GLB_REQUEST_SUFFIX}`);
		expect(
			new TextDecoder().decode(new Uint8Array(files.get('/proj/assets/potion.glb.html')!)).trim()
		).toBe(PAGE);
		expect(runner.runAssetHtml.mock.calls[0][1]).toMatchObject({ export: true });
		expect(files.get('/proj/assets/potion.glb')).toEqual([...GLB]);
		expect(out.result).toContain('Saved assets/potion.glb (source: assets/potion.glb.html).');
		expect(out.result).toContain(REPORT);
		expect(out.result).toContain(SHEET_NOTE);
		expect(out.thumbDataUrl).toBe(PNG);
		expect(c.pendingImages).toEqual([{ path: 'assets/potion.glb', dataUrl: PNG }]);
	});

	it("doesn't attach the render for a model without vision", async () => {
		const c = ctx({ visionSupported: false });
		const out = await run({ path: 'a.glb' }, 'A crate.', c);
		expect(c.pendingImages).toEqual([]);
		expect(out.result).not.toContain(SHEET_NOTE);
	});

	it('refuses a bad path or an existing GLB before generating', async () => {
		expect((await run({ path: 'a.png' }, 'x')).result).toMatch(/path must end in \.glb/);
		files.set('/proj/a.glb', [1]);
		expect((await run({ path: 'a.glb' }, 'x')).result).toMatch(/a\.glb already exists/);
		expect((await run({ path: '../a.glb' }, 'x')).result).toMatch(/path escapes/);
		expect(call.callSpecialist).not.toHaveBeenCalled();
		// overwrite lets it replace one.
		await run({ path: 'a.glb', overwrite: true }, 'x');
		expect(files.get('/proj/a.glb')).toEqual([...GLB]);
	});

	it('needs a request and path, or a recheck alone', async () => {
		expect((await run({ path: 'a.glb' })).result).toMatch(/Pass request and path, or recheck/);
		expect((await run({}, 'x')).result).toMatch(/Pass request and path, or recheck/);
		expect((await run({ recheck: 'a.glb.html' }, 'x')).result).toMatch(/recheck takes no request/);
		expect((await run({ recheck: 'a.glb.html', path: 'b.glb' })).result).toMatch(
			/recheck takes no request/
		);
	});

	it('says when the model ran out of tokens or wrote no page', async () => {
		call.callSpecialist.mockResolvedValueOnce({ content: '', finishReason: 'length' });
		expect((await run({ path: 'a.glb' }, 'x')).result).toMatch(/ran out of tokens \(max 24000\)/);
		call.callSpecialist.mockResolvedValueOnce({ content: 'Sorry, no.', finishReason: 'stop' });
		expect((await run({ path: 'a.glb' }, 'x')).result).toMatch(/without an HTML page: Sorry, no\./);
		expect(files.size).toBe(0);
	});

	it('reports every error with its line and how to recheck, writing no GLB', async () => {
		runner.runAssetHtml.mockResolvedValueOnce({
			glb: GLB,
			png: PNG,
			errors: [
				{ kind: 'error', message: "Identifier 'pole' has already been declared", line: 214 },
				{ kind: 'console', message: 'THREE.BufferGeometry: NaN', line: null }
			]
		});
		const out = await run({ path: 'lamp.glb' }, 'A street lamp.');
		expect(out.result).toBe(
			[
				'The check failed.',
				"- line 214: Identifier 'pole' has already been declared",
				'- THREE.BufferGeometry: NaN',
				"The source is at lamp.glb.html. Fix it with your edit tools, then call ask_specialist with name 'GLB Coder' and recheck 'lamp.glb.html'."
			].join('\n')
		);
		expect(glb.checkGlb).not.toHaveBeenCalled();
		expect(files.has('/proj/lamp.glb')).toBe(false);
		expect(files.has('/proj/lamp.glb.html')).toBe(true);
	});

	it("fails on a GLB the check finds broken, or that the page didn't export", async () => {
		glb.checkGlb.mockResolvedValueOnce({ problems: ["Mesh 'rock' has NaN vertex positions."] });
		const out = await run({ path: 'rock.glb' }, 'Rocks.');
		expect(out.result).toContain("- Mesh 'rock' has NaN vertex positions.");
		expect(files.has('/proj/rock.glb')).toBe(false);

		runner.runAssetHtml.mockResolvedValueOnce({
			glb: null,
			png: PNG,
			errors: [{ kind: 'no-export', message: 'No Export GLB button found.', line: null }]
		});
		expect((await run({ path: 'b.glb' }, 'x')).result).toContain('- No Export GLB button found.');
	});

	it('rechecks the saved page without generating, replacing the GLB', async () => {
		files.set('/proj/lamp.glb.html', [...new TextEncoder().encode(PAGE)]);
		files.set('/proj/lamp.glb', [0]);
		const out = await run({ recheck: 'lamp.glb.html' });
		expect(call.callSpecialist).not.toHaveBeenCalled();
		expect(runner.runAssetHtml.mock.calls[0][0]).toBe(PAGE);
		expect(files.get('/proj/lamp.glb')).toEqual([...GLB]);
		expect(out.result).toContain('Saved lamp.glb (source: lamp.glb.html).');
	});

	it('refuses a recheck of anything but a saved .glb.html, or with images', async () => {
		expect((await run({ recheck: 'lamp.html' })).result).toMatch(/needs the \.glb\.html/);
		expect((await run({ recheck: 'gone.glb.html' })).result).toMatch(
			/Could not read gone\.glb\.html/
		);
		const withImages = {
			entry,
			request: undefined,
			images: [{ path: 'a.png', dataUrl: PNG }],
			args: { recheck: 'lamp.glb.html' },
			ctx: ctx()
		} as unknown as SpecialistRun;
		expect((await specialistKind('glb')!.run(withImages)).result).toMatch(
			/images only go with a new request/
		);
	});

	it('names a recheck on its tool card', () => {
		const kind = specialistKind('glb')!;
		expect(kind.callLabel!(entry, { recheck: 'assets/lamp.glb.html' })).toBe(
			'GLB Coder: recheck lamp.glb.html'
		);
		expect(kind.callLabel!(entry, { path: 'a.glb' })).toBeNull();
	});
});
