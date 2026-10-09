#!/usr/bin/env node
/**
 * Drive the real app's Code tab against a real model (or the fake one), for
 * reproducing and exploring agent behaviour. Uses the e2e build
 * (`npm run e2e:app:build`) through tauri-driver, with the e2e identifier's
 * data wiped first, so the user's own Haruspex is never touched. See
 * docs/testing.md, "Driving the app with a real model".
 *
 * `run` does one scripted pass. `start` keeps the app open in a background
 * process that the other commands talk to over a local socket
 * (scripts/drive/control.mjs), so a session can be driven one step at a time.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ROOT } from '../e2e/app/paths.mjs';
import { App, cleanup, killTestBuild } from './drive/app.mjs';
import { clearInfo, controlPaths, readInfo, request, serve, writeInfo } from './drive/control.mjs';

const SELF = fileURLToPath(import.meta.url);

const USAGE = `Usage: npm run drive -- <command> [options]

One pass:
  run --prompt "..." [--prompt "..."]   start, one session, each prompt in turn, stop

A long-lived app, driven step by step:
  start                     start the app in the background; prints its status
  status                    the running driver and its sessions
  new-session [--folder P]  open a session (default: a fresh copy of e2e/fixtures/average-bug)
  send <id> <text> [--wait] start a turn; --wait returns when it ends or needs someone
  wait <id>                 wait for the session's turn to end or need someone
  steer <id> <text>         queue a message for the running turn's next step
  cancel <id>               press Stop
  approval                  every prompt waiting on a person, in every window
  approve allow|allow-session|deny
  state [<id>] [--transcript]
  detach <id>               move the session to its own window (the tab's ⤢)
  events [--since N]        engine events from every window; "next" is the next --since
  consistent <id>           whether the session's events rebuild what session.get says
  logs [--since N]          agent debug log lines from N on
  screenshot [PATH]
  minimise | restore        the app window
  scenario <name>           switch the fake model's scenario (--fake only)
  requests                  what the fake model was asked (--fake or --record)
  stop                      save outputs and stop everything

Options for run and start:
  --base-url URL       the OpenAI-compatible server (env DRIVE_BASE_URL)
  --model ID           the model; default: the first one /v1/models lists (env DRIVE_MODEL)
  --api-key-env NAME   read the API key from this environment variable
  --fake SCENARIO      use e2e/fake-llm with this scenario instead of a server
  --record NAME        put the fake in front of --base-url and save the exchanges
                       as e2e/fake-llm/scenarios/NAME.json
  --folder PATH        the first session's project folder (run), or the default (start)
  --out DIR            where outputs go (default e2e/drive-output/<timestamp>)
  --show               show the window (default: headless, on a private X display)
  --verbose-payloads   log whole request bodies in debug.log, not digests
  --auto-approve / --no-auto-approve
                       Settings → Code → auto-approve (default: on for run, off for start)
  --idle-timeout MIN   start: stop after this long with no commands and no turn running
                       (default 60; 0 never)
Options for send, steer, cancel and approve:
  --via engine         use the engine operation (as the owner API will), not the UI;
                       the only way to reach a session in a detached window
Options for run, send and wait:
  --timeout SECS       the most one turn may take (default 600)`;

const OPTIONS = {
	'base-url': { type: 'string' },
	model: { type: 'string' },
	'api-key-env': { type: 'string' },
	fake: { type: 'string' },
	record: { type: 'string' },
	folder: { type: 'string' },
	prompt: { type: 'string', multiple: true },
	timeout: { type: 'string', default: '600' },
	'idle-timeout': { type: 'string', default: '60' },
	out: { type: 'string' },
	show: { type: 'boolean', default: false },
	wait: { type: 'boolean', default: false },
	transcript: { type: 'boolean', default: false },
	via: { type: 'string', default: 'ui' },
	since: { type: 'string', default: '0' },
	'auto-approve': { type: 'boolean' },
	'no-auto-approve': { type: 'boolean' },
	'verbose-payloads': { type: 'boolean', default: false },
	help: { type: 'boolean', short: 'h', default: false }
};

function fail(msg) {
	console.error(`drive: ${msg}`);
	process.exit(2);
}

const log = (msg) => console.log(`[drive] ${msg}`);

/** The options `run` and `start` share, from the command line. */
function appOptions(values, defaultAutoApprove) {
	const keyEnv = values['api-key-env'];
	if (keyEnv && !process.env[keyEnv]) fail(`${keyEnv} is not set`);
	if (values.fake && values.record) fail('--fake and --record are exclusive');
	const baseUrl = values['base-url'] ?? process.env.DRIVE_BASE_URL;
	if (!values.fake && !baseUrl) fail('--base-url (or DRIVE_BASE_URL), or --fake, is required');
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	return {
		baseUrl: baseUrl?.replace(/\/+$/, '').replace(/\/v1$/, ''),
		model: values.model ?? process.env.DRIVE_MODEL ?? null,
		apiKey: keyEnv ? process.env[keyEnv] : '',
		fake: values.fake ?? null,
		record: values.record ?? null,
		folder: values.folder ? resolve(values.folder) : null,
		outDir: values.out ? resolve(values.out) : join(ROOT, 'e2e', 'drive-output', stamp),
		show: values.show,
		autoApprove: values['no-auto-approve'] ? false : (values['auto-approve'] ?? defaultAutoApprove),
		verbosePayloads: values['verbose-payloads']
	};
}

function print(value) {
	console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

// --- run ----------------------------------------------------------------------

async function run(values) {
	const prompts = values.prompt ?? [];
	if (prompts.length === 0) fail('give at least one --prompt');
	const opts = appOptions(values, true);
	const timeoutMs = Number(values.timeout) * 1000;
	const app = new App(opts, log);
	let id = null;
	let last = null;
	let error = null;
	log(`output ${opts.outDir}`);
	try {
		await app.start();
		({ id } = await app.newSession(opts.folder ?? undefined));
		for (const [i, prompt] of prompts.entries()) {
			log(`prompt ${i + 1}/${prompts.length}: ${prompt}`);
			last = await app.send(id, prompt, { wait: true, timeoutMs });
			if (last.state === 'timeout') {
				log(`  timed out after ${timeoutMs / 1000}s; stopping the turn`);
				await app.cancel(id).catch(() => {});
				break;
			}
			if (last.state !== 'done') {
				log(`  the turn is waiting on a person (${last.state}); run can't answer it`);
				if (last.approval) log(`  approval: ${last.approval.command}`);
				break;
			}
			const sum = last.summary;
			log(`  done: ${sum.toolCalls} tool calls so far${sum.error ? `, error: ${sum.error}` : ''}`);
		}
	} catch (e) {
		error = e;
	} finally {
		try {
			const saved = await app.saveOutputs();
			log(`wrote ${saved.files.join(', ')}`);
		} catch (e) {
			error ??= e;
		}
		await app.stop();
	}

	console.log('');
	console.log(`Results in ${opts.outDir}`);
	if (last?.summary) {
		const sum = last.summary;
		console.log(`  turns:       ${sum.turns} (${sum.modelReplies} assistant messages)`);
		console.log(
			`  tool calls:  ${sum.toolCalls} ${JSON.stringify(sum.toolCounts).replace(/"/g, '')}`
		);
		console.log(`  status:      ${last.state === 'timeout' ? 'timed out' : sum.status}`);
		if (sum.error) console.log(`  error:       ${sum.error}`);
		if (sum.lastAssistant) console.log(`  last reply:  ${sum.lastAssistant.replace(/\s+/g, ' ')}`);
	}
	if (error) {
		console.error(`drive failed: ${error.stack ?? error}`);
		process.exitCode = 1;
	} else if (last?.state === 'timeout') {
		process.exitCode = 3;
	}
}

// --- start and the background process -------------------------------------------

async function start(values) {
	const paths = controlPaths();
	const running = readInfo(paths);
	if (running) {
		fail(
			`a driver is already running (pid ${running.pid}, from ${running.root}): drive stop first`
		);
	}
	clearInfo(paths);
	// Left over from a driver that crashed.
	killTestBuild();
	const opts = appOptions(values, false);
	opts.idleTimeoutMs = Number(values['idle-timeout']) * 60_000;
	mkdirSync(opts.outDir, { recursive: true });
	const logFile = join(opts.outDir, 'driver.log');
	const fd = openSync(logFile, 'a');
	const child = spawn(process.execPath, [SELF, '__daemon', JSON.stringify(opts)], {
		detached: true,
		stdio: ['ignore', fd, fd]
	});
	child.unref();
	let exited = null;
	child.on('exit', (code) => (exited = code ?? 1));

	const deadline = Date.now() + 240_000;
	while (Date.now() < deadline) {
		if (exited !== null) {
			const tail = readFileSync(logFile, 'utf8').trim().split('\n').slice(-30).join('\n');
			console.error(tail);
			fail(`the driver exited while starting (${exited}); log: ${logFile}`);
		}
		try {
			print(await request(paths.socket, 'status', {}, { timeoutMs: 5_000 }));
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 500));
		}
	}
	fail(`the driver did not start in 240s; log: ${logFile}`);
}

async function daemon(opts) {
	const paths = controlPaths();
	const app = new App(opts, log);
	let server = null;
	let stopping = false;
	let inFlight = 0;
	let lastActivity = Date.now();

	async function shutdown(code, save = true) {
		if (stopping) return;
		stopping = true;
		if (save) {
			try {
				const saved = await app.saveOutputs();
				log(`wrote ${saved.files.join(', ')} to ${saved.dir}`);
			} catch (e) {
				log(`saving outputs failed: ${e.message ?? e}`);
			}
		}
		await app.stop().catch(() => cleanup());
		server?.close();
		clearInfo(paths);
		log('stopped');
		process.exit(code);
	}
	for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(130));

	try {
		await app.start();
	} catch (e) {
		log(`start failed: ${e.stack ?? e}`);
		await app.stop().catch(() => cleanup());
		process.exit(1);
	}

	const status = async () => ({
		pid: process.pid,
		root: ROOT,
		outDir: opts.outDir,
		model: app.meta.model,
		baseUrl: app.meta.baseUrl,
		display: app.display,
		autoApprove: opts.autoApprove,
		// Open in any window.
		sessions: (await app.engine({ type: 'sessions.list' })).filter((s) => s.status)
	});

	const turnOpts = (args) => ({ timeoutMs: (args.timeout ?? 600) * 1000 });
	const handlers = {
		status,
		'new-session': (a) => app.newSession(a.folder),
		send: (a) => app.send(a.id, a.text, { wait: a.wait, via: a.via, ...turnOpts(a) }),
		wait: (a) => app.wait(a.id, turnOpts(a)),
		steer: (a) => app.steer(a.id, a.text, { via: a.via }),
		cancel: (a) => app.cancel(a.id, { via: a.via }),
		approval: () => app.pendingApproval(),
		approve: (a) => app.approve(a.choice, { via: a.via }),
		detach: (a) => app.detach(a.id),
		events: (a) => app.events(a.since),
		consistent: (a) => app.consistent(a.id),
		state: (a) => app.state(a.id, { asTranscript: a.transcript }),
		logs: (a) => app.logs(a.since),
		screenshot: (a) => app.screenshot(a.path ?? join(opts.outDir, `screenshot-${Date.now()}.png`)),
		minimise: () => app.minimise(),
		restore: () => app.restore(),
		scenario: (a) => app.scenario(a.name),
		requests: () => app.requests(),
		// Stops even when saving fails: a driver nobody can stop is worse.
		stop: async () => {
			let saved;
			try {
				saved = await app.saveOutputs();
			} catch (e) {
				saved = { dir: opts.outDir, files: [], error: String(e?.message ?? e) };
			}
			setTimeout(() => shutdown(0, false), 50);
			return saved;
		}
	};

	server = await serve(paths.socket, async (cmd, args) => {
		const handler = handlers[cmd];
		if (!handler) throw new Error(`unknown command ${cmd}`);
		inFlight++;
		lastActivity = Date.now();
		try {
			return await handler(args);
		} finally {
			inFlight--;
			lastActivity = Date.now();
		}
	});
	writeInfo({ pid: process.pid, root: ROOT, outDir: opts.outDir, socket: paths.socket }, paths);
	log(`ready on ${paths.socket}`);

	if (opts.idleTimeoutMs > 0) {
		setInterval(async () => {
			if (stopping || inFlight > 0 || Date.now() - lastActivity < opts.idleTimeoutMs) return;
			if (await app.anyBusy().catch(() => false)) return;
			log(`idle for ${opts.idleTimeoutMs / 60_000} min; stopping`);
			await shutdown(0);
		}, 30_000).unref();
	}
}

// --- the short-lived commands ------------------------------------------------------

async function client(cmd, values, positionals) {
	const paths = controlPaths();
	const timeoutS = Number(values.timeout);
	const need = (n, what) => {
		if (positionals.length < n) fail(`${cmd} needs ${what}`);
	};
	let args = {};
	let timeoutMs = 120_000;
	switch (cmd) {
		case 'new-session':
			args = { folder: values.folder ? resolve(values.folder) : undefined };
			break;
		case 'send':
		case 'steer':
			need(2, 'a session id and a message');
			args = {
				id: positionals[0],
				text: positionals.slice(1).join(' '),
				wait: values.wait,
				via: values.via,
				timeout: timeoutS
			};
			if (values.wait) timeoutMs = (timeoutS + 60) * 1000;
			break;
		case 'wait':
			need(1, 'a session id');
			args = { id: positionals[0], timeout: timeoutS };
			timeoutMs = (timeoutS + 60) * 1000;
			break;
		case 'cancel':
			need(1, 'a session id');
			args = { id: positionals[0], via: values.via };
			break;
		case 'detach':
		case 'consistent':
			need(1, 'a session id');
			args = { id: positionals[0] };
			break;
		case 'events':
			args = { since: Number(values.since) };
			break;
		case 'approve':
			need(1, 'allow, allow-session or deny');
			args = { choice: positionals[0], via: values.via };
			break;
		case 'state':
			args = { id: positionals[0], transcript: values.transcript };
			break;
		case 'logs':
			args = { since: Number(values.since) };
			break;
		case 'screenshot':
			args = { path: positionals[0] ? resolve(positionals[0]) : undefined };
			break;
		case 'scenario':
			need(1, 'a scenario name');
			args = { name: positionals[0] };
			break;
		case 'stop':
			if (!readInfo(paths)) {
				clearInfo(paths);
				killTestBuild();
				console.log('no driver was running');
				return;
			}
			timeoutMs = 60_000;
			break;
	}
	const value = await request(paths.socket, cmd, args, { timeoutMs });
	if (cmd === 'stop') {
		// It answers first, then shuts down: wait until it has.
		for (let i = 0; i < 120 && readInfo(paths); i++) await new Promise((r) => setTimeout(r, 250));
	}
	print(value);
	if (value?.state === 'timeout') process.exitCode = 3;
}

// --- main -------------------------------------------------------------------------

const CLIENT_COMMANDS = new Set([
	'status',
	'new-session',
	'send',
	'wait',
	'steer',
	'cancel',
	'approval',
	'approve',
	'state',
	'logs',
	'screenshot',
	'minimise',
	'restore',
	'scenario',
	'requests',
	'detach',
	'events',
	'consistent',
	'stop'
]);

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	if (cmd === '__daemon') return daemon(JSON.parse(rest[0]));
	const { values, positionals } = parseArgs({
		args: rest,
		options: OPTIONS,
		allowPositionals: true
	});
	if (values.help || !cmd) {
		console.log(USAGE);
		process.exit(values.help ? 0 : 2);
	}
	if (cmd === 'run') {
		for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
			process.on(sig, () => {
				console.error(`\ndrive: ${sig}, cleaning up`);
				cleanup();
				process.exit(130);
			});
		}
		process.on('exit', cleanup);
		return run(values);
	}
	if (cmd === 'start') return start(values);
	if (CLIENT_COMMANDS.has(cmd)) return client(cmd, values, positionals);
	fail(`unknown command ${cmd}\n\n${USAGE}`);
}

main().catch((e) => {
	console.error(`drive failed: ${e.message ?? e}`);
	process.exit(1);
});
