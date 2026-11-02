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
		expect(r.errors).toEqual([{ kind: 'error', message: 'late', line: 4 }]);
	});

	it('resolves with the errors when the module fails', async () => {
		const { run, f } = await start();
		f.send({ t: 'hx-err', message: "Unexpected token '}'", line: 7 });
		f.send({ t: 'hx-end' });
		await vi.advanceTimersByTimeAsync(LATE_MS);
		expect(await run).toEqual({
			glb: null,
			errors: [{ kind: 'error', message: "Unexpected token '}'", line: 7 }]
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
					line: null
				}
			]
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
