#!/usr/bin/env node
/**
 * Evaluate the model a running Haruspex is set to: a fixed set of Chat and
 * Code prompts, each run in a new chat or session through the Remote control
 * API, checked from what the run left. Written for the deferred-tools
 * evaluation (plan/deferred-tools/phase-05-results.md); used to compare
 * models, and Settings → General → Load tools when needed on and off. See
 * docs/testing.md, "Evaluating a model".
 */
import { execFileSync } from 'node:child_process';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { apiClient } from './model-eval/api.mjs';
import { CONVERSATION, PROMPTS } from './model-eval/prompts.mjs';

const USAGE = `Usage: npm run model-eval -- <command> [options]

  setup                     make the test folder and project (needs ffmpeg and git)
  run --label NAME          run prompts and append a record per run to --out
      [--prompts a,b|all] [--runs 10] [--slow-runs 3] [--setting on|off|keep]
  conversation --label NAME one 12-turn Chat conversation, a record per turn
      [--setting on|off|keep]
  summary                   pass rates, requests and prompt sizes from --out
  prompts                   list the prompts and what each needs
  cleanup                   delete the chats and sessions the records in --out name

Options for all: --dir DIR (default ${join(tmpdir(), 'haruspex-model-eval')}),
  --out FILE (default DIR/results.jsonl), --base URL (default https://localhost:8788),
  --cookie VALUE and --ca FILE for an app on another computer.
The app must be running with Settings → Remote control on, and set to the
model under test. Chats are made with memory off; prompts that ask for
approval are answered: read-only MCP tools allowed, everything else denied.`;

const { values: o, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		dir: { type: 'string', default: join(tmpdir(), 'haruspex-model-eval') },
		out: { type: 'string' },
		base: { type: 'string', default: 'https://localhost:8788' },
		cookie: { type: 'string' },
		ca: { type: 'string' },
		label: { type: 'string' },
		prompts: { type: 'string', default: 'all' },
		runs: { type: 'string', default: '10' },
		'slow-runs': { type: 'string', default: '3' },
		setting: { type: 'string', default: 'keep' },
		timeout: { type: 'string', default: '420' },
		help: { type: 'boolean', short: 'h' }
	}
});
const command = positionals[0];
if (o.help || !command) {
	console.log(USAGE);
	process.exit(command ? 0 : 1);
}

const FOLDER = join(o.dir, 'folder');
const PROJECT = join(o.dir, 'project');
const OUT = o.out ?? join(o.dir, 'results.jsonl');
const op = apiClient({ base: o.base, cookie: o.cookie, ca: o.ca });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Two clips in ep012 (12 s and 20 s), and a project with a README. */
function setup() {
	const clips = join(FOLDER, 'ep012', 'clips');
	mkdirSync(clips, { recursive: true });
	const clip = (name, src, secs, freq) =>
		execFileSync('ffmpeg', [
			...['-loglevel', 'error', '-y'],
			...['-f', 'lavfi', '-i', `${src}=duration=${secs}:size=640x360:rate=30`],
			...['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`],
			...['-shortest', join(clips, name)]
		]);
	clip('a.mp4', 'testsrc', 12, 440);
	clip('b.mp4', 'testsrc2', 20, 600);
	mkdirSync(PROJECT, { recursive: true });
	writeFileSync(join(PROJECT, 'README.md'), '# Demo project\n\nA tiny game.\n');
	if (!existsSync(join(PROJECT, '.git'))) execFileSync('git', ['init', '-q', PROJECT]);
	console.log(`folder ${FOLDER}\nproject ${PROJECT}`);
}

/** What the runs write, removed before each run so no overwrite prompt can stall one. */
function clean() {
	for (const dir of [FOLDER, join(FOLDER, 'ep012')]) {
		for (const f of readdirSync(dir)) {
			if (/\.(pdf|kdenlive|wav|mp3|png)$/.test(f)) rmSync(join(dir, f));
		}
	}
	rmSync(join(PROJECT, 'assets'), { recursive: true, force: true });
	rmSync(join(PROJECT, 'hello.wav'), { force: true });
}

/** Every file under `dir`, as paths relative to it, without `.git`. */
function files(dir) {
	const out = [];
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			if (e.name === '.git') continue;
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else out.push(relative(dir, p));
		}
	};
	walk(dir);
	return out;
}

/** Answer what a run asks a person; a question from the model ends the run as a miss. */
async function answerPrompts(log) {
	for (const p of (await op({ type: 'prompts.list' })) ?? []) {
		const id = p.promptId;
		const choose = (answer) => op({ type: 'prompts.answer', promptId: id, answer });
		if (p.kind === 'question') {
			log.push({ asked: p.detail?.question });
			return 'asked';
		}
		if (p.kind === 'mcp') {
			const readOnly = /(list|get|search|read)/i.test(JSON.stringify(p.detail ?? p));
			await choose({ kind: 'mcp', choice: readOnly ? 'allow_once' : 'deny' });
		} else if (['command', 'sandbox', 'memory'].includes(p.kind)) {
			await choose({ kind: p.kind, choice: 'deny' });
		} else if (p.kind === 'screen-capture') {
			await choose({ kind: p.kind, choice: 'deny' });
		} else if (p.kind === 'repo-trust') {
			await choose({ kind: p.kind, trust: false });
		} else if (p.kind === 'skill') {
			await choose({ kind: 'skill', action: 'reject', reason: 'A test run.' });
		} else {
			log.push({ unanswered: p.kind });
			continue;
		}
		log.push({ answered: p.kind });
	}
	return null;
}

/** What the app's debug log says about one turn: its requests and the tools that ran. */
function readLog(lines) {
	const stats = { requests: 0, promptTokens: [], systemChars: new Set(), toolLists: new Set() };
	const ran = [];
	let loads = 0;
	for (const { line } of lines) {
		if (line.includes('request #') && line.includes('→')) {
			stats.requests++;
			const sys = /"role":"system","chars":(\d+)/.exec(line);
			if (sys) stats.systemChars.add(Number(sys[1]));
			const at = line.indexOf('"tools":[');
			if (at >= 0) stats.toolLists.add(line.slice(at, line.indexOf(']', at)));
		}
		const tokens = /"prompt_tokens":(\d+)/.exec(line);
		if (tokens && (line.includes('response') || line.includes('ended'))) {
			stats.promptTokens.push(Number(tokens[1]));
		}
		const start = /tool start: (\S+)/.exec(line);
		if (start) {
			ran.push(start[1]);
			if (start[1] === 'load_tools') loads++;
		}
	}
	return {
		ran,
		loads,
		requests: stats.requests,
		promptTokens: stats.promptTokens,
		systemChars: [...stats.systemChars],
		toolLists: stats.toolLists.size
	};
}

const stripThinking = (s) => s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

/** Send one message and wait for its turn; a record of what happened. */
async function turn(kind, id, text) {
	const tail = await op({ type: 'debug.tail', since: 1e12 });
	const get = () => op({ type: kind === 'chat' ? 'chat.get' : 'session.get', id });
	const busy = (v) => v.busy || v.running || v.turnRunning || v.waitingForSlot || v.compacting;
	await op({ type: kind === 'chat' ? 'chat.send' : 'session.send', id, text });
	const started = Date.now();
	const log = [];
	let asked = false;
	await sleep(2000);
	let v = await get();
	while (busy(v) && Date.now() - started < Number(o.timeout) * 1000) {
		if ((await answerPrompts(log)) === 'asked') {
			asked = true;
			break;
		}
		await sleep(2000);
		v = await get();
	}
	const timedOut = busy(v) && !asked;
	if (busy(v)) {
		await op({ type: kind === 'chat' ? 'chat.stop' : 'session.stop', id });
		await sleep(3000);
		v = await get();
	}
	const { lines } = await op({ type: 'debug.tail', since: tail.next, lines: 5000 });
	const answer = [...(v.messages ?? [])]
		.reverse()
		.find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
	const steps = Object.values(v.messageSteps ?? {})
		.flat()
		.map((s) => ({ tool: s.toolName, args: s.args, result: String(s.result ?? '').slice(0, 300) }));
	return {
		secs: Math.round((Date.now() - started) / 100) / 10,
		askedUser: asked,
		timedOut,
		error: v.error ?? v.lastError ?? null,
		answer: stripThinking(answer?.content ?? '').slice(0, 2000),
		steps,
		prompts: log,
		...readLog(lines)
	};
}

/**
 * The model and the settings that change how a run goes, recorded with each
 * run: comparing models only means something when these match.
 */
async function conditions() {
	const { settings } = await op({
		type: 'settings.get',
		keys: [
			'inferenceBackend',
			'activeLocalModelFilename',
			'contextSize',
			'chatMaxIterations',
			'codeMaxIterations'
		]
	});
	const b = settings.inferenceBackend ?? {};
	return {
		model:
			b.mode === 'local'
				? settings.activeLocalModelFilename
				: (b.remoteModelId ?? b.openrouterModelId ?? b.mode),
		contextSize: b.mode === 'local' ? settings.contextSize : b.remoteContextSize,
		chatMaxSteps: settings.chatMaxIterations,
		codeMaxSteps: settings.codeMaxIterations
	};
}

/** Set Load tools when needed for the runs, and give back what it was after. */
async function withSetting(fn) {
	const { settings } = await op({ type: 'settings.get', keys: ['deferTools'] });
	const before = settings.deferTools;
	if (o.setting !== 'keep') await op({ type: 'settings.patch', patch: { deferTools: o.setting } });
	try {
		return await fn(o.setting === 'keep' ? (before ?? 'auto') : o.setting);
	} finally {
		if (o.setting !== 'keep')
			await op({ type: 'settings.patch', patch: { deferTools: before ?? 'auto' } });
	}
}

async function newChat() {
	const { id } = await op({ type: 'chat.new' });
	await op({ type: 'chat.memory', id, enabled: false });
	await op({ type: 'chat.folder', id, path: FOLDER });
	return id;
}

async function run() {
	if (!o.label) throw new Error('--label is required');
	const ids = o.prompts === 'all' ? Object.keys(PROMPTS) : o.prompts.split(',');
	const setup = await conditions();
	await withSetting(async (setting) => {
		for (const pid of ids) {
			const p = PROMPTS[pid];
			if (!p) throw new Error(`no prompt ${pid}; see the prompts command`);
			const runs = Number(p.slow ? o['slow-runs'] : o.runs);
			for (let i = 1; i <= runs; i++) {
				clean();
				const id =
					p.tab === 'chat'
						? await newChat()
						: (await op({ type: 'session.new', root: PROJECT })).id;
				const r = await turn(p.tab, id, p.text);
				r.files = files(p.tab === 'chat' ? FOLDER : PROJECT);
				const pass = !r.askedUser && !r.timedOut && p.check(r);
				const rec = {
					label: o.label,
					...setup,
					setting,
					prompt: pid,
					family: p.family,
					run: i,
					id,
					pass,
					...r
				};
				appendFileSync(OUT, JSON.stringify(rec) + '\n');
				console.log(
					`${o.label} ${setting} ${pid} #${i}: ${pass ? 'pass' : 'FAIL'} ${r.secs}s ` +
						`requests ${r.requests}, loads ${r.loads}, ran ${r.ran.join(' ') || '-'}` +
						(r.askedUser ? ', asked the user' : '') +
						(r.error ? `, error ${String(r.error).slice(0, 80)}` : '')
				);
			}
		}
	});
}

async function conversation() {
	if (!o.label) throw new Error('--label is required');
	const setup = await conditions();
	await withSetting(async (setting) => {
		clean();
		const id = await newChat();
		for (const [n, text] of CONVERSATION.entries()) {
			const r = await turn('chat', id, text);
			const rec = {
				label: o.label,
				...setup,
				setting,
				prompt: `conversation-${n + 1}`,
				id,
				text,
				...r
			};
			appendFileSync(OUT, JSON.stringify(rec) + '\n');
			console.log(
				`${o.label} ${setting} turn ${n + 1}: ${r.secs}s requests ${r.requests}, ` +
					`first prompt ${r.promptTokens[0] ?? '-'} tokens, ran ${r.ran.join(' ') || '-'}` +
					(r.error ? `, error ${String(r.error).slice(0, 80)}` : '')
			);
			console.log(`    ${r.answer.slice(0, 160).replace(/\n/g, ' | ')}`);
		}
	});
}

const median = (xs) => {
	if (!xs.length) return '-';
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
};

function summary() {
	const recs = readFileSync(OUT, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((r) => r.pass !== undefined);
	const groups = new Map();
	for (const r of recs) {
		const key = `${r.label}\t${r.setting}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(r);
	}
	for (const [key, rs] of groups) {
		const [label, setting] = key.split('\t');
		const need = rs.filter((r) => r.family);
		const none = rs.filter((r) => !r.family);
		const r0 = rs[0];
		console.log(
			`\n${label} (${r0.model}; context ${r0.contextSize ?? '?'}, max steps ` +
				`${r0.chatMaxSteps ?? '?'} Chat / ${r0.codeMaxSteps ?? '?'} Code), setting ${setting}: ` +
				`${need.filter((r) => r.pass).length}/${need.length} right where a group is needed, ` +
				`${none.filter((r) => r.pass).length}/${none.length} where none is; ` +
				`${none.filter((r) => r.loads > 0).length} needless loads`
		);
		console.log('prompt\tright\trequests\tfirst prompt\tsecs\terrors\tasked');
		for (const pid of [...new Set(rs.map((r) => r.prompt))]) {
			const p = rs.filter((r) => r.prompt === pid);
			console.log(
				[
					pid,
					`${p.filter((r) => r.pass).length}/${p.length}`,
					median(p.map((r) => r.requests)),
					median(p.map((r) => r.promptTokens[0]).filter(Boolean)),
					median(p.map((r) => r.secs)),
					p.filter((r) => r.error).length,
					p.filter((r) => r.askedUser).length
				].join('\t')
			);
		}
	}
}

/** Delete the chats and Code sessions the records in --out name. */
async function cleanup() {
	const recs = readFileSync(OUT, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	const chats = new Set(recs.filter((r) => PROMPTS[r.prompt]?.tab !== 'code').map((r) => r.id));
	const sessions = new Set(recs.filter((r) => PROMPTS[r.prompt]?.tab === 'code').map((r) => r.id));
	for (const id of chats) await op({ type: 'chat.delete', id }).catch(() => {});
	for (const id of sessions) await op({ type: 'session.delete', id }).catch(() => {});
	console.log(`deleted ${chats.size} chats and ${sessions.size} Code sessions`);
}

function listPrompts() {
	for (const [id, p] of Object.entries(PROMPTS)) {
		console.log(
			`${id}\t${p.tab}\t${p.family ?? 'no group'}${p.needs ? `\tneeds ${p.needs}` : ''}\n\t${p.text}`
		);
	}
}

const commands = { setup, run, conversation, summary, cleanup, prompts: listPrompts };
if (!commands[command]) {
	console.error(USAGE);
	process.exit(1);
}
mkdirSync(o.dir, { recursive: true });
try {
	await commands[command]();
} catch (e) {
	console.error(e.message);
	process.exit(1);
}
