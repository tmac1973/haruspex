#!/usr/bin/env node
/**
 * Drive the driver: start it against the fake model, run a turn, refuse a
 * risky command through the approval modal, and stop, checking the project
 * folder and the leftovers after each step. CI runs it after the real-app
 * specs (needs `npm run e2e:app:build`), so `drive` can't rot unnoticed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlPaths, readInfo } from './control.mjs';

const DRIVE = fileURLToPath(new URL('../drive.mjs', import.meta.url));

function drive(...args) {
	const out = execFileSync(process.execPath, [DRIVE, ...args], { encoding: 'utf8' });
	return JSON.parse(out);
}

function check(cond, msg) {
	if (!cond) throw new Error(`selftest: ${msg}`);
	console.log(`ok - ${msg}`);
}

const folder = join(mkdtempSync(join(tmpdir(), 'haruspex-drive-selftest-')), 'project');
mkdirSync(join(folder, 'build'), { recursive: true });
writeFileSync(join(folder, 'README.md'), '# Helo\n');
writeFileSync(join(folder, 'build', 'out.txt'), 'built\n');

let started = false;
try {
	const status = drive('start', '--fake', 'code-tab', '--folder', folder, '--idle-timeout', '5');
	started = true;
	check(
		status.model === 'fake-model' && status.sessions.length === 0,
		'start reports the fake model'
	);

	const { id } = drive('new-session');
	check(typeof id === 'string', 'new-session opens a session');

	const fixed = drive('send', id, 'fix the readme typo', '--wait', '--timeout', '60');
	check(fixed.state === 'done', 'send --wait returns when the turn ends');
	check(
		readFileSync(join(folder, 'README.md'), 'utf8') === '# Hello\n',
		'the turn edited the file'
	);
	check(fixed.summary.toolCounts.fs_edit_text === 1, 'the summary counts the edit');

	drive('scenario', 'drive-approval');
	const asked = drive('send', id, 'clean the build folder', '--wait', '--timeout', '60');
	check(asked.state === 'approval', 'send --wait stops at an approval');
	check(asked.approval.command === 'rm -rf build', 'the approval names the command');
	drive('approve', 'deny');
	const denied = drive('wait', id, '--timeout', '60');
	check(denied.state === 'done', 'wait returns once the denied turn ends');
	check(existsSync(join(folder, 'build', 'out.txt')), 'the denied command did not run');

	const state = drive('state', id);
	check(
		state.messages.some((m) => m.role === 'tool'),
		'state returns the thread'
	);

	const mirror = drive('consistent', id);
	check(mirror.consistent, "the session's events rebuild what session.get returns");

	// Phase 2: a session in a window of its own, reached only through the engine.
	const moved = drive('detach', id);
	check(moved.window === `code-${id}`, 'detach moves the session to its own window');
	const remote = drive(
		'send',
		id,
		'clean the build folder',
		'--via',
		'engine',
		'--wait',
		'--timeout',
		'60'
	);
	check(remote.state === 'approval', 'a turn sent through the engine runs in the detached window');
	const answered = drive('approve', 'deny', '--via', 'engine');
	check(answered.command === 'rm -rf build', "prompts.answer answers the detached window's prompt");
	const after = drive('wait', id, '--timeout', '60');
	check(after.state === 'done', 'the detached turn ends');
	check(existsSync(join(folder, 'build', 'out.txt')), 'the command denied from afar did not run');
	check(drive('consistent', id).consistent, 'events from the detached window rebuild it too');

	const saved = drive('stop');
	started = false;
	check(saved.files.includes(`transcript-${id}.md`), 'stop writes the transcript');
	check(readInfo(controlPaths()) === null, 'stop leaves no driver behind');

	// Phase 3: the same engine, through the owner API over HTTP.
	writeFileSync(join(folder, 'README.md'), '# Helo\n');
	const viaApi = drive('start', '--fake', 'code-tab', '--folder', folder, '--api');
	started = true;
	check(viaApi.api?.startsWith('http://127.0.0.1:'), 'start --api turns the owner API on');
	const { id: apiId } = drive('new-session');
	const apiTurn = drive(
		'send',
		apiId,
		'fix the readme typo',
		'--via',
		'engine',
		'--wait',
		'--timeout',
		'60'
	);
	check(apiTurn.state === 'done', 'a turn sent over HTTP runs');
	check(readFileSync(join(folder, 'README.md'), 'utf8') === '# Hello\n', 'and edits the file');
	const stream = drive('api-events', '--seconds', '2');
	check(stream[0]?.type === 'ready', 'the event stream says it is ready');
	check(drive('consistent', apiId).consistent, 'the session still rebuilds from its events');

	// Phase 4: the web client, paired by its one-time link.
	const { url } = drive('web-url');
	const base = url.slice(0, url.indexOf('/app/'));
	const code = url.slice(url.indexOf('#pair=') + 6);
	const page = await fetch(`${base}/app/`);
	check(
		page.ok && (await page.text()).includes('<div id="app">'),
		'the owner API serves the web client'
	);
	check(
		(page.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"),
		'with its content security policy'
	);
	const paired = await fetch(`${base}/api/v1/pair`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ code })
	});
	const cookie = (paired.headers.get('set-cookie') ?? '').split(';')[0];
	check(
		paired.ok && cookie.startsWith('haruspex_owner=hsx_'),
		'a pairing code buys the device cookie'
	);
	const again = await fetch(`${base}/api/v1/pair`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ code })
	});
	check(again.status === 401, 'and only once');
	const asWeb = (headers) =>
		fetch(`${base}/api/v1/op`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
			body: JSON.stringify({ type: 'sessions.list' })
		});
	check((await asWeb({})).status === 403, 'the cookie alone is refused');
	const listed = await asWeb({ 'X-Haruspex': '1' });
	const sessions = (await listed.json()).value;
	check(listed.ok && sessions.some((s) => s.id === apiId), 'with X-Haruspex it lists the sessions');
	drive('stop');
	started = false;
} finally {
	if (started) {
		try {
			execFileSync(process.execPath, [DRIVE, 'stop'], { stdio: 'inherit' });
		} catch {
			// already gone
		}
	}
}
