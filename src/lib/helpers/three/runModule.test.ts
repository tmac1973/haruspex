import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { LATE_MS } from '#lib/specialists/three/runHtml.ts';
import { lineOf, modulePage, runBuildModule, type ModuleRunResult } from './runModule';

function frame() {
	const iframe = document.querySelector('iframe');
	if (!iframe?.contentWindow) throw new Error('no iframe');
	const win = iframe.contentWindow;
	const send = (data: unknown) =>
		window.dispatchEvent(new MessageEvent('message', { data, source: win }));
	return { iframe, send };
}

async function start(opts: Parameters<typeof runBuildModule>[1] = {}) {
	let settled: ModuleRunResult | Error | undefined;
	const run = runBuildModule('export default (T) => new T.Group();', opts).then(
		(r) => (settled = r),
		(e: Error) => (settled = e)
	);
	await vi.advanceTimersByTimeAsync(0);
	return { run, f: frame(), settled: () => settled };
}

beforeEach(() => {
	vi.useFakeTimers();
	invoke.mockReset();
	invoke.mockResolvedValue('doc-1');
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

describe('modulePage', () => {
	it('loads the kit, then the source as data, then the runner', () => {
		const page = modulePage('export default () => 1;', 'tauri://localhost/helpers/three-kit.js');
		expect(page).toContain('<script src="tauri://localhost/helpers/three-kit.js"></script>');
		expect(page).toContain('window.__hxSource = "export default () => 1;";');
		expect(page.indexOf('three-kit.js')).toBeLessThan(page.indexOf('__hxSource'));
	});

	it('escapes < so the source cannot close its script tag', () => {
		const page = modulePage('const s = "</script><script>alert(1)</script>";', 'k');
		expect(page).not.toContain('"</script>');
		expect(page).toContain('\\u003c/script>');
	});

	it('imports no animation module without one', () => {
		const page = modulePage('export default () => 1;', 'k');
		expect(page).toContain('window.__hxAnim = null;');
	});

	it('embeds an animation module, escaped like the source', () => {
		const page = modulePage('', 'k', 'export default () => ["</script>"];');
		expect(page).toContain('window.__hxAnim = "export default () => [\\"\\u003c/script>\\"];";');
		expect(page.indexOf('__hxAnim')).toBeLessThan(page.indexOf('__hxRun'));
	});

	it('embeds no textures without any', () => {
		expect(modulePage('', 'k')).toContain('window.__hxTextures = {};');
	});

	it('embeds the textures as JSON, escaped like the source', () => {
		const page = modulePage('', 'k', undefined, { '</script>.png': 'data:image/png;base64,AA' });
		expect(page).toContain(
			'window.__hxTextures = {"\\u003c/script>.png":"data:image/png;base64,AA"};'
		);
		expect(page.indexOf('__hxTextures')).toBeLessThan(page.indexOf('__hxRun'));
	});
});

/** The page's runner, run in this window with a fake kit; what it posted. */
function runner() {
	const posted: Record<string, unknown>[] = [];
	vi.spyOn(window, 'postMessage').mockImplementation((m: unknown) => {
		posted.push(m as Record<string, unknown>);
	});
	const named = (name: string, geometry?: unknown) => {
		const o = { isObject3D: true, name, geometry, traverse: (fn: (x: unknown) => void) => fn(o) };
		return o;
	};
	const w = window as unknown as Record<string, unknown>;
	w.HaruspexThreeKit = {
		THREE: {
			PropertyBinding: {
				findNode: (o: { name: string }, n: string) => (n === o.name ? o : null),
				parseTrackName: (t: string) => ({ nodeName: t.split('.')[0] })
			}
		},
		kit: {},
		GLTFExporter: class {
			async parseAsync(_o: unknown, opts: { animations: { name: string }[] }) {
				posted.push({ t: 'exported', clips: opts.animations.map((c) => c.name) });
				return new ArrayBuffer(4);
			}
		}
	};
	w.__hxSource = '';
	w.__hxAnim = null;
	const page = modulePage('', 'k');
	const script = page.slice(page.lastIndexOf('<script>') + 8, page.lastIndexOf('</script>'));
	new Function(script)();
	const run = w.__hxRun as (mod: unknown, anim?: unknown) => Promise<void>;
	return { posted, named, run };
}

const clip = (name: string) => ({ name, tracks: [{ name: 'Body.quaternion' }] });

describe('the runner with an animation module', () => {
	afterEach(() => {
		const w = window as unknown as Record<string, unknown>;
		delete w.HaruspexThreeKit;
		delete w.__hxRun;
	});

	it('clamps vertex colours into 0..1 before export, and says how many and where', async () => {
		const { posted, named, run } = runner();
		const color = {
			array: new Float32Array([1.2, 0.5, 0.5, 0.2, 0.2, 0.2, -0.1, 1, 1]),
			itemSize: 3
		};
		await run({ default: () => named('Helmet', { attributes: { color } }) });
		expect([...color.array].map((v) => Math.round(v * 10) / 10)).toEqual([
			1, 0.5, 0.5, 0.2, 0.2, 0.2, 0, 1, 1
		]);
		expect(posted).toContainEqual({ t: 'hx-clamped', count: 2, meshes: ['Helmet'] });
		const exported = posted.findIndex((m) => m.t === 'exported');
		expect(posted.findIndex((m) => m.t === 'hx-clamped')).toBeLessThan(exported);
	});

	it('adds the clips animate() returns to the build clips', async () => {
		const { posted, named, run } = runner();
		const object = named('Body');
		let got: unknown;
		await run(
			{ default: () => ({ object, animations: [clip('Idle')] }) },
			{
				default: (_T: unknown, o: unknown) => {
					got = o;
					return [clip('Walk')];
				}
			}
		);
		expect(got).toBe(object);
		expect(posted).toContainEqual({ t: 'exported', clips: ['Idle', 'Walk'] });
		expect(posted.some((m) => m.t === 'hx-glb')).toBe(true);
		expect(posted.some((m) => m.t === 'hx-err')).toBe(false);
	});

	it('blames the animation module when animate() returns no array', async () => {
		const { posted, named, run } = runner();
		await run({ default: () => named('Body') }, { animate: () => clip('Walk') });
		expect(posted).toContainEqual({
			t: 'hx-err',
			kind: 'error',
			message: 'animate() must return an array of AnimationClip.',
			line: null,
			file: 'anim'
		});
		expect(posted.some((m) => m.t === 'hx-glb')).toBe(false);
	});

	it('blames the animation module when it has no animate', async () => {
		const { posted, named, run } = runner();
		await run({ default: () => named('Body') }, {});
		expect(posted.find((m) => m.t === 'hx-err')).toMatchObject({
			message: expect.stringContaining('no default export function animate'),
			file: 'anim'
		});
	});

	it('refuses a clip name both modules use', async () => {
		const { posted, named, run } = runner();
		await run(
			{ default: () => ({ object: named('Body'), animations: [clip('Walk')] }) },
			{ default: () => [clip('Walk')] }
		);
		expect(posted.find((m) => m.t === 'hx-err')).toMatchObject({
			message: 'Clip "Walk" comes from both modules.',
			file: 'anim'
		});
	});
});

describe('the runner with textures', () => {
	afterEach(() => {
		const w = window as unknown as Record<string, unknown>;
		delete w.HaruspexThreeKit;
		delete w.__hxRun;
		delete w.__hxTextures;
		vi.unstubAllGlobals();
	});

	it('ends with an error naming a PNG it could not decode', async () => {
		vi.useRealTimers();
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('bad')));
		(window as unknown as Record<string, unknown>).__hxTextures = { 'bark.png': 'data:x' };
		const { posted } = runner();
		await vi.waitFor(() => expect(posted).toContainEqual({ t: 'hx-end' }));
		expect(posted).toContainEqual({
			t: 'hx-err',
			kind: 'error',
			message: 'Texture bark.png could not be decoded.',
			line: null,
			file: 'build'
		});
	});
});

describe('lineOf', () => {
	it('reads the line from WebKit and Chromium stacks', () => {
		expect(lineOf('build@blob:null/1f2e-33:12:7\nglobal code@')).toBe(12);
		expect(lineOf('TypeError: x\n    at build (blob:null/1f2e-33:9:3)\n    at run')).toBe(9);
		expect(lineOf('Error\n    at foo (https://x/y.js:1:1)')).toBeNull();
		expect(lineOf(undefined)).toBeNull();
	});
});

describe('runBuildModule', () => {
	it('registers the page and resolves with the GLB after late errors', async () => {
		const { run, f, settled } = await start();
		expect(invoke).toHaveBeenCalledWith('artifact_register', {
			html: expect.stringContaining('window.__hxSource')
		});
		expect(f.iframe.getAttribute('sandbox')).toBe('allow-scripts');
		f.send({ t: 'hx-glb', bytes: new Uint8Array([103, 108, 84, 70]).buffer });
		f.send({ t: 'hx-err', kind: 'error', message: 'late', line: 4 });
		await vi.advanceTimersByTimeAsync(LATE_MS - 1);
		expect(settled()).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		const r = (await run) as ModuleRunResult;
		expect([...r.glb!]).toEqual([103, 108, 84, 70]);
		expect(r.errors).toEqual([{ kind: 'error', message: 'late', line: 4, file: 'build' }]);
		expect(r.missingTracks).toEqual([]);
	});

	it('reports tracks that name a missing node, found before export', async () => {
		const { run, f } = await start();
		f.send({ t: 'hx-missing', tracks: ['Tail.quaternion'] });
		f.send({ t: 'hx-glb', bytes: new Uint8Array([103, 108, 84, 70]).buffer });
		await vi.advanceTimersByTimeAsync(LATE_MS);
		expect(((await run) as ModuleRunResult).missingTracks).toEqual(['Tail.quaternion']);
		const page = modulePage('', 'tauri://localhost/helpers/three-kit.js');
		expect(page.indexOf('PB.findNode')).toBeGreaterThan(0);
		expect(page.indexOf('PB.findNode')).toBeLessThan(page.indexOf('GLTFExporter()'));
	});

	it('reports vertex colours it clamped before export', async () => {
		const { run, f } = await start();
		f.send({ t: 'hx-clamped', count: 12, meshes: ['Helmet', 'Gauntlet_L'] });
		f.send({ t: 'hx-glb', bytes: new Uint8Array([103, 108, 84, 70]).buffer });
		await vi.advanceTimersByTimeAsync(LATE_MS);
		expect(((await run) as ModuleRunResult).clamped).toEqual({
			count: 12,
			meshes: ['Helmet', 'Gauntlet_L']
		});
		const page = modulePage('', 'tauri://localhost/helpers/three-kit.js');
		expect(page.indexOf('hx-clamped')).toBeGreaterThan(0);
		expect(page.indexOf('hx-clamped')).toBeLessThan(page.indexOf('GLTFExporter()'));
	});

	it('keeps which module an error came from', async () => {
		const { run, f } = await start({ anim: 'export default () => [];' });
		expect(invoke).toHaveBeenCalledWith('artifact_register', {
			html: expect.stringContaining('window.__hxAnim = "export default () => [];"')
		});
		f.send({ t: 'hx-err', message: 'x is not defined', line: 3, file: 'anim' });
		f.send({ t: 'hx-end' });
		await vi.advanceTimersByTimeAsync(LATE_MS);
		expect(((await run) as ModuleRunResult).errors).toEqual([
			{ kind: 'error', message: 'x is not defined', line: 3, file: 'anim' }
		]);
	});

	it('resolves with the errors when the module fails', async () => {
		const { run, f } = await start();
		f.send({ t: 'hx-err', message: "Unexpected token '}'", line: 7 });
		f.send({ t: 'hx-end' });
		await vi.advanceTimersByTimeAsync(LATE_MS);
		expect(await run).toEqual({
			glb: null,
			errors: [{ kind: 'error', message: "Unexpected token '}'", line: 7, file: 'build' }],
			missingTracks: [],
			clamped: null
		});
	});

	it('times out when build() never returns', async () => {
		const { run } = await start({ timeoutMs: 1000 });
		await vi.advanceTimersByTimeAsync(1000);
		expect(await run).toEqual({
			glb: null,
			errors: [
				{
					kind: 'timeout',
					message: 'Timed out after 1 s waiting for build() to return.',
					line: null,
					file: 'build'
				}
			],
			missingTracks: [],
			clamped: null
		});
		expect(document.querySelector('iframe')).toBeNull();
	});

	it('rejects with an AbortError when aborted', async () => {
		const c = new AbortController();
		const { run, settled } = await start({ signal: c.signal });
		c.abort();
		await run;
		expect((settled() as Error).name).toBe('AbortError');
	});
});
