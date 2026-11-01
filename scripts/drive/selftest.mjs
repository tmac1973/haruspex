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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlPaths, readInfo } from './control.mjs';
import { pinnedFetch } from './https.mjs';

const DRIVE = fileURLToPath(new URL('../drive.mjs', import.meta.url));

function drive(...args) {
	const out = execFileSync(process.execPath, [DRIVE, ...args], { encoding: 'utf8' });
	return JSON.parse(out);
}

/** A command that should fail: what it said on stderr. */
function driveFails(...args) {
	try {
		execFileSync(process.execPath, [DRIVE, ...args], { encoding: 'utf8', stdio: 'pipe' });
	} catch (e) {
		return String(e.stderr ?? e.message);
	}
	throw new Error(`selftest: drive ${args[0]} should have failed`);
}

const op = (o) => drive('op', JSON.stringify(o));

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

	// Settings' nav has a Code entry too, and its overlay covers the tabs.
	drive('click', 'button[aria-label="Settings"]');
	const { id } = drive('new-session');
	check(typeof id === 'string', 'new-session opens a session, even from Settings');

	const twoLines = 'fix the readme typo\nonly that line';
	const fixed = drive('send', id, twoLines, '--wait', '--timeout', '60');
	check(fixed.state === 'done', 'send --wait returns when the turn ends');
	check(
		drive('state', id).messages.some((m) => m.role === 'user' && m.content === twoLines),
		'send keeps a message on its lines'
	);
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

	// Phase 3: the same engine, through the owner API over HTTPS.
	writeFileSync(join(folder, 'README.md'), '# Helo\n');
	const viaApi = drive('start', '--fake', 'code-tab', '--folder', folder, '--api');
	started = true;
	check(
		viaApi.api?.startsWith('https://127.0.0.1:'),
		'start --api turns the owner API on, over HTTPS'
	);
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
	check(apiTurn.state === 'done', 'a turn sent over HTTPS runs');
	check(readFileSync(join(folder, 'README.md'), 'utf8') === '# Hello\n', 'and edits the file');
	const stream = drive('api-events', '--seconds', '2');
	check(stream[0]?.type === 'ready', 'the event stream says it is ready');
	check(drive('consistent', apiId).consistent, 'the session still rebuilds from its events');

	// Phase 4: the web client, paired by its one-time link.
	const { url } = drive('web-url');
	const base = url.slice(0, url.indexOf('/app/'));
	const code = url.slice(url.indexOf('#pair=') + 6);
	// Verified against its own certificate, which the driver saved.
	const fetch = pinnedFetch(readFileSync(drive('status').apiCa, 'utf8'));
	const plain = await globalThis.fetch(`${base.replace('https:', 'http:')}/app/`, {
		redirect: 'manual'
	});
	check(
		plain.status === 308 && plain.headers.get('location') === `${base}/app/`,
		'plain HTTP is sent to HTTPS'
	);
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
	// Phase 5: a chat turn through the engine, over HTTP.
	drive('scenario', 'chat-hello');
	const chat = drive('chat-send', 'new', 'hello there', '--wait', '--timeout', '60');
	check(chat.state === 'done', 'a chat message sent through the engine gets its reply');
	check(
		chat.lastAssistant?.startsWith('Hello from the fake model'),
		"the reply is the chat scenario's"
	);
	const chats = drive('chats');
	check(chats.find((c) => c.id === chat.id)?.open === true, 'the chat is open on the desktop');

	// A picture, uploaded as the page does, then sent with a chat message.
	const PNG_1PX =
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
	const uploaded = await fetch(`${base}/api/v1/upload`, {
		method: 'POST',
		headers: { Cookie: cookie, 'X-Haruspex': '1', 'Content-Type': 'image/png' },
		body: Buffer.from(PNG_1PX, 'base64')
	});
	const { hash } = await uploaded.json();
	check(uploaded.ok && /^[0-9a-f]{64}$/.test(hash), '/api/v1/upload keeps a picture');
	const before = drive('requests').length;
	op({ type: 'chat.send', id: chat.id, text: 'hello, what is in this picture?', images: [hash] });
	for (const until = Date.now() + 30_000; Date.now() < until;) {
		if (!drive('chat-state', chat.id).busy && drive('requests').length > before) break;
		await new Promise((res) => setTimeout(res, 300));
	}
	const sentPicture = drive('requests')
		.slice(before)
		.some((r) => JSON.stringify(r.messages ?? r).includes('data:image/png;base64,'));
	check(sentPicture, 'chat.send hands the uploaded picture to the model');
	const skills = op({ type: 'chat.send', id: chat.id, text: '/skills' });
	check(skills.handled === true && typeof skills.note === 'string', '/skills answers its note');

	// The Jobs tab over HTTPS: write a job, run it, read its run, delete it.
	drive('scenario', 'research-job');
	const { jobId } = op({
		type: 'jobs.create',
		job: { name: 'Weather digest', job_type: 'research' },
		steps: ['Find the weather in Lisbon.', 'Summarise it in one line.']
	});
	check(
		op({ type: 'jobs.get', jobId }).steps.length === 2,
		'jobs.create makes a job with its steps'
	);
	const { runId } = op({ type: 'jobs.run', jobId });
	let finished = null;
	for (const until = Date.now() + 60_000; Date.now() < until;) {
		const r = op({ type: 'runs.get', runId });
		if (!['queued', 'running'].includes(r.status)) {
			finished = r;
			break;
		}
		await new Promise((res) => setTimeout(res, 500));
	}
	check(finished?.status === 'succeeded', 'jobs.run runs it to the end');
	check(
		finished.steps.at(-1).output?.includes('sunny and mild'),
		"and runs.get has the last step's output"
	);
	check(
		op({ type: 'runs.list', jobId }).some((r) => r.id === runId),
		'runs.list lists the run'
	);
	check(op({ type: 'runs.current' }).queue.length === 0, 'runs.current shows an empty queue');
	check(op({ type: 'jobs.delete', jobId }).deleted === jobId, 'jobs.delete deletes it');

	// A Code session's controls over HTTPS, on a fork, so the session above stays.
	const forked = op({ type: 'session.fork', id: apiId, index: 0 });
	check(typeof forked.id === 'string' && forked.id !== apiId, 'session.fork makes a new session');
	op({ type: 'session.open', id: forked.id });
	op({ type: 'session.rename', id: forked.id, title: 'Forked from afar' });
	op({ type: 'session.effort', id: forked.id, effort: 'high' });
	check(
		op({ type: 'sessions.list' }).find((x) => x.id === forked.id)?.title === 'Forked from afar',
		'session.rename renames it'
	);
	check(op({ type: 'session.close', id: forked.id }).closed === true, 'session.close closes it');
	check(
		op({ type: 'session.delete', id: forked.id }).deleted === forked.id,
		'session.delete deletes it'
	);
	check(
		!op({ type: 'sessions.list' }).some((x) => x.id === forked.id),
		'and it is gone from the list'
	);

	// A chat's controls over HTTPS, on a chat of its own.
	const { id: spare } = op({ type: 'chat.new' });
	op({ type: 'chat.rename', id: spare, title: 'Renamed from afar' });
	op({ type: 'chat.memory', id: spare, enabled: false });
	const spareState = op({ type: 'chat.get', id: spare });
	check(
		spareState.title === 'Renamed from afar' && spareState.memoryEnabled === false,
		'chat.rename and chat.memory change the chat'
	);
	check(op({ type: 'chat.delete', id: spare }).deleted === spare, 'chat.delete deletes it');
	check(!op({ type: 'chats.list' }).some((c) => c.id === spare), 'and it is gone from the list');
	const models = op({ type: 'models.list' });
	check(
		typeof models.settings?.model === 'string' && Array.isArray(models.apiKeys),
		'models.list names the Settings model and the keys'
	);

	// Watching the app over HTTPS: its debug log, the inference queue, the tasks.
	const tail = op({ type: 'debug.tail', lines: 50 });
	check(
		tail.window === 'main' && tail.lines.length > 0 && tail.next >= tail.lines.at(-1).seq,
		"debug.tail reads the main window's log"
	);
	const ran = op({ type: 'debug.tail', contains: '[engine] started', lines: 2000 });
	check(
		ran.lines.length > 0 && ran.lines.every((l) => l.line.includes('[engine] started')),
		'and keeps only the lines holding `contains`'
	);
	check(
		op({ type: 'debug.tail', since: tail.next + 1e9 }).lines.length === 0,
		'and nothing after its own end'
	);
	check(Array.isArray(op({ type: 'inference.queue' })), 'inference.queue lists the tickets');
	check(Array.isArray(op({ type: 'tasks.list' })), 'tasks.list lists the background tasks');

	// Settings over HTTPS: read one, change it, and a secret is refused.
	op({ type: 'settings.patch', patch: { theme: 'dark' } });
	check(
		op({ type: 'settings.get', keys: ['theme'] }).settings.theme === 'dark',
		'settings.patch changes a setting that settings.get reads back'
	);
	check(
		driveFails(
			'op',
			JSON.stringify({ type: 'settings.patch', patch: { braveApiKey: 'x' } })
		).includes('is a secret'),
		'and refuses a secret'
	);

	// Every kind of prompt, answered through the API as the web page does: a
	// repo's instructions, an MCP tool that asks first, and a skill write.
	const repo = join(dirname(folder), 'repo');
	mkdirSync(repo);
	execFileSync('git', ['init', '-q', repo]);
	writeFileSync(join(repo, 'AGENTS.md'), '# Notes\n\nBe brief.\n');
	drive('scenario', 'remote-prompts');
	check(drive('fake-mcp').state.startsWith('Running'), 'a custom MCP server starts');
	const { id: repoId } = drive('new-session', '--folder', repo);
	check(
		drive('send', repoId, 'note hello', '--via', 'engine', '--wait', '--timeout', '60').prompt
			?.kind === 'repo-trust',
		"a repo's AGENTS.md asks first"
	);
	drive('answer', 'repo-trust', '{"trust":true}');
	const mcp = drive('wait', repoId, '--timeout', '60');
	check(mcp.prompt?.kind === 'mcp', 'then the MCP tool asks');
	drive('answer', 'mcp', '{"choice":"allow_once"}');
	check(
		drive('wait', repoId, '--timeout', '60').summary.lastAssistant === 'I noted it.',
		'and runs once allowed'
	);
	const skill = drive(
		'send',
		repoId,
		'save a greeting skill',
		'--via',
		'engine',
		'--wait',
		'--timeout',
		'60'
	);
	check(skill.prompt?.kind === 'skill', 'a skill write asks');
	const edited = '---\nname: greet\ndescription: Greet the user.\n---\n\nEdited from afar.\n';
	drive('answer', 'skill', JSON.stringify({ action: 'save', text: edited }));
	check(
		drive('wait', repoId, '--timeout', '60').summary.lastAssistant === 'Saved the skill.',
		'and is saved'
	);
	check(
		readFileSync(join(repo, '.agents', 'skills', 'greet', 'SKILL.md'), 'utf8') === edited,
		'as edited'
	);

	// Who can connect, from this computer's network address, as another
	// computer on the network would. Skipped where there is no network.
	const list = (base, headers = {}) =>
		fetch(`${base}/api/v1/op`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify({ type: 'sessions.list' })
		});
	const { lan } = drive('access', 'lan');
	if (!lan) {
		console.log('skip - no network address: the access modes are not checked');
	} else {
		const ip = new URL(lan).hostname;
		const port = new URL(lan).port;
		check(
			(await list(lan, { 'X-Haruspex': '1' })).status === 200,
			'My whole network lets a network address in'
		);
		check(
			(await list(lan, { 'X-Haruspex': '1', Host: `evil.example:${port}` })).status === 403,
			'but not under a name that is not this computer'
		);
		drive('access', 'trusted', ip);
		check(
			(await list(lan, { 'X-Haruspex': '1' })).status === 200,
			'These computers lets a listed address in'
		);
		drive('access', 'trusted', 'localhost');
		check((await list(base, { 'X-Haruspex': '1' })).status === 200, 'and a listed name, looked up');
		check((await list(lan, { 'X-Haruspex': '1' })).status === 401, 'and nobody else');
		drive('access', 'tokens');
		check(
			(await list(lan, { 'X-Haruspex': '1' })).status === 401,
			'Devices with a token wants one'
		);
		const lanUrl = drive('web-url').url;
		const lanPair = await fetch(`${lan}/api/v1/pair`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code: lanUrl.slice(lanUrl.indexOf('#pair=') + 6) })
		});
		const lanCookie = (lanPair.headers.get('set-cookie') ?? '').split(';')[0];
		check(
			(await list(lan, { 'X-Haruspex': '1', Cookie: lanCookie })).status === 200,
			'which a pairing link gives a browser on the network'
		);
	}

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
