// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSSE, type StreamChunk } from '#lib/api.ts';
// @ts-expect-error — a plain .mjs script with no type declarations.
import { createFakeLlm, pickTurn } from './server.mjs';

const TURNS = [
	{ match: { lastUser: 'weather' }, reply: { content: 'Sunny.' } },
	{
		match: { lastUser: 'save' },
		reply: { tool_calls: [{ name: 'fs_write_text', arguments: { path: 'a.txt' } }] }
	},
	{ match: { toolResult: 'wrote a\\.txt' }, reply: { content: 'Saved it.' } }
];

const dir = mkdtempSync(join(tmpdir(), 'fake-llm-'));
writeFileSync(join(dir, 'test.json'), JSON.stringify(TURNS));

let fake: ReturnType<typeof createFakeLlm>;
let base = '';

beforeAll(async () => {
	fake = createFakeLlm({ dir, scenario: 'test' });
	const port = await fake.listen(0);
	base = `http://127.0.0.1:${port}`;
});
afterAll(() => fake.close());
beforeEach(() => fetch(`${base}/__reset`, { method: 'POST' }));

const ask = (messages: unknown[], stream = false) =>
	fetch(`${base}/v1/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: 'fake-model', messages, stream })
	});

async function chunks(res: Response): Promise<StreamChunk[]> {
	const out: StreamChunk[] = [];
	for await (const c of parseSSE(res)) out.push(c);
	return out;
}

describe('pickTurn', () => {
	it('takes the first turn whose match fits the last message', () => {
		expect(pickTurn(TURNS, [{ role: 'user', content: 'what is the weather' }]).reply.content).toBe(
			'Sunny.'
		);
		expect(
			pickTurn(TURNS, [
				{ role: 'user', content: 'save it' },
				{ role: 'tool', content: 'Wrote a.txt' }
			]).reply.content
		).toBe('Saved it.');
	});

	it('does not answer a tool result with a user turn', () => {
		expect(pickTurn(TURNS, [{ role: 'tool', content: 'the weather' }])).toBeNull();
	});
});

describe('the server', () => {
	it('lists its one model', async () => {
		const body = await (await fetch(`${base}/v1/models`)).json();
		expect(body.data.map((m: { id: string }) => m.id)).toEqual(['fake-model']);
	});

	it('says plainly when no turn matched', async () => {
		const body = await (await ask([{ role: 'user', content: 'tell me a joke' }])).json();
		expect(body.choices[0].message.content).toBe('(no scenario matched: tell me a joke)');
	});

	it('streams valid SSE that the app’s own parser reads back to the reply', async () => {
		const res = await ask([{ role: 'user', content: 'weather?' }], true);
		const raw = await res.clone().text();
		expect(raw.trimEnd().endsWith('data: [DONE]')).toBe(true);
		const got = await chunks(res);
		expect(got.map((c) => c.delta.content ?? '').join('')).toBe('Sunny.');
		expect(got.some((c) => c.finish_reason === 'stop')).toBe(true);
		expect(got.some((c) => c.usage)).toBe(true);
	});

	it('streams a tool call as deltas that assemble to the scripted call', async () => {
		const got = await chunks(await ask([{ role: 'user', content: 'save please' }], true));
		const deltas = got.flatMap((c) => c.delta.tool_calls ?? []);
		const name = deltas.map((d) => d.function?.name ?? '').join('');
		const args = deltas.map((d) => d.function?.arguments ?? '').join('');
		expect(name).toBe('fs_write_text');
		expect(JSON.parse(args)).toEqual({ path: 'a.txt' });
		expect(deltas[0].id).toBeTruthy();
		expect(got.some((c) => c.finish_reason === 'tool_calls')).toBe(true);
	});

	it('answers non-streamed calls in the OpenAI shape', async () => {
		const body = await (await ask([{ role: 'user', content: 'save' }])).json();
		expect(body.choices[0].finish_reason).toBe('tool_calls');
		expect(body.choices[0].message.tool_calls[0].function).toEqual({
			name: 'fs_write_text',
			arguments: '{"path":"a.txt"}'
		});
	});

	it('keeps every request for a test to inspect', async () => {
		await ask([
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'weather' }
		]);
		const requests = await (await fetch(`${base}/__requests`)).json();
		expect(requests).toHaveLength(1);
		expect(requests[0].messages[0]).toEqual({ role: 'system', content: 'sys' });
	});

	it('switches scenario on request', async () => {
		writeFileSync(join(dir, 'other.json'), JSON.stringify([{ reply: { content: 'Other.' } }]));
		await fetch(`${base}/__scenario`, { method: 'POST', body: JSON.stringify({ name: 'other' }) });
		const body = await (await ask([{ role: 'user', content: 'anything' }])).json();
		expect(body.choices[0].message.content).toBe('Other.');
		await fetch(`${base}/__scenario`, { method: 'POST', body: JSON.stringify({ name: 'test' }) });
	});

	it('refuses a port that belongs to a Haruspex sidecar', () => {
		expect(() => createFakeLlm({ dir }).listen(8765)).toThrow(/sidecar/);
	});
});

describe('--record', () => {
	it('saves what the upstream said, and a fresh server replays it the same', async () => {
		const recorder = createFakeLlm({ dir, record: 'recorded', upstream: `${base}/v1` });
		const rport = await recorder.listen(0);
		const question = [{ role: 'user', content: 'weather today' }];
		const first = await (
			await fetch(`http://127.0.0.1:${rport}/v1/chat/completions`, {
				method: 'POST',
				body: JSON.stringify({ messages: question })
			})
		).json();
		await recorder.close();
		expect(JSON.parse(readFileSync(join(dir, 'recorded.json'), 'utf8'))).toHaveLength(1);

		const replay = createFakeLlm({ dir, scenario: 'recorded' });
		const pport = await replay.listen(0);
		const again = await (
			await fetch(`http://127.0.0.1:${pport}/v1/chat/completions`, {
				method: 'POST',
				body: JSON.stringify({ messages: question })
			})
		).json();
		await replay.close();
		expect(again.choices[0].message.content).toBe(first.choices[0].message.content);
		expect(again.choices[0].message.content).toBe('Sunny.');
	});
});
