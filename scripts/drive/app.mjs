/**
 * The app under drive: the e2e build started through tauri-driver on a
 * private X display, its backend pointed at a model server, and the
 * operations `drive` offers on it. Everything a user would press is pressed
 * in the UI; `window.__haruspexDrive` (src/lib/e2e/driveHooks.ts) is only for
 * reading state and for things with no button.
 *
 * Used in one process by `drive run`, and held open by `drive start`'s
 * long-lived process for the short-lived commands.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remote } from 'webdriverio';
import { appBinary, BIN_DIR, ROOT, STUB_PIDS } from '../../e2e/app/paths.mjs';
import { e2eDataDirs } from '../../e2e/app/wdio.conf.mjs';
import { createFakeLlm, MODEL_ID } from '../../e2e/fake-llm/server.mjs';
import { summarize, transcript } from './render.mjs';

export const FIXTURE = join(ROOT, 'e2e', 'fixtures', 'average-bug');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** JSON with sorted keys, so two copies of the same data compare equal. */
export function stableJson(v) {
	return JSON.stringify(v, (_, x) =>
		x && typeof x === 'object' && !Array.isArray(x)
			? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
			: x
	);
}

// --- processes ------------------------------------------------------------

/** Everything started here, killed on any exit. */
const children = [];
/** Temporary folders of our own (not the workspace), removed on exit. */
const scratchDirs = [];

function scratch() {
	const dir = mkdtempSync(join(tmpdir(), 'haruspex-drive-'));
	scratchDirs.push(dir);
	return dir;
}

export function freePort() {
	return new Promise((res, rej) => {
		const srv = createServer();
		srv.on('error', rej);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => res(port));
		});
	});
}

/** An X display number nothing is using. */
function freeDisplay() {
	for (let n = 90; n < 200; n++) {
		if (!existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`)) return n;
	}
	throw new Error('no free X display number');
}

function which(cmd) {
	return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).stdout.trim() || null;
}

/**
 * A private X server for headless runs. Xvfb when there is one, otherwise
 * TigerVNC's Xvnc with its VNC port off — either way no window reaches the
 * user's desktop.
 */
async function startDisplay() {
	const n = freeDisplay();
	const xvfb = which('Xvfb');
	const xvnc = which('Xvnc');
	let child;
	if (xvfb) {
		child = spawn(xvfb, [`:${n}`, '-screen', '0', '1400x900x24', '-nolisten', 'tcp'], {
			stdio: 'ignore',
			detached: true
		});
	} else if (xvnc) {
		child = spawn(
			xvnc,
			[`:${n}`, '-geometry', '1400x900', '-depth', '24', '-SecurityTypes', 'None'].concat(
				// No TCP port; Xvnc insists on somewhere to listen, so a private socket.
				['-rfbport', '-1', '-rfbunixpath', join(scratch(), 'vnc.sock')],
				['-nolisten', 'tcp']
			),
			{ stdio: 'ignore', detached: true }
		);
	} else {
		throw new Error('headless needs Xvfb or Xvnc; neither is installed (or pass --show)');
	}
	// SIGTERM, not SIGKILL: the X server removes its own socket and lock.
	child.signal = 'SIGTERM';
	children.push(child);
	for (let i = 0; i < 50; i++) {
		if (existsSync(`/tmp/.X11-unix/X${n}`)) return `:${n}`;
		if (child.exitCode !== null) break;
		await sleep(100);
	}
	throw new Error(`the X server for :${n} did not start`);
}

/**
 * Kill any test-build process still running from BIN_DIR: the app and its
 * stub sidecars, by executable path, so only ever the test build's and never
 * the user's Haruspex.
 */
export function killTestBuild() {
	if (process.platform !== 'linux') return;
	for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
		try {
			const exe = readlinkSync(`/proc/${pid}/exe`);
			if (exe.startsWith(BIN_DIR + '/')) process.kill(Number(pid), 'SIGKILL');
		} catch {
			// not ours to read, or gone
		}
	}
}

/** Kill what we started, then any test-build process still running. */
export function cleanup() {
	for (const child of children.reverse()) {
		if (child.exitCode !== null || child.pid === undefined) continue;
		try {
			// Detached: the pid is its own process group.
			process.kill(-child.pid, child.signal ?? 'SIGKILL');
		} catch {
			try {
				child.kill(child.signal ?? 'SIGKILL');
			} catch {
				// gone
			}
		}
	}
	children.length = 0;
	for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	killTestBuild();
}

async function waitForPort(port, driver) {
	for (let i = 0; i < 100; i++) {
		if (driver.exitCode !== null) throw new Error(`tauri-driver exited (${driver.exitCode})`);
		const open = await new Promise((res) => {
			const sock = connect(port, '127.0.0.1');
			sock.once('connect', () => (sock.destroy(), res(true)));
			sock.once('error', () => res(false));
		});
		if (open) return;
		await sleep(100);
	}
	throw new Error(`tauri-driver never listened on ${port}`);
}

// --- the model server ------------------------------------------------------

export async function firstModel(baseUrl, apiKey) {
	const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
	const r = await fetch(`${baseUrl}/v1/models`, { headers, signal: AbortSignal.timeout(15_000) });
	if (!r.ok) throw new Error(`${baseUrl}/v1/models: HTTP ${r.status}`);
	const body = await r.json();
	const id = body.data?.[0]?.id;
	if (!id) throw new Error(`${baseUrl}/v1/models lists no models`);
	return id;
}

/** A fresh copy of the fixture project, kept afterwards so its changes can be read. */
export function fixtureCopy() {
	const folder = join(mkdtempSync(join(tmpdir(), 'haruspex-drive-')), 'average-bug');
	cpSync(FIXTURE, folder, { recursive: true });
	return folder;
}

// --- the app ----------------------------------------------------------------

/**
 * One app under drive.
 *
 * `opts`: `baseUrl`, `model`, `apiKey`, `fake` (scenario name) or `record`
 * (scenario name, with `baseUrl` as the upstream), `folder`, `show`,
 * `autoApprove`, `verbosePayloads`, `outDir`.
 */
export class App {
	constructor(opts, log = () => {}) {
		this.opts = opts;
		this.log = log;
		this.browser = null;
		this.fake = null;
		this.driverOut = [];
		// One WebDriver command at a time: `send --wait` polls while `state` reads.
		this.queue = Promise.resolve();
	}

	/** Run `fn` with the browser, after anything already running with it. */
	exclusive(fn) {
		const run = this.queue.then(() => fn(this.browser));
		this.queue = run.catch(() => {});
		return run;
	}

	/** Call a drive hook in the page. */
	call(name, ...args) {
		return this.exclusive(async (browser) => {
			// execute() waits for a returned promise.
			const res = await browser.execute(
				async (name, args) => {
					const hooks = window.__haruspexDrive;
					if (!hooks) return { error: 'no drive hooks: rebuild with npm run e2e:app:build' };
					try {
						return { value: await hooks[name](...args) };
					} catch (e) {
						return { error: String(e?.message ?? e) };
					}
				},
				name,
				args
			);
			if (res.error) throw new Error(`${name}: ${res.error}`);
			return res.value;
		});
	}

	async waitForHooks() {
		await this.browser.waitUntil(
			() =>
				this.browser.execute(() => document.readyState === 'complete' && !!window.__haruspexDrive),
			{ timeout: 60_000, interval: 250, timeoutMsg: 'the app never loaded its drive hooks' }
		);
	}

	/** Start the model server (if fake), the display, tauri-driver and the app. */
	async start() {
		const o = this.opts;
		if (!existsSync(appBinary())) {
			throw new Error(`no test build at ${appBinary()}: run npm run e2e:app:build`);
		}
		mkdirSync(o.outDir, { recursive: true });

		let appBase = o.baseUrl;
		let model = o.model;
		if (o.fake || o.record) {
			let upstreamModel;
			if (o.record) {
				if (!o.baseUrl) throw new Error('--record needs --base-url, the server to record');
				upstreamModel = o.model ?? (await firstModel(o.baseUrl, o.apiKey));
			}
			this.fake = createFakeLlm({
				scenario: o.fake,
				record: o.record,
				upstream: o.record ? `${o.baseUrl}/v1` : undefined,
				upstreamModel,
				upstreamKey: o.apiKey || undefined
			});
			const port = await this.fake.listen(await freePort());
			appBase = `http://127.0.0.1:${port}`;
			model = MODEL_ID;
			this.log(
				o.record
					? `recording scenario ${o.record} from ${upstreamModel} at ${o.baseUrl}`
					: `fake model, scenario ${o.fake}, at ${appBase}`
			);
		} else {
			if (!appBase) throw new Error('--base-url, --fake or --record is required');
			model ??= await firstModel(appBase, o.apiKey);
			this.log(`model ${model} at ${appBase}`);
		}
		this.meta = { model: o.record ? `${model} (recording)` : model, baseUrl: appBase };

		// A fresh profile: the e2e identifier's data, never the user's.
		for (const dir of e2eDataDirs()) rmSync(dir, { recursive: true, force: true });
		rmSync(STUB_PIDS, { recursive: true, force: true });
		mkdirSync(STUB_PIDS, { recursive: true });

		const env = { ...process.env, E2E_STUB_PIDS: STUB_PIDS };
		if (!o.show) {
			env.DISPLAY = await startDisplay();
			delete env.WAYLAND_DISPLAY;
			env.GDK_BACKEND = 'x11';
			// No GPU on a virtual X server.
			env.WEBKIT_DISABLE_DMABUF_RENDERER = '1';
			env.LIBGL_ALWAYS_SOFTWARE = '1';
			this.log(`headless on ${env.DISPLAY}`);
		} else {
			env.GDK_BACKEND ??= 'x11';
		}
		this.display = env.DISPLAY ?? null;

		// Ports of our own, so a test run or another driver can't collide.
		const port = await freePort();
		const nativePort = await freePort();
		const driver = spawn(
			process.env.TAURI_DRIVER ?? 'tauri-driver',
			['--port', String(port), '--native-port', String(nativePort)],
			{ env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
		);
		children.push(driver);
		driver.stdout.on('data', (d) => this.driverOut.push(d));
		driver.stderr.on('data', (d) => this.driverOut.push(d));

		await waitForPort(port, driver);
		this.browser = await remote({
			hostname: '127.0.0.1',
			port,
			logLevel: 'error',
			capabilities: { 'tauri:options': { application: appBinary() } }
		});
		await this.waitForHooks();

		// Settings → Inference, as Test connection would save it.
		const inference = await this.call(
			'probeRemote',
			appBase,
			o.fake || o.record ? '' : o.apiKey,
			model
		);
		this.log(`backend ${inference.remoteBackendKind}, context ${inference.remoteContextSize}`);
		const settings = {
			dismissedStartupNotice: true,
			inferenceBackend: inference,
			codeAutoApprove: o.autoApprove
		};
		await this.browser.execute((s) => {
			localStorage.clear();
			localStorage.setItem('haruspex-settings', JSON.stringify(s));
			localStorage.setItem('haruspex.activeTab', 'code');
			location.replace('/');
		}, settings);
		await sleep(500);
		await this.waitForHooks();
		if (o.verbosePayloads) await this.call('setVerbosePayloads', true);
		if (o.api) {
			this.api = await this.call('ownerApi', await freePort());
			this.log(`owner API at ${this.api.base}`);
		}
	}

	/** Sessions open in the main window, as its drive hook reads them. */
	async sessions() {
		return this.call('codeSessions');
	}

	/**
	 * Run an engine operation in whichever window has the session: through
	 * the owner API over HTTP when started with `--api`, else through Rust
	 * from the page.
	 */
	async engine(op) {
		if (!this.api) return this.call('engine', op);
		const r = await fetch(`${this.api.base}/api/v1/op`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${this.api.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(op)
		});
		const body = await r.json().catch(() => ({}));
		if (!r.ok) throw new Error(`${op.type}: HTTP ${r.status}: ${body.error ?? 'no reason given'}`);
		return body.value;
	}

	/** A pairing link that opens the web client as a new device. */
	async webUrl() {
		if (!this.api) throw new Error('web-url needs a driver started with --api');
		const code = await this.call('pairCode', `web ${new Date().toISOString().slice(11, 19)}`);
		return { url: `${this.api.base}/app/#pair=${code}` };
	}

	/** Read the owner API's event stream for `seconds`. */
	async apiEvents(seconds = 3) {
		if (!this.api) throw new Error('api-events needs a driver started with --api');
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), seconds * 1000);
		const events = [];
		try {
			const r = await fetch(`${this.api.base}/api/v1/events`, {
				headers: { Authorization: `Bearer ${this.api.token}` },
				signal: ac.signal
			});
			if (!r.ok) throw new Error(`events: HTTP ${r.status}`);
			const decoder = new TextDecoder();
			let buf = '';
			for await (const chunk of r.body) {
				buf += decoder.decode(chunk, { stream: true });
				let i;
				while ((i = buf.indexOf('\n\n')) >= 0) {
					const frame = buf.slice(0, i);
					buf = buf.slice(i + 2);
					for (const line of frame.split('\n')) {
						if (line.startsWith('data:')) events.push(JSON.parse(line.slice(5)));
					}
				}
			}
		} catch (e) {
			if (e.name !== 'AbortError') throw e;
		} finally {
			clearTimeout(timer);
		}
		return events;
	}

	/** A session in any window, through the engine. */
	async session(id) {
		return this.engine({ type: 'session.get', id });
	}

	/** New session in `folder` (default: a fresh fixture copy), through the dialog. */
	async newSession(folder) {
		folder ??= this.opts.folder ?? fixtureCopy();
		if (!existsSync(folder)) throw new Error(`no folder ${folder}`);
		const before = new Set((await this.sessions()).map((s) => s.id));
		// The dialog offers the last folder used.
		await this.call('updateSettings', { codeLastRoot: folder });
		await this.exclusive(async (browser) => {
			// The empty pane's button when nothing is open, else the tab strip's +.
			const empty = await browser.$('.workspace > .main > .empty').$('button=New session');
			const button = (await empty.isExisting())
				? empty
				: await browser.$('button[aria-label="New session"]');
			await button.waitForClickable({ timeout: 30_000 });
			await button.click();
			const start = await browser.$('button=Start session');
			await start.waitForClickable({ timeout: 15_000 });
			await start.click();
		});
		let made = null;
		for (let i = 0; i < 60 && !made; i++) {
			made = (await this.sessions()).find((s) => !before.has(s.id)) ?? null;
			if (!made) await sleep(250);
		}
		if (!made) throw new Error('the new session never appeared');
		this.log(`session ${made.id} in ${folder}`);
		return { id: made.id, root: made.root };
	}

	/** Show the session's pane, then return its input box. */
	async input(id) {
		await this.call('activateSession', id);
		return this.exclusive(async (browser) => {
			const input = await browser.$(`[data-session-id="${id}"] textarea[aria-label="Message"]`);
			if (!(await input.isExisting())) {
				throw new Error(`session ${id} is not in the main window: use --via engine`);
			}
			await input.waitForEnabled({ timeout: 30_000 });
			return input;
		});
	}

	async type(id, text) {
		const input = await this.input(id);
		await this.exclusive(async (browser) => {
			await input.setValue(text);
			await browser.keys('Enter');
		});
	}

	/**
	 * Start a turn: typed into the input box, or with `via: 'engine'` sent as
	 * an operation. With `wait`, return when it ends or needs someone.
	 */
	async send(id, text, { wait = false, timeoutMs = 600_000, via = 'ui' } = {}) {
		const s = await this.session(id);
		if (s.status !== 'idle') {
			throw new Error(`session ${id} is ${s.status}; use steer, or wait for it`);
		}
		if (via === 'engine') await this.engine({ type: 'session.send', id, text });
		else await this.type(id, text);
		if (!wait) return { state: 'sent' };
		return this.wait(id, { timeoutMs, after: s.messages.length });
	}

	/** Queue a steering message for a running turn's next step. */
	async steer(id, text, { via = 'ui' } = {}) {
		const s = await this.session(id);
		if (s.status === 'idle') throw new Error(`session ${id} is idle; use send`);
		if (via === 'engine') await this.engine({ type: 'session.send', id, text });
		else await this.type(id, text);
		return { state: 'queued' };
	}

	/** Prompts the session's turn is waiting on, in any window. */
	async promptsFor(id) {
		const all = await this.engine({ type: 'prompts.list' });
		return all.filter((p) => p.sessionId === id || p.sessionId === null);
	}

	/**
	 * Wait for the session to go idle (with more than `after` messages, when
	 * given). Returns early when the turn needs a person: a command approval
	 * or another prompt, or a command handed to a Shell tab.
	 */
	async wait(id, { timeoutMs = 600_000, after = 0 } = {}) {
		const started = Date.now();
		let lastReport = 0;
		// A turn that has only just been sent may not have left idle yet.
		await sleep(300);
		for (;;) {
			const s = await this.session(id);
			const elapsedMs = Date.now() - started;
			const result = (state, extra = {}) => ({
				state,
				elapsedMs,
				...extra,
				summary: summarize(s)
			});
			if (s.status === 'idle' && s.messages.length > after) return result('done');
			const [prompt] = await this.promptsFor(id);
			if (prompt?.kind === 'command') {
				return result('approval', { approval: { ...prompt.detail, promptId: prompt.promptId } });
			}
			if (prompt) return result('prompt', { prompt });
			if (s.status === 'waiting-shell') return result('waiting-shell');
			if (elapsedMs > timeoutMs) return result('timeout');
			if (elapsedMs - lastReport >= 15_000) {
				lastReport = elapsedMs;
				const running = s.searchSteps.filter((x) => x.status === 'running').map((x) => x.toolName);
				this.log(
					`  ${id.slice(0, 8)} ${Math.round(elapsedMs / 1000)}s: ${s.status}, ${s.searchSteps.length} tool steps` +
						(running.length ? ` (running ${running.join(', ')})` : '') +
						`, streaming ${s.streamingContent.length} chars`
				);
			}
			await sleep(500);
		}
	}

	/** Press Stop on the session's running turn, or send `session.stop`. */
	async cancel(id, { via = 'ui' } = {}) {
		if (via === 'engine') return this.engine({ type: 'session.stop', id });
		await this.call('activateSession', id);
		await this.exclusive(async (browser) => {
			const stop = await browser.$(`[data-session-id="${id}"] button.stop`);
			if (!(await stop.isExisting())) throw new Error(`session ${id} has no turn to stop`);
			await stop.click();
		});
		return { state: 'stopping' };
	}

	/** Every prompt showing, in every window. */
	async pendingApproval() {
		return this.engine({ type: 'prompts.list' });
	}

	/**
	 * Answer Run this command? with `allow` (once), `allow-session` or `deny`:
	 * the modal's button, or with `via: 'engine'` a `prompts.answer`, which
	 * also reaches a detached window's prompt.
	 */
	async approve(choice, { via = 'ui' } = {}) {
		const labels = { allow: 'Allow once', 'allow-session': 'Allow for this session', deny: 'Deny' };
		const choices = { allow: 'allow_once', 'allow-session': 'allow_session', deny: 'deny' };
		const label = labels[choice];
		if (!label) throw new Error(`approve takes ${Object.keys(labels).join(', ')}`);
		const prompts = await this.engine({ type: 'prompts.list' });
		const pending = prompts.find((p) => p.kind === 'command');
		if (!pending) throw new Error('no command is waiting for approval');
		if (via === 'engine') {
			await this.engine({
				type: 'prompts.answer',
				promptId: pending.promptId,
				answer: { kind: 'command', choice: choices[choice] }
			});
		} else {
			await this.exclusive(async (browser) => {
				const button = await browser.$(`button*=${label}`);
				await button.waitForClickable({ timeout: 10_000 });
				await button.click();
			});
		}
		return { answered: choice, command: pending.detail.command, window: pending.window ?? null };
	}

	/** Every open session, in every window, or one. */
	async state(id, { asTranscript = false } = {}) {
		let list;
		if (id) list = [await this.session(id)];
		else {
			const open = (await this.engine({ type: 'sessions.list' })).filter((s) => s.status);
			list = await Promise.all(open.map((s) => this.session(s.id)));
		}
		if (asTranscript) return list.map((s) => transcript(s, this.meta)).join('\n\n');
		return id ? list[0] : list;
	}

	/** Engine events from every window, from `since` on. */
	async events(since = 0) {
		return this.call('engineEvents', since);
	}

	/**
	 * Whether the session's events, replayed, give the session `session.get`
	 * returns: the engine's one promise to a client away from the desktop.
	 * While a turn streams, the replay trails by a few tens of milliseconds,
	 * so `differs` naming only `streamingContent` or `roundText` then is lag;
	 * an idle session must match exactly.
	 */
	async consistent(id) {
		const mirror = await this.call('engineMirror', id);
		const actual = await this.session(id);
		const replayed = mirror.state ?? {};
		const differs = Object.keys({ ...replayed, ...actual }).filter(
			(k) => stableJson(replayed[k]) !== stableJson(actual[k])
		);
		return {
			consistent: !mirror.resync && differs.length === 0,
			differs,
			status: actual.status,
			resync: mirror.resync,
			events: mirror.seq
		};
	}

	/** Move the session to its own window, with the tab strip's ⤢. */
	async detach(id) {
		await this.call('activateSession', id);
		await this.exclusive(async (browser) => {
			const button = await browser.$('.tab.active button.detach');
			await button.waitForClickable({ timeout: 10_000 });
			await button.click();
		});
		for (let i = 0; i < 60; i++) {
			const row = (await this.engine({ type: 'sessions.list' })).find((s) => s.id === id);
			if (row?.window === `code-${id}`) return { id, window: row.window };
			await sleep(250);
		}
		throw new Error(`session ${id} never opened in a window of its own`);
	}

	async logs(since = 0) {
		const lines = await this.call('debugLogs');
		return { lines: lines.slice(since), next: lines.length };
	}

	async screenshot(path) {
		await this.exclusive((browser) => browser.saveScreenshot(path));
		return { path };
	}

	/**
	 * Minimise the window, and say whether the page now thinks it is hidden.
	 * On a private X display there is no window manager to iconify it, so it
	 * may stay `visible`: measure throttling with --show.
	 */
	async minimise() {
		return this.exclusive(async (browser) => {
			await browser.minimizeWindow();
			await sleep(500);
			return { visibility: await browser.execute(() => document.visibilityState) };
		});
	}

	async restore() {
		return this.exclusive(async (browser) => {
			await browser.setWindowRect(null, null, 1400, 900);
			await sleep(500);
			return { visibility: await browser.execute(() => document.visibilityState) };
		});
	}

	async scenario(name) {
		if (!this.fake || this.opts.record)
			throw new Error('scenario needs a driver started with --fake');
		const r = await fetch(`${this.meta.baseUrl}/__scenario`, {
			method: 'POST',
			body: JSON.stringify({ name })
		});
		if (!r.ok) throw new Error(`scenario ${name}: ${(await r.json()).error?.message}`);
		return r.json();
	}

	/** The requests the fake model has received since its scenario was set. */
	async requests() {
		if (!this.fake) throw new Error('requests needs a driver started with --fake or --record');
		return this.fake.requests;
	}

	async anyBusy() {
		const list = await this.engine({ type: 'sessions.list' });
		return list.some((s) => s.status && s.status !== 'idle');
	}

	/** Write every session's transcript and state, the debug log and a screenshot. */
	async saveOutputs() {
		const dir = this.opts.outDir;
		const written = [];
		const save = (name, body) => {
			writeFileSync(join(dir, name), body);
			written.push(name);
		};
		// Each part on its own: one failing still leaves the rest to read.
		const errors = [];
		const part = async (what, fn) => {
			try {
				await fn();
			} catch (e) {
				errors.push(`${what}: ${e?.message ?? e}`);
			}
		};
		if (this.browser) {
			await part('sessions', async () => {
				for (const s of await this.state()) {
					save(`transcript-${s.id}.md`, transcript(s, this.meta));
					save(`session-${s.id}.json`, JSON.stringify(s, null, '\t'));
				}
			});
			await part('debug log', async () =>
				save('debug.log', (await this.call('debugLogs')).join('\n') + '\n')
			);
			await part('screenshot', async () => {
				await this.screenshot(join(dir, 'screenshot.png'));
				written.push('screenshot.png');
			});
		}
		save('tauri-driver.log', Buffer.concat(this.driverOut));
		return errors.length ? { dir, files: written, errors } : { dir, files: written };
	}

	async stop() {
		if (this.browser) await this.browser.deleteSession().catch(() => {});
		this.browser = null;
		await this.fake?.close();
		cleanup();
	}
}
