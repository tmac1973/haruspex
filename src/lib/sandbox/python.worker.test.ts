/**
 * The Pyodide worker's message protocol, with Pyodide itself replaced by a
 * fake. The module boots at import time, so each test imports a fresh copy
 * against a stubbed worker global (`self`) and `XMLHttpRequest`.
 *
 * Python is not run: code the worker generates internally resolves to
 * nothing, and "user code" (anything starting with `USER`) goes to the
 * test's own handler. So this covers what the JS side does — message order,
 * retry on a missing import, the host bridges, the fetch shims — and not
 * the Python helpers in HARUSPEX_INIT_PY.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MainToWorker, ToolResult, WorkerToMain } from './protocol';

const mocks = vi.hoisted(() => ({ loadPyodide: vi.fn() }));
vi.mock('pyodide', () => ({ loadPyodide: mocks.loadPyodide }));

const ORIGIN = 'http://localhost:1420';

type Handler = (code: string) => unknown;

interface FakePy {
	globals: Map<string, unknown>;
	userCode: Handler;
	stdout(s: string): void;
	stderr(s: string): void;
	interruptBuffers: Uint8Array[];
	files: Map<string, Uint8Array>;
	/** Set to make the fake filesystem refuse writes. */
	writeError: Error | null;
	internalScripts: string[];
	micropipInstall: (name: string) => Promise<void>;
	globalsProxy: { toJs?: () => unknown; destroy?: () => void } | (() => never);
	api: Record<string, unknown>;
}

function fakePyodide(): FakePy {
	const fp: FakePy = {
		globals: new Map(),
		userCode: () => undefined,
		stdout: () => {},
		stderr: () => {},
		interruptBuffers: [],
		files: new Map(),
		writeError: null,
		internalScripts: [],
		micropipInstall: async () => {},
		globalsProxy: { toJs: () => [] },
		api: {}
	};
	const dirs = new Set<string>();
	fp.api = {
		globals: {
			set: (k: string, v: unknown) => fp.globals.set(k, v),
			get: (k: string) => fp.globals.get(k)
		},
		toPy: (x: unknown) => x,
		loadPackage: async () => {},
		loadPackagesFromImports: async () => {},
		setStdout: ({ batched }: { batched: (s: string) => void }) => (fp.stdout = batched),
		setStderr: ({ batched }: { batched: (s: string) => void }) => (fp.stderr = batched),
		setInterruptBuffer: (b: Uint8Array) => fp.interruptBuffers.push(b),
		runPythonAsync: async (code: string) => {
			if (code.startsWith('USER')) return fp.userCode(code);
			fp.internalScripts.push(code);
			return undefined;
		},
		runPython: () => {
			if (typeof fp.globalsProxy === 'function') fp.globalsProxy();
			return fp.globalsProxy;
		},
		pyimport: (name: string) => {
			if (name !== 'micropip') throw new Error(`no module ${name}`);
			return { install: (n: string) => fp.micropipInstall(n) };
		},
		FS: {
			mkdirTree: (p: string) => dirs.add(p),
			writeFile: (p: string, d: Uint8Array) => {
				if (fp.writeError) throw fp.writeError;
				fp.files.set(p, d);
			},
			unlink: (p: string) => fp.files.delete(p),
			analyzePath: (p: string) => ({ exists: fp.files.has(p) })
		}
	};
	return fp;
}

/** `XMLHttpRequest` stand-in whose `open` records what it was given. */
class FakeXHR {
	opened: unknown[] = [];
	open(...args: unknown[]): void {
		this.opened = args;
	}
}

let posted: WorkerToMain[];
let listener: ((e: MessageEvent<MainToWorker>) => void) | null;
let origFetch: ReturnType<typeof vi.fn>;
let fakeSelf: {
	location: { origin: string; href: string };
	fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	postMessage: (m: WorkerToMain) => void;
	addEventListener: (t: string, cb: (e: MessageEvent<MainToWorker>) => void) => void;
};
let py: FakePy;

const settle = async (n = 10) => {
	for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

function send(msg: MainToWorker): void {
	listener?.({ data: msg } as MessageEvent<MainToWorker>);
}

function kinds(): string[] {
	return posted.map((m) => m.kind);
}

function doneFor(id: string): ToolResult {
	const m = posted.find((x) => x.kind === 'done' && x.id === id);
	if (!m || m.kind !== 'done') throw new Error(`no done for ${id}: ${kinds().join(',')}`);
	return m.result;
}

/** Import a fresh worker module. Resolves once it has asked for its config. */
async function load(pyodide: Promise<unknown> = Promise.resolve(py.api)): Promise<void> {
	mocks.loadPyodide.mockReturnValue(pyodide);
	await import('./python.worker');
	await settle();
}

/** Boot all the way to `ready`. */
async function boot(workingDirSet = true): Promise<void> {
	await load();
	send({ kind: 'runtime_config', workingDirSet });
	await settle();
	expect(kinds()).toContain('ready');
	posted.length = 0;
}

/** Run user code and return its `done` result plus everything posted for the run. */
async function run(code: string, id = 'r1'): Promise<ToolResult> {
	send({ kind: 'run', id, code });
	await settle();
	return doneFor(id);
}

beforeEach(() => {
	vi.resetModules();
	posted = [];
	listener = null;
	origFetch = vi.fn();
	fakeSelf = {
		location: { origin: ORIGIN, href: `${ORIGIN}/worker.js` },
		fetch: origFetch as unknown as typeof fakeSelf.fetch,
		postMessage: (m) => posted.push(m),
		addEventListener: (t, cb) => {
			if (t === 'message') listener = cb;
		}
	};
	vi.stubGlobal('self', fakeSelf);
	vi.stubGlobal('XMLHttpRequest', FakeXHR);
	py = fakePyodide();
	py.globals.set('_haruspex_postprocess', (v: unknown) => `repr:${v}`);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('python.worker boot', () => {
	it('asks main for its config, records it, then reports ready', async () => {
		await load();
		expect(kinds()).toEqual(['get_runtime_config']);
		send({ kind: 'runtime_config', workingDirSet: false });
		await settle();
		expect(kinds()).toEqual(['get_runtime_config', 'ready']);
		expect(py.globals.get('_haruspex_working_dir_set')).toBe(false);
		// The init script ran before ready.
		expect(py.internalScripts.some((s) => s.includes('import io as _io'))).toBe(true);
	});

	it('points package globals at the app origin', async () => {
		await boot();
		expect(py.globals.get('_haruspex_doc_wheels_url')).toBe(`${ORIGIN}/pyodide/wheels/`);
		expect(py.globals.get('_haruspex_plotlyjs_url')).toBe(`${ORIGIN}/plotly/plotly.min.js`);
	});

	it('reports load_error when Pyodide fails to load', async () => {
		await load(Promise.reject(new Error('wasm missing')));
		expect(posted).toEqual([{ kind: 'load_error', error: 'wasm missing' }]);
	});

	it('says the runtime is missing when pyodide.asm.mjs is not served', async () => {
		origFetch.mockResolvedValue(new Response('<html>', { status: 404 }));
		await load(Promise.reject(new TypeError('Importing a module script failed.')));
		await settle();
		expect(origFetch).toHaveBeenCalledWith(`${ORIGIN}/pyodide/pyodide.asm.mjs`, {
			method: 'HEAD'
		});
		expect(posted).toEqual([
			{
				kind: 'load_error',
				error:
					'The Python runtime is missing from /pyodide/. In a dev checkout, run ./scripts/fetch-pyodide.sh.',
				runtimeMissing: true
			}
		]);
	});

	it("says the runtime is missing when a built app serves its page in the file's place", async () => {
		// tauri:// answers a missing file with the SPA's index.html and a 200.
		origFetch.mockResolvedValue(
			new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
		);
		await load(Promise.reject(new TypeError("'text/html' is not a valid JavaScript MIME type.")));
		await settle();
		expect(posted).toEqual([expect.objectContaining({ kind: 'load_error', runtimeMissing: true })]);
	});

	it('keeps the load error when the runtime is served', async () => {
		origFetch.mockResolvedValue(new Response('', { status: 200 }));
		await load(Promise.reject(new Error('wasm missing')));
		await settle();
		expect(posted).toEqual([{ kind: 'load_error', error: 'wasm missing' }]);
	});

	it('answers a run that arrives before Pyodide loads with an error result', async () => {
		await load(new Promise(() => {}));
		send({ kind: 'run', id: 'early', code: 'USER' });
		send({ kind: 'install', id: 'early2', package: 'x' });
		await settle();
		expect(doneFor('early').error).toBe('Pyodide is not loaded');
		expect(doneFor('early2').error).toBe('Pyodide is not loaded');
	});

	it('applies an interrupt buffer that arrived before Pyodide finished loading', async () => {
		let resolve!: (v: unknown) => void;
		await load(new Promise((r) => (resolve = r)));
		const buffer = new SharedArrayBuffer(4);
		send({ kind: 'set_interrupt_buffer', buffer });
		expect(py.interruptBuffers).toHaveLength(0);
		resolve(py.api);
		await settle();
		expect(py.interruptBuffers).toHaveLength(1);
		expect(py.interruptBuffers[0].buffer).toBe(buffer);
	});

	it('applies an interrupt buffer straight away once loaded', async () => {
		await boot();
		const buffer = new SharedArrayBuffer(4);
		send({ kind: 'set_interrupt_buffer', buffer });
		expect(py.interruptBuffers.map((b) => b.buffer)).toEqual([buffer]);
	});
});

describe('python.worker run', () => {
	it('signals the package phase, then exec, streams stdout, and posts the result', async () => {
		await boot();
		const destroyed: string[] = [];
		py.userCode = () => {
			py.stdout('hello');
			return { toString: () => '42', destroy: () => destroyed.push('value') };
		};
		const result = await run('USER print("hello"); 42');
		expect(kinds()).toEqual(['pkg_phase_start', 'exec_start', 'stdout', 'done']);
		expect(posted[2]).toEqual({ kind: 'stdout', id: 'r1', data: 'hello\n' });
		expect(result.result).toBe('repr:42');
		expect(result.stdout).toBe('hello\n');
		expect(result.error).toBeNull();
		expect(destroyed).toEqual(['value']);
	});

	it('leaves result empty when the code evaluates to nothing', async () => {
		await boot();
		expect((await run('USER x = 1')).result).toBe('');
	});

	it('turns a Python exception into an error result', async () => {
		await boot();
		py.userCode = () => {
			py.stderr('Traceback ...');
			throw new Error('ZeroDivisionError: division by zero');
		};
		const result = await run('USER 1/0');
		expect(result.error).toBe('ZeroDivisionError: division by zero');
		expect(result.stderr).toBe('Traceback ...\n');
	});

	it('installs a missing module and runs again', async () => {
		await boot();
		let calls = 0;
		py.userCode = () => {
			if (calls++ === 0) throw new Error("ModuleNotFoundError: No module named 'foo.bar'");
			return 'ok';
		};
		const result = await run('USER import foo.bar');
		expect(result.error).toBeNull();
		expect(result.result).toBe('repr:ok');
		expect(result.stderr).toContain('[haruspex] auto-installed foo');
		expect(py.globals.get('_haruspex_retry_pkg')).toBe('foo');
		expect(posted).toContainEqual({
			kind: 'install_progress',
			id: 'r1',
			package: 'foo',
			phase: 'downloading'
		});
		// Back to the install phase for the retry, then exec again.
		expect(kinds().filter((k) => k === 'pkg_phase_start')).toHaveLength(2);
		expect(kinds().filter((k) => k === 'exec_start')).toHaveLength(2);
	});

	it('reads the package from a pip-install hint in a custom ImportError', async () => {
		await boot();
		let calls = 0;
		py.userCode = () => {
			if (calls++ === 0)
				throw new Error("ImportError: requires numpy-ext. $ pip install 'numpy-ext'");
			return 1;
		};
		const result = await run('USER import thing');
		expect(result.error).toBeNull();
		expect(result.stderr).toContain('auto-installed numpy-ext');
	});

	it('gives up when the same module is still missing after installing it', async () => {
		await boot();
		py.userCode = () => {
			throw new Error("No module named 'ghost'");
		};
		const result = await run('USER import ghost');
		expect(result.error).toBe("No module named 'ghost'");
		expect(result.stderr.match(/auto-installed ghost/g)).toHaveLength(1);
	});

	it('does not post output written outside a run', async () => {
		await boot();
		await run('USER pass');
		posted.length = 0;
		py.stdout('stray');
		expect(posted).toEqual([]);
	});

	it('acknowledges reset with an empty result', async () => {
		await boot();
		send({ kind: 'reset', id: 'z' });
		expect(doneFor('z')).toMatchObject({ error: null, result: '', duration_ms: 0 });
	});
});

describe('python.worker install', () => {
	it('reports each phase and the installed package', async () => {
		await boot();
		const installed: string[] = [];
		py.micropipInstall = async (n) => void installed.push(n);
		send({ kind: 'install', id: 'i1', package: 'requests' });
		await settle();
		expect(installed).toEqual(['requests']);
		expect(posted.map((m) => (m.kind === 'install_progress' ? m.phase : m.kind))).toEqual([
			'pkg_phase_start',
			'resolving',
			'downloading',
			'installing',
			'done'
		]);
		expect(doneFor('i1').result).toBe('installed requests');
	});

	it('reports a failed install as an error result', async () => {
		await boot();
		py.micropipInstall = async () => {
			throw new Error("Can't find a pure Python 3 wheel");
		};
		send({ kind: 'install', id: 'i2', package: 'nope' });
		await settle();
		expect(doneFor('i2').error).toBe("Can't find a pure Python 3 wheel");
	});
});

describe('python.worker list_globals', () => {
	it('returns the string names Python reports and frees the proxy', async () => {
		await boot();
		let freed = false;
		py.globalsProxy = { toJs: () => ['df', 3, 'x'], destroy: () => (freed = true) };
		send({ kind: 'list_globals', id: 'g' });
		await settle();
		expect(posted).toEqual([{ kind: 'globals', id: 'g', names: ['df', 'x'] }]);
		expect(freed).toBe(true);
	});

	it('returns no names when Python throws', async () => {
		await boot();
		py.globalsProxy = () => {
			throw new Error('boom');
		};
		send({ kind: 'list_globals', id: 'g' });
		await settle();
		expect(posted).toEqual([{ kind: 'globals', id: 'g', names: [] }]);
	});
});

describe('python.worker host bridges', () => {
	type Bridge = (...args: unknown[]) => unknown;
	const bridge = (name: string) => py.globals.get(name) as Bridge;

	it('save posts the request and resolves with the host answer', async () => {
		await boot();
		const p = bridge('_haruspex_save')('out.txt', 'hi') as Promise<unknown>;
		const req = posted.find((m) => m.kind === 'save_request');
		if (!req || req.kind !== 'save_request') throw new Error('no save_request');
		expect(req).toMatchObject({ filename: 'out.txt', content: 'hi' });
		send({
			kind: 'save_response',
			id: req.id,
			request_id: req.request_id,
			ok: true,
			path: '/w/out.txt',
			bytes: 2
		});
		await expect(p).resolves.toEqual({ path: '/w/out.txt', bytes: 2 });
	});

	it('save copies bytes out of Python memory and rejects other content', async () => {
		await boot();
		const src = new Uint8Array([1, 2, 3]);
		void bridge('_haruspex_save')('b.bin', src);
		const req = posted.find((m) => m.kind === 'save_request');
		if (!req || req.kind !== 'save_request') throw new Error('no save_request');
		expect(req.content).toEqual(src);
		expect(req.content).not.toBe(src);
		await expect(bridge('_haruspex_save')('x', 42) as Promise<unknown>).rejects.toThrow(
			'content must be str or bytes'
		);
	});

	it('save rejects with the host error', async () => {
		await boot();
		const p = bridge('_haruspex_save')('../x', 'a') as Promise<unknown>;
		const req = posted.find((m) => m.kind === 'save_request');
		if (!req || req.kind !== 'save_request') throw new Error('no save_request');
		send({ kind: 'save_response', id: req.id, request_id: req.request_id, ok: false });
		await expect(p).rejects.toThrow('haruspex.save failed');
	});

	it('delete round-trips through the host', async () => {
		await boot();
		const p = bridge('_haruspex_delete')('old.csv') as Promise<unknown>;
		const req = posted.find((m) => m.kind === 'delete_request');
		if (!req || req.kind !== 'delete_request') throw new Error('no delete_request');
		expect(req.filename).toBe('old.csv');
		send({
			kind: 'delete_response',
			id: req.id,
			request_id: req.request_id,
			ok: false,
			error: 'not found'
		});
		await expect(p).rejects.toThrow('not found');
	});

	it('fetch converts headers and a string body, and resolves with the response', async () => {
		await boot();
		const headers = { toJs: () => ({ Accept: 'json', Skip: null, N: 1 }) };
		const p = bridge('_haruspex_fetch')('https://x.test/a', 'POST', headers, 'hé') as Promise<{
			status: number;
		}>;
		const req = posted.find((m) => m.kind === 'fetch_request');
		if (!req || req.kind !== 'fetch_request') throw new Error('no fetch_request');
		expect(req.url).toBe('https://x.test/a');
		expect(req.init.method).toBe('POST');
		expect(req.init.headers).toEqual({ Accept: 'json', N: '1' });
		expect(new TextDecoder().decode(req.init.body)).toBe('hé');
		send({
			kind: 'fetch_response',
			id: req.id,
			request_id: req.request_id,
			ok: true,
			status: 201,
			headers: {},
			body: new Uint8Array(),
			url: 'https://x.test/a'
		});
		await expect(p).resolves.toMatchObject({ status: 201 });
	});

	it('fetch rejects when the host reports an error, whatever the status', async () => {
		await boot();
		const p = bridge('_haruspex_fetch')('https://x.test', null, null, null) as Promise<unknown>;
		const req = posted.find((m) => m.kind === 'fetch_request');
		if (!req || req.kind !== 'fetch_request') throw new Error('no fetch_request');
		expect(req.init.method).toBeUndefined();
		expect(req.init.body).toBeUndefined();
		send({
			kind: 'fetch_response',
			id: req.id,
			request_id: req.request_id,
			ok: false,
			status: 0,
			headers: {},
			body: new Uint8Array(),
			url: '',
			error: 'blocked by policy'
		});
		await expect(p).rejects.toThrow('blocked by policy');
	});

	it('emits images and HTML only while a run is active', async () => {
		await boot();
		bridge('_haruspex_emit_image')('image/png', new Uint8Array([9]));
		bridge('_haruspex_emit_html')('<b>x</b>', null, null, false);
		expect(posted).toEqual([]);

		py.userCode = () => {
			bridge('_haruspex_emit_image')('image/png', { toJs: () => new Uint8Array([7, 8]) });
			bridge('_haruspex_emit_image')('image/png', 'not bytes');
			bridge('_haruspex_emit_html')('<table/>', 5, 100, 1);
			return undefined;
		};
		await run('USER plot()');
		const artifacts = posted.filter((m) => m.kind === 'artifact');
		expect(artifacts).toEqual([
			{
				kind: 'artifact',
				id: 'r1',
				mime: 'image/png',
				payload: { kind: 'bytes', bytes: new Uint8Array([7, 8]) }
			},
			{
				kind: 'artifact',
				id: 'r1',
				mime: 'text/html',
				payload: { kind: 'text', text: '<table/>' },
				truncated: { shown: 5, total: 100 },
				interactive: true
			}
		]);
	});

	it('install status maps an unknown phase to downloading', async () => {
		await boot();
		py.userCode = () => {
			bridge('_haruspex_install_status')('plotly', 'bundled');
			bridge('_haruspex_install_status')('folium', 'weird');
			return undefined;
		};
		await run('USER import plotly');
		const phases = posted
			.filter((m) => m.kind === 'install_progress')
			.map((m) => (m.kind === 'install_progress' ? `${m.package}:${m.phase}` : ''));
		expect(phases).toEqual(['plotly:bundled', 'folium:downloading']);
	});
});

describe('python.worker workdir sync', () => {
	it('writes new files, removes deleted ones, and acks', async () => {
		await boot();
		py.files.set('/w/gone.txt', new Uint8Array([1]));
		send({
			kind: 'sync_workdir_files',
			sync_id: 's1',
			workdir_abs: '/w',
			to_sync: [
				{ path: 'sub/a.csv', abs_path: '/w/sub/a.csv', bytes: new Uint8Array([5]), mtime: 1 }
			],
			deleted: ['gone.txt'],
			skipped: []
		});
		await settle();
		expect(posted).toEqual([{ kind: 'sync_workdir_ack', sync_id: 's1' }]);
		expect([...py.files.keys()]).toEqual(['/w/sub/a.csv']);
		expect(py.internalScripts.at(-1)).toContain('_os.chdir("/w")');
	});

	it('acks with an error before Pyodide has loaded', async () => {
		await load(new Promise(() => {}));
		posted.length = 0;
		send({
			kind: 'sync_workdir_files',
			sync_id: 's0',
			workdir_abs: '/w',
			to_sync: [],
			deleted: [],
			skipped: []
		});
		await settle();
		expect(posted).toEqual([
			{ kind: 'sync_workdir_ack', sync_id: 's0', error: 'pyodide not loaded' }
		]);
	});

	const sync = (sync_id: string, over: Record<string, unknown> = {}) =>
		send({
			kind: 'sync_workdir_files',
			sync_id,
			workdir_abs: '/w',
			to_sync: [],
			deleted: [],
			skipped: [],
			...over
		});

	it('hands what it skipped to the next run as notes, not stderr', async () => {
		await boot();
		sync('s2', { skipped: [{ path: 'huge.bin', reason: 'over 50 MB' }] });
		await settle();
		const result = await run('USER pass');
		expect(result.notes).toEqual(['huge.bin was not copied into the sandbox: over 50 MB']);
		expect(result.stderr).not.toContain('huge.bin');
	});

	it('notes a file it could not write', async () => {
		await boot();
		py.writeError = new Error('disk full');
		sync('s3', {
			to_sync: [{ path: 'a.csv', abs_path: '/w/a.csv', bytes: new Uint8Array([1]), mtime: 1 }]
		});
		await settle();
		const [note] = (await run('USER pass')).notes;
		expect(note).toMatch(/^could not copy a\.csv into the sandbox: .*disk full/);
	});

	it("keeps only the latest sync's notes, and gives them to one run only", async () => {
		await boot();
		sync('s4', { skipped: [{ path: 'old.bin', reason: 'too big' }] });
		await settle();
		sync('s5', { skipped: [{ path: 'new.bin', reason: 'too big' }] });
		await settle();
		expect((await run('USER pass', 'r1')).notes).toEqual([
			'new.bin was not copied into the sandbox: too big'
		]);
		expect((await run('USER pass', 'r2')).notes).toEqual([]);
	});
});

describe('python.worker network shims', () => {
	it('serves Pyodide assets locally and falls back to the CDN on a miss', async () => {
		await boot();
		const cdn = { ok: true, tag: 'cdn' } as unknown as Response;
		origFetch.mockImplementation(async (url: string) =>
			url.startsWith(ORIGIN) ? ({ ok: false } as Response) : cdn
		);
		const resp = await fakeSelf.fetch(`${ORIGIN}/pyodide/rare-1.0-py3-none-any.whl`);
		expect(resp).toBe(cdn);
		expect(origFetch.mock.calls.at(-1)?.[0]).toBe(
			'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/rare-1.0-py3-none-any.whl'
		);
	});

	it('leaves fetches outside /pyodide/ alone', async () => {
		await boot();
		const ok = { ok: false, status: 404 } as Response;
		origFetch.mockResolvedValue(ok);
		expect(await fakeSelf.fetch('https://pypi.org/simple/x/')).toBe(ok);
		expect(origFetch.mock.calls.map((c) => c[0])).toEqual(['https://pypi.org/simple/x/']);
	});

	it('rewrites cross-origin XHRs onto the haruspexfetch scheme', async () => {
		await boot();
		const xhr = new XMLHttpRequest() as unknown as FakeXHR;
		(xhr as unknown as XMLHttpRequest).open('GET', 'https://api.test/q?k=1&b=2', false);
		expect(xhr.opened).toEqual([
			'GET',
			'haruspexfetch://localhost/?u=' + encodeURIComponent('https://api.test/q?k=1&b=2'),
			false,
			null,
			null
		]);
	});

	it('passes same-origin and non-http XHRs through, defaulting to async', async () => {
		await boot();
		const a = new XMLHttpRequest() as unknown as FakeXHR;
		(a as unknown as XMLHttpRequest).open('GET', '/pyodide/x.json');
		expect(a.opened).toEqual(['GET', '/pyodide/x.json', true, null, null]);
		const b = new XMLHttpRequest() as unknown as FakeXHR;
		(b as unknown as XMLHttpRequest).open('GET', 'data:text/plain,hi');
		expect(b.opened[1]).toBe('data:text/plain,hi');
	});
});
