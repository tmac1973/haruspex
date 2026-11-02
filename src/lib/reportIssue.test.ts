import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

import { issueText, issueTitle, logTail, reportIssue } from '#lib/reportIssue.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';

beforeEach(() => mocks.invoke.mockReset());

describe('the issue text', () => {
	it('keeps the newest log lines that fit', () => {
		expect(logTail(['one', 'two', 'three'], 10)).toEqual(['two', 'three']);
	});

	it('names the error, the bundle and as much of the log as fits', () => {
		const log = Array.from({ length: 500 }, (_, i) => `line ${i} ` + 'x'.repeat(40));
		const text = issueText(
			{ where: 'Chat', error: 'HTTP 500 from server', log, logTitle: 'Debug log' },
			'haruspex-diagnostics-1.md'
		);
		expect(text).toMatch(/^Chat failed with:\n\n```\nHTTP 500 from server\n```/);
		expect(text).toContain('saved as haruspex-diagnostics-1.md');
		expect(text).toMatch(/Debug log, last \d+ of 500 lines:/);
		expect(text).toContain('line 499');
		expect(text).not.toContain('line 0 ');
		expect(text.length).toBeLessThan(3_600);
	});

	it('leaves the log out when there is none', () => {
		expect(issueText({ where: 'Chat', error: 'boom' }, 'd.md')).toMatch(
			/What were you doing when it happened\?$/
		);
	});

	it('titles the issue with where and the error, kept short', () => {
		expect(issueTitle({ where: 'Chat', error: 'boom\nmore' })).toBe('[Bug] Chat: boom more');
		expect(issueTitle({ where: 'Chat', error: 'x'.repeat(300) }).length).toBe(90);
	});
});

describe('reportIssue', () => {
	it('saves the bundle into Downloads, opens it, then opens the redacted issue', async () => {
		const calls: string[] = [];
		mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
			calls.push(cmd);
			return invokeRouter({
				get_diagnostics: {
					app_version: '9.9.9',
					os: 'linux',
					arch: 'x86_64',
					appimage: false,
					app_log: [],
					llama_log: [],
					whisper_log: [],
					tts_log: [],
					crash_log: [],
					image_engine_log: [],
					comfy_log: [],
					search_stats: {
						session: {
							engines: [],
							globals: { cache_hits: 0, total_queries: 0, all_engines_failed: 0 }
						},
						lifetime: { engines: [], globals: {} }
					}
				},
				feedback_redact: (a) =>
					(a as { lines: string[] }).lines.map((l) => l.replace('sk-123', '[redacted]')),
				feedback_save_download: '/home/me/Downloads/haruspex-diagnostics-x.md',
				folder_open: undefined,
				open_url: undefined
			})(cmd, args);
		});
		const path = await reportIssue({
			where: 'Chat',
			error: 'auth failed for sk-123',
			log: ['sent sk-123']
		});
		expect(path).toBe('/home/me/Downloads/haruspex-diagnostics-x.md');
		expect(calls.indexOf('feedback_save_download')).toBeLessThan(calls.indexOf('open_url'));
		const save = mocks.invoke.mock.calls.find((c) => c[0] === 'feedback_save_download')![1];
		expect(save).toMatchObject({ extension: 'md' });
		expect(mocks.invoke.mock.calls.find((c) => c[0] === 'folder_open')![1]).toEqual({
			path: '/home/me/Downloads'
		});
		const url = new URL(mocks.invoke.mock.calls.find((c) => c[0] === 'open_url')![1].url);
		const body = url.searchParams.get('what-happened') ?? '';
		expect(url.searchParams.get('title')).toBe('[Bug] Chat: auth failed for [redacted]');
		expect(body).toContain('saved as haruspex-diagnostics-x.md');
		expect(body).toContain('sent [redacted]');
		expect(body).not.toContain('sk-123');
		expect(url.searchParams.get('version')).toBe('9.9.9');
	});
});
