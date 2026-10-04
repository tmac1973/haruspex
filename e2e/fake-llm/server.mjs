#!/usr/bin/env node
/**
 * A scripted OpenAI-compatible server for end-to-end tests.
 *
 * Model output changes from run to run, so every test that involves the model
 * talks to this instead: it replays the turns of a scenario file. A scenario is
 * a list of `{ match, reply }`; a request gets the reply of the first turn whose
 * `match` fits its last message, and a readable miss otherwise.
 *
 *   node e2e/fake-llm/server.mjs [--port 18765] [--scenario name]
 *   node e2e/fake-llm/server.mjs --record name --upstream http://host:8000/v1
 *
 * Control endpoints, for tests:
 *   POST /__scenario { name } — switch scenario (scenarios/<name>.json)
 *   GET  /__requests          — every chat request received, in order
 *   POST /__reset             — forget the requests
 *
 * Plain Node, no dependencies: it has to start anywhere the app does.
 */

import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 18765;
export const MODEL_ID = 'fake-model';
const SCENARIO_DIR = join(dirname(fileURLToPath(import.meta.url)), 'scenarios');

/** Ports Haruspex's own sidecars use; the fake must never take one. */
const RESERVED_PORTS = new Set([1420, 3001, 8765, 8766, 8767]);

/** A scenario file's turns. */
export function loadScenario(name, dir = SCENARIO_DIR) {
	if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad scenario name: ${name}`);
	const file = join(dir, `${name}.json`);
	if (!existsSync(file)) throw new Error(`no scenario ${name} (${file})`);
	const turns = JSON.parse(readFileSync(file, 'utf8'));
	if (!Array.isArray(turns)) throw new Error(`${file}: a scenario is a list of turns`);
	return turns;
}

function text(content) {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.filter((p) => p && p.type === 'text')
			.map((p) => p.text)
			.join('\n');
	}
	return '';
}

/**
 * The turn that answers `messages`: the first whose `match` fits the last
 * message. `lastUser` tests a user message, `toolResult` a tool result; a turn
 * with neither matches anything.
 */
export function pickTurn(turns, messages) {
	const last = messages[messages.length - 1] ?? { role: 'user', content: '' };
	const body = text(last.content);
	return (
		turns.find(({ match = {} }) => {
			if (match.lastUser !== undefined) {
				return last.role === 'user' && new RegExp(match.lastUser, 'i').test(body);
			}
			if (match.toolResult !== undefined) {
				return last.role === 'tool' && new RegExp(match.toolResult, 'i').test(body);
			}
			return true;
		}) ?? null
	);
}

let callCounter = 0;

/** A reply's tool calls in the OpenAI shape, with ids. */
function toolCalls(reply) {
	return (reply.tool_calls ?? []).map((c) => ({
		id: c.id ?? `call_${++callCounter}`,
		type: 'function',
		function: {
			name: c.name,
			arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {})
		}
	}));
}

function usage(messages, reply) {
	const prompt = Math.ceil(JSON.stringify(messages).length / 4);
	const completion = Math.ceil((reply.content ?? '').length / 4) + 1;
	return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/** The reply for a missed request: says plainly what nothing matched. */
export function missReply(messages) {
	const last = messages[messages.length - 1];
	return { content: `(no scenario matched: ${text(last?.content).slice(0, 200)})` };
}

/** A non-streamed completion. */
export function completionBody(reply, messages) {
	const calls = toolCalls(reply);
	return {
		id: `chatcmpl-${Date.now()}`,
		object: 'chat.completion',
		model: MODEL_ID,
		choices: [
			{
				index: 0,
				message: {
					role: 'assistant',
					content: reply.content ?? null,
					...(calls.length ? { tool_calls: calls } : {})
				},
				finish_reason: calls.length ? 'tool_calls' : 'stop'
			}
		],
		usage: usage(messages, reply)
	};
}

/**
 * A streamed completion, as SSE `data:` lines ending in `[DONE]`: the content
 * a few words at a time, then each tool call as a name delta and an arguments
 * delta, then the finish reason, then usage.
 */
export function streamEvents(reply, messages) {
	const chunk = (delta, finish = null) => ({
		id: 'chatcmpl-stream',
		object: 'chat.completion.chunk',
		model: MODEL_ID,
		choices: [{ index: 0, delta, finish_reason: finish }]
	});
	const events = [chunk({ role: 'assistant' })];
	for (const piece of (reply.content ?? '').match(/\S+\s*|\s+/g) ?? []) {
		events.push(chunk({ content: piece }));
	}
	const calls = toolCalls(reply);
	calls.forEach((c, index) => {
		events.push(
			chunk({
				tool_calls: [
					{ index, id: c.id, type: 'function', function: { name: c.function.name, arguments: '' } }
				]
			})
		);
		events.push(chunk({ tool_calls: [{ index, function: { arguments: c.function.arguments } }] }));
	});
	events.push(chunk({}, calls.length ? 'tool_calls' : 'stop'));
	events.push({ id: 'chatcmpl-stream', object: 'chat.completion.chunk', choices: [], usage: usage(messages, reply) });
	return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).concat('data: [DONE]\n\n');
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = '';
		req.on('data', (c) => (data += c));
		req.on('end', () => resolve(data));
		req.on('error', reject);
	});
}

function send(res, status, body) {
	res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
	res.end(JSON.stringify(body));
}

/** The upstream's answer as a scenario reply, for `--record`. */
async function askUpstream(upstream, body) {
	const r = await fetch(`${upstream.replace(/\/$/, '')}/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...body, stream: false })
	});
	if (!r.ok) throw new Error(`upstream ${r.status}: ${await r.text()}`);
	const msg = (await r.json()).choices?.[0]?.message ?? {};
	return {
		content: msg.content ?? undefined,
		tool_calls: msg.tool_calls?.map((c) => ({
			name: c.function.name,
			arguments: JSON.parse(c.function.arguments || '{}')
		}))
	};
}

/**
 * Create the server. `opts.scenario` names the starting scenario; `opts.record`
 * and `opts.upstream` proxy to a real server and save each exchange as a turn.
 */
export function createFakeLlm(opts = {}) {
	const dir = opts.dir ?? SCENARIO_DIR;
	let turns = opts.scenario ? loadScenario(opts.scenario, dir) : [];
	const requests = [];
	const recorded = [];

	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? '/', 'http://localhost');
			if (req.method === 'OPTIONS') {
				res.writeHead(204, {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Headers': '*',
					'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
				});
				return res.end();
			}
			if (req.method === 'GET' && url.pathname === '/v1/models') {
				return send(res, 200, {
					object: 'list',
					data: [{ id: MODEL_ID, object: 'model', owned_by: 'e2e', context_length: 32768 }]
				});
			}
			if (req.method === 'GET' && url.pathname === '/__requests') return send(res, 200, requests);
			if (req.method === 'POST' && url.pathname === '/__reset') {
				requests.length = 0;
				return send(res, 200, { ok: true });
			}
			if (req.method === 'POST' && url.pathname === '/__scenario') {
				const { name } = JSON.parse(await readBody(req));
				turns = loadScenario(name, dir);
				requests.length = 0;
				return send(res, 200, { ok: true, turns: turns.length });
			}
			if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
				const body = JSON.parse(await readBody(req));
				const messages = body.messages ?? [];
				requests.push(body);
				let reply;
				if (opts.record) {
					reply = await askUpstream(opts.upstream, body);
					const last = messages[messages.length - 1];
					const key = last?.role === 'tool' ? 'toolResult' : 'lastUser';
					const escaped = text(last?.content).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
					recorded.push({ match: { [key]: escaped }, reply });
					writeFileSync(join(dir, `${opts.record}.json`), JSON.stringify(recorded, null, '\t') + '\n');
				} else {
					reply = pickTurn(turns, messages)?.reply ?? missReply(messages);
				}
				if (body.stream) {
					res.writeHead(200, {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						'Access-Control-Allow-Origin': '*'
					});
					for (const event of streamEvents(reply, messages)) res.write(event);
					return res.end();
				}
				return send(res, 200, completionBody(reply, messages));
			}
			send(res, 404, { error: { message: `fake-llm: no route ${req.method} ${url.pathname}` } });
		} catch (e) {
			send(res, 500, { error: { message: `fake-llm: ${e instanceof Error ? e.message : e}` } });
		}
	});

	return {
		server,
		requests,
		listen(port = DEFAULT_PORT) {
			if (RESERVED_PORTS.has(port)) throw new Error(`port ${port} belongs to a Haruspex sidecar`);
			return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
		},
		close() {
			return new Promise((resolve) => server.close(() => resolve()));
		}
	};
}

function arg(name) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const record = arg('record');
	const upstream = arg('upstream');
	if (record && !upstream) {
		console.error('--record needs --upstream <base url ending in /v1>');
		process.exit(2);
	}
	const fake = createFakeLlm({ scenario: arg('scenario'), record, upstream });
	const port = await fake.listen(Number(arg('port') ?? DEFAULT_PORT));
	console.log(`fake-llm listening on http://127.0.0.1:${port}/v1${record ? ` (recording ${record})` : ''}`);
}
