#!/usr/bin/env node
/**
 * Drive the real app's Code tab against a real model, for reproducing agent
 * behaviour. Uses the e2e build (`npm run e2e:app:build`) through
 * tauri-driver, with the e2e identifier's data wiped first, so the user's own
 * Haruspex is never touched. See docs/testing.md, "Driving the app with a
 * real model".
 *
 *   node scripts/drive.mjs run --base-url http://compute:3000 --prompt "Fix the bug"
 *
 * Writes transcript.md, debug.log, session.json and screenshot.png to
 * e2e/drive-output/<timestamp>/ (or --out).
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { remote } from 'webdriverio';
import { appBinary, BIN_DIR, ROOT, STUB_PIDS } from '../e2e/app/paths.mjs';
import { e2eDataDirs } from '../e2e/app/wdio.conf.mjs';

const USAGE = `Usage: node scripts/drive.mjs run [options] --prompt "..." [--prompt "..."]

Options:
  --base-url URL       the OpenAI-compatible server (env DRIVE_BASE_URL)
  --model ID           the model; default: the first one /v1/models lists (env DRIVE_MODEL)
  --api-key-env NAME   read the API key from this environment variable
  --folder PATH        the session's project folder; default: a fresh copy of
                       e2e/fixtures/average-bug
  --prompt TEXT        a message to send; repeat for more turns
  --timeout SECS       the most one turn may take (default 600)
  --out DIR            where to write the results (default e2e/drive-output/<timestamp>)
  --show               show the window (default: headless, on a private Xvnc display)
  --verbose-payloads   log whole request bodies in debug.log, not digests
  --no-auto-approve    leave Settings → Code → auto-approve off (risky commands then wait)`;

const FIXTURE = join(ROOT, 'e2e', 'fixtures', 'average-bug');

function parse() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			'base-url': { type: 'string' },
			model: { type: 'string' },
			'api-key-env': { type: 'string' },
			folder: { type: 'string' },
			prompt: { type: 'string', multiple: true },
			timeout: { type: 'string', default: '600' },
			out: { type: 'string' },
			show: { type: 'boolean', default: false },
			'no-auto-approve': { type: 'boolean', default: false },
			'verbose-payloads': { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h', default: false }
		}
	});
	if (values.help || positionals[0] !== 'run') {
		console.log(USAGE);
		process.exit(values.help ? 0 : 2);
	}
	const baseUrl = values['base-url'] ?? process.env.DRIVE_BASE_URL;
	if (!baseUrl) fail('--base-url (or DRIVE_BASE_URL) is required');
	const prompts = values.prompt ?? [];
	if (prompts.length === 0) fail('give at least one --prompt');
	const keyEnv = values['api-key-env'];
	if (keyEnv && !process.env[keyEnv]) fail(`${keyEnv} is not set`);
	return {
		baseUrl: baseUrl.replace(/\/+$/, '').replace(/\/v1$/, ''),
		model: values.model ?? process.env.DRIVE_MODEL ?? null,
		apiKey: keyEnv ? process.env[keyEnv] : '',
		folder: values.folder ? resolve(values.folder) : null,
		prompts,
		timeoutMs: Number(values.timeout) * 1000,
		out: values.out ? resolve(values.out) : null,
		show: values.show,
		autoApprove: !values['no-auto-approve'],
		verbosePayloads: values['verbose-payloads']
	};
}

function fail(msg) {
	console.error(`drive: ${msg}`);
	process.exit(2);
}

const log = (msg) => console.log(`[drive] ${msg}`);

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

function freePort() {
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

/** Kill what we started, then any test-build process still running from BIN_DIR. */
function cleanup() {
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
	if (process.platform !== 'linux') return;
	// The app and its stub sidecars, by executable path: only ever the test
	// build's, never the user's Haruspex.
	for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
		try {
			const exe = readlinkSync(`/proc/${pid}/exe`);
			if (exe.startsWith(BIN_DIR + '/')) process.kill(Number(pid), 'SIGKILL');
		} catch {
			// not ours to read, or gone
		}
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the model server ------------------------------------------------------

async function firstModel(baseUrl, apiKey) {
	const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
	const r = await fetch(`${baseUrl}/v1/models`, { headers, signal: AbortSignal.timeout(15_000) });
	if (!r.ok) throw new Error(`${baseUrl}/v1/models: HTTP ${r.status}`);
	const body = await r.json();
	const id = body.data?.[0]?.id;
	if (!id) throw new Error(`${baseUrl}/v1/models lists no models`);
	return id;
}

// --- the app ----------------------------------------------------------------

/** Run an async function in the page and return its result. */
async function call(browser, name, ...args) {
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
}

async function waitForHooks(browser) {
	await browser.waitUntil(
		() => browser.execute(() => document.readyState === 'complete' && !!window.__haruspexDrive),
		{ timeout: 60_000, interval: 250, timeoutMsg: 'the app never loaded its drive hooks' }
	);
}

async function sessions(browser) {
	return call(browser, 'codeSessions');
}

/** Send one message and wait for the turn it starts to end. */
async function runPrompt(browser, sessionId, text, timeoutMs) {
	const before = (await sessions(browser)).find((s) => s.id === sessionId);
	const startCount = before.messages.length;
	const input = await browser.$(`[data-session-id="${sessionId}"] textarea[aria-label="Message"]`);
	await input.waitForEnabled({ timeout: 30_000 });
	await input.setValue(text);
	await browser.keys('Enter');

	const started = Date.now();
	let lastReport = 0;
	for (;;) {
		const s = (await sessions(browser)).find((x) => x.id === sessionId);
		const done = s.status === 'idle' && s.messages.length > startCount;
		if (done) return { timedOut: false, session: s };
		const elapsed = Date.now() - started;
		if (elapsed > timeoutMs) return { timedOut: true, session: s };
		if (elapsed - lastReport >= 15_000) {
			lastReport = elapsed;
			const running = s.searchSteps.filter((x) => x.status === 'running').map((x) => x.toolName);
			log(
				`  ${Math.round(elapsed / 1000)}s: ${s.status}, ${s.searchSteps.length} tool steps` +
					(running.length ? ` (running ${running.join(', ')})` : '') +
					`, streaming ${s.streamingContent.length} chars`
			);
		}
		await sleep(500);
	}
}

// --- output -----------------------------------------------------------------

const TOOL_RESULT_MAX = 4000;

function text(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n');
}

function clip(s, max = TOOL_RESULT_MAX) {
	return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s;
}

function fence(body, lang = '') {
	const ticks = body.includes('```') ? '````' : '```';
	return `${ticks}${lang}\n${body}\n${ticks}`;
}

function args(raw) {
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		return raw;
	}
}

function diffText(d) {
	const rows = d.rows.map((r) => {
		if (r.kind === 'gap') return `@@ ${r.skipped} unchanged lines @@`;
		return `${r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}${r.text}`;
	});
	return `${d.mode} ${d.path} (+${d.added} -${d.removed})${d.truncated ? ', truncated' : ''}\n${fence(rows.join('\n'), 'diff')}`;
}

/** The session as markdown: every message, tool call, result and diff, in order. */
function transcript(s, meta) {
	const out = [
		`# Code session ${s.id}`,
		'',
		`- Folder: \`${s.root}\``,
		`- Model: \`${meta.model}\` at ${meta.baseUrl}`,
		`- Status: ${s.status}${s.lastError ? `, error: ${s.lastError}` : ''}`,
		''
	];
	// Diffs and steps hang off the answer that ends a turn; find them by call id.
	const steps = new Map();
	for (const list of Object.values(s.messageSteps ?? {})) {
		for (const step of list) steps.set(step.id, step);
	}
	for (const step of s.searchSteps ?? []) steps.set(step.id, step);

	s.messages.forEach((m, i) => {
		const body = text(m.content);
		if (m.role === 'user') {
			out.push(`## User (#${i})`, '', body, '');
		} else if (m.role === 'assistant') {
			out.push(`## Assistant (#${i})`, '');
			if (body.trim()) out.push(body, '');
			for (const tc of m.tool_calls ?? []) {
				out.push(`### Tool call \`${tc.function?.name}\` (${tc.id})`, '');
				out.push(fence(args(tc.function?.arguments ?? ''), 'json'), '');
			}
			const stop = s.messageStops?.[i];
			if (stop) out.push(`_Stopped: ${stop}_`, '');
			const stats = s.messageStats?.[i];
			if (stats) out.push(`_Stats: ${JSON.stringify(stats)}_`, '');
		} else if (m.role === 'tool') {
			out.push(`### Tool result (${m.tool_call_id})`, '', fence(clip(body)), '');
			const step = steps.get(m.tool_call_id);
			if (step?.diff) out.push(diffText(step.diff), '');
		} else {
			out.push(`## ${m.role} (#${i})`, '', body, '');
		}
	});
	if (s.streamingContent) out.push('## (still streaming)', '', s.streamingContent, '');
	return out.join('\n');
}

function summarize(s) {
	const calls = s.messages.flatMap((m) => m.tool_calls ?? []);
	const counts = {};
	for (const c of calls) counts[c.function?.name] = (counts[c.function?.name] ?? 0) + 1;
	const last = [...s.messages].reverse().find((m) => m.role === 'assistant');
	return {
		turns: s.messages.filter((m) => m.role === 'user').length,
		modelReplies: s.messages.filter((m) => m.role === 'assistant').length,
		toolCalls: calls.length,
		toolCounts: counts,
		status: s.status,
		error: s.lastError,
		lastAssistant: last ? text(last.content).slice(0, 300) : null
	};
}

// --- main -------------------------------------------------------------------

async function main() {
	const opts = parse();
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const outDir = opts.out ?? join(ROOT, 'e2e', 'drive-output', stamp);
	mkdirSync(outDir, { recursive: true });

	if (!existsSync(appBinary())) {
		throw new Error(`no test build at ${appBinary()}: run npm run e2e:app:build`);
	}

	const model = opts.model ?? (await firstModel(opts.baseUrl, opts.apiKey));
	log(`model ${model} at ${opts.baseUrl}`);

	let folder = opts.folder;
	if (!folder) {
		folder = join(mkdtempSync(join(tmpdir(), 'haruspex-drive-')), 'average-bug');
		cpSync(FIXTURE, folder, { recursive: true });
	}
	if (!existsSync(folder)) throw new Error(`no folder ${folder}`);
	log(`folder ${folder}`);
	log(`output ${outDir}`);

	// A fresh profile: the e2e identifier's data, never the user's.
	for (const dir of e2eDataDirs()) rmSync(dir, { recursive: true, force: true });
	rmSync(STUB_PIDS, { recursive: true, force: true });
	mkdirSync(STUB_PIDS, { recursive: true });

	const env = { ...process.env, E2E_STUB_PIDS: STUB_PIDS };
	if (!opts.show) {
		env.DISPLAY = await startDisplay();
		delete env.WAYLAND_DISPLAY;
		env.GDK_BACKEND = 'x11';
		// No GPU on a virtual X server.
		env.WEBKIT_DISABLE_DMABUF_RENDERER = '1';
		env.LIBGL_ALWAYS_SOFTWARE = '1';
		log(`headless on ${env.DISPLAY}`);
	} else {
		env.GDK_BACKEND ??= 'x11';
	}

	// Ports of our own, so a test run or another driver can't collide.
	const port = await freePort();
	const nativePort = await freePort();
	const driverLog = join(outDir, 'tauri-driver.log');
	const driver = spawn(
		process.env.TAURI_DRIVER ?? 'tauri-driver',
		['--port', String(port), '--native-port', String(nativePort)],
		{ env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
	);
	children.push(driver);
	const driverOut = [];
	driver.stdout.on('data', (d) => driverOut.push(d));
	driver.stderr.on('data', (d) => driverOut.push(d));
	const saveDriverLog = () => writeFileSync(driverLog, Buffer.concat(driverOut));

	let browser;
	let session = null;
	let error = null;
	let timedOut = false;
	const meta = { model, baseUrl: opts.baseUrl };
	try {
		await waitForPort(port, driver);
		browser = await remote({
			hostname: '127.0.0.1',
			port,
			logLevel: 'error',
			capabilities: { 'tauri:options': { application: appBinary() } }
		});
		await waitForHooks(browser);

		// Settings → Inference, as Test connection would save it.
		const inference = await call(browser, 'probeRemote', opts.baseUrl, opts.apiKey, model);
		log(`backend ${inference.remoteBackendKind}, context ${inference.remoteContextSize}`);
		const settings = {
			dismissedStartupNotice: true,
			inferenceBackend: inference,
			codeLastRoot: folder,
			codeAutoApprove: opts.autoApprove
		};
		await browser.execute((s) => {
			localStorage.clear();
			localStorage.setItem('haruspex-settings', JSON.stringify(s));
			localStorage.setItem('haruspex.activeTab', 'code');
			location.replace('/');
		}, settings);
		await sleep(500);
		await waitForHooks(browser);

		// The Code tab, New session, and the dialog's Start (it offers codeLastRoot).
		// The empty pane's button; the sidebar has one by the same name.
		const newBtn = await browser.$('.workspace > .main > .empty').$('button=New session');
		await newBtn.waitForClickable({ timeout: 30_000 });
		await newBtn.click();
		const start = await browser.$('button=Start session');
		await start.waitForClickable({ timeout: 15_000 });
		await start.click();
		const pane = await browser.$('[data-session-id][data-status]');
		await pane.waitForExist({ timeout: 15_000 });
		const sessionId = await pane.getAttribute('data-session-id');
		if (opts.verbosePayloads) await call(browser, 'setVerbosePayloads', true);
		log(`session ${sessionId}`);

		for (const [i, prompt] of opts.prompts.entries()) {
			log(`prompt ${i + 1}/${opts.prompts.length}: ${prompt}`);
			const res = await runPrompt(browser, sessionId, prompt, opts.timeoutMs);
			session = res.session;
			writeFileSync(join(outDir, 'transcript.md'), transcript(session, meta));
			if (res.timedOut) {
				timedOut = true;
				log(`  timed out after ${opts.timeoutMs / 1000}s; stopping the turn`);
				await browser.execute(() => document.querySelector('button.stop')?.click());
				break;
			}
			const sum = summarize(session);
			log(
				`  done: ${sum.toolCalls} tool calls so far${session.lastError ? `, error: ${session.lastError}` : ''}`
			);
		}
		session = (await sessions(browser)).find((s) => s.id === sessionId) ?? session;
	} catch (e) {
		error = e;
	} finally {
		if (browser) {
			try {
				if (session) {
					writeFileSync(join(outDir, 'transcript.md'), transcript(session, meta));
					writeFileSync(join(outDir, 'session.json'), JSON.stringify(session, null, '\t'));
				}
				const lines = await call(browser, 'debugLogs');
				writeFileSync(join(outDir, 'debug.log'), lines.join('\n') + '\n');
				await browser.saveScreenshot(join(outDir, 'screenshot.png'));
			} catch (e) {
				error ??= e;
			}
			await browser.deleteSession().catch(() => {});
		}
		saveDriverLog();
		cleanup();
	}

	console.log('');
	console.log(`Results in ${outDir}`);
	if (session) {
		const sum = summarize(session);
		console.log(`  turns:       ${sum.turns} (${sum.modelReplies} assistant messages)`);
		console.log(
			`  tool calls:  ${sum.toolCalls} ${JSON.stringify(sum.toolCounts).replace(/"/g, '')}`
		);
		console.log(`  status:      ${timedOut ? 'timed out' : sum.status}`);
		if (sum.error) console.log(`  error:       ${sum.error}`);
		if (sum.lastAssistant) console.log(`  last reply:  ${sum.lastAssistant.replace(/\s+/g, ' ')}`);
	}
	if (error) {
		console.error(`drive failed: ${error.stack ?? error}`);
		process.exitCode = 1;
	} else if (timedOut) {
		process.exitCode = 3;
	}
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

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
	process.on(sig, () => {
		console.error(`\ndrive: ${sig}, cleaning up`);
		cleanup();
		process.exit(130);
	});
}
process.on('exit', cleanup);

main().catch((e) => {
	console.error(`drive failed: ${e.stack ?? e}`);
	cleanup();
	process.exit(1);
});
