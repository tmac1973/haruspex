// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	clearInfo,
	controlPaths,
	lineReader,
	readInfo,
	request,
	serve,
	writeInfo
} from './control.mjs';
import { summarize, transcript } from './render.mjs';

describe('the control channel', () => {
	const dir = mkdtempSync(join(tmpdir(), 'drive-test-'));
	const paths = controlPaths({ XDG_RUNTIME_DIR: dir }, 'linux');
	let server: { close: () => void } | null = null;

	afterEach(() => {
		server?.close();
		server = null;
		clearInfo(paths);
	});

	it('splits a stream into JSON messages across chunk boundaries', () => {
		const got: unknown[] = [];
		const feed = lineReader((m: unknown) => got.push(m));
		feed('{"a":1}\n{"b"');
		feed(':2}\n\n');
		expect(got).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it('answers a request, and reports a handler error as an error', async () => {
		server = await serve(paths.socket, async (cmd: string, args: { n: number }) => {
			if (cmd === 'double') return args.n * 2;
			throw new Error(`unknown command ${cmd}`);
		});
		expect(await request(paths.socket, 'double', { n: 21 })).toBe(42);
		await expect(request(paths.socket, 'nope')).rejects.toThrow('unknown command nope');
	});

	it('says no driver is running when nothing listens', async () => {
		await expect(request(join(dir, 'missing.sock'), 'status')).rejects.toThrow(
			'no driver is running'
		);
	});

	it('forgets a driver whose process is gone', () => {
		writeInfo({ pid: process.pid }, paths);
		expect(readInfo(paths)?.pid).toBe(process.pid);
		// A pid no process has: above the kernel's limit.
		writeInfo({ pid: 2 ** 30 }, paths);
		expect(readInfo(paths)).toBeNull();
		expect(existsSync(paths.info)).toBe(false);
	});
});

describe('the transcript', () => {
	const session = {
		id: 's1',
		root: '/p',
		status: 'idle',
		lastError: null,
		streamingContent: '',
		messages: [
			{ role: 'user', content: 'fix it' },
			{
				role: 'assistant',
				content: '',
				tool_calls: [{ id: 'c1', function: { name: 'fs_edit_text', arguments: '{"path":"a.js"}' } }]
			},
			{ role: 'tool', tool_call_id: 'c1', content: 'Edited a.js' },
			{ role: 'assistant', content: '<think>All good.</think>\n\nDone.' }
		],
		messageSteps: {
			3: [
				{
					id: 'c1',
					diff: {
						mode: 'edit',
						path: 'a.js',
						added: 1,
						removed: 1,
						truncated: false,
						rows: [
							{ kind: 'del', text: 'i <= n' },
							{ kind: 'add', text: 'i < n' }
						]
					}
				}
			]
		},
		searchSteps: []
	};

	it('puts each call, its result and its diff in order', () => {
		const md = transcript(session, { model: 'm', baseUrl: 'http://x' });
		const order = [
			'## User (#0)',
			'Tool call `fs_edit_text`',
			'Edited a.js',
			'-i <= n',
			'+i < n',
			'Done.'
		];
		const at = order.map((s) => md.indexOf(s));
		expect(at.every((i) => i >= 0)).toBe(true);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
	});

	it('shows reasoning apart from the answer', () => {
		const md = transcript(session, { model: 'm', baseUrl: 'http://x' });
		expect(md).not.toContain('<think>');
		expect(md).toContain('<summary>Reasoning</summary>\n\nAll good.');
	});

	it('summarises the calls and the last reply', () => {
		expect(summarize(session)).toMatchObject({
			turns: 1,
			toolCalls: 1,
			toolCounts: { fs_edit_text: 1 },
			lastAssistant: 'Done.'
		});
	});
});
