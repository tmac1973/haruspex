import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

import {
	buildFeedbackUrl,
	buildFullBundle,
	gatherDiagnostics,
	urlForReport,
	type Diagnostics
} from './feedback';
import { invoke } from '@tauri-apps/api/core';
import { invokeRouter } from '#lib/testing/invoke.ts';
import { beginTurn, logDebug } from '#lib/debugLog.ts';
import { getSettings, updateSettings } from '#lib/stores/settings.ts';

const SECRETS = [
	'sk-remote-key',
	'remote-user',
	'remote-pass',
	'url-query-key',
	'brave-key',
	'searx-user',
	'searx-pass',
	'proxy-pass',
	'search-proxy-pass',
	'email-pass',
	'dav-pass',
	'ghp_mcp_token',
	'the custom system prompt',
	'the code system prompt'
];

function plantSecrets(): void {
	const s = getSettings();
	updateSettings({
		customSystemPrompt: 'the custom system prompt',
		codeCustomSystemPrompt: 'the code system prompt',
		braveApiKey: 'brave-key',
		searxngUrl: 'https://searx-user:searx-pass@search.example.com/searx?token=url-query-key',
		inferenceBackend: {
			...s.inferenceBackend,
			mode: 'remote',
			remoteApiKey: 'sk-remote-key',
			remoteBaseUrl: 'https://remote-user:remote-pass@api.example.com/v1?key=url-query-key'
		},
		proxy: { ...s.proxy, mode: 'manual', url: 'http://u:proxy-pass@proxy.example.com:8080' },
		searchProxy: { mode: 'manual', url: 'http://u:search-proxy-pass@vpn.example.com', bypass: '' },
		integrations: {
			...s.integrations,
			email: {
				...s.integrations.email,
				accounts: [{ id: 'e1', enabled: true, password: 'email-pass' }]
			},
			dav: { ...s.integrations.dav, accounts: [{ id: 'd1', password: 'dav-pass' }] },
			mcp: { ...s.integrations.mcp, servers: [{ id: 'm1', secrets: { token: 'ghp_mcp_token' } }] }
		} as never
	});
}

function diagnostics(): Diagnostics {
	return {
		app_version: '9.9.9',
		os: 'linux',
		arch: 'x86_64',
		appimage: false,
		app_log: ['app line'],
		llama_log: [],
		whisper_log: [],
		tts_log: [],
		crash_log: ['crash line'],
		image_engine_log: ['sd line'],
		comfy_log: ['comfy line'],
		debug_log: ['debug line'],
		mcp_logs: [{ label: 'GitHub', lines: ['mcp line'] }],
		search_stats: {
			session: {
				engines: [
					{
						engine: 'brave',
						attempts: 4,
						successes: 3,
						failures_by_kind: { rate_limited: 1 },
						total_latency_ms: 300,
						max_latency_ms: 150,
						last_success_at: null,
						last_failure_at: null,
						first_choice_attempts: 0,
						fallback_attempts: 0,
						fallback_successes: 0
					}
				],
				globals: { cache_hits: 1, total_queries: 5, all_engines_failed: 0 }
			},
			lifetime: { engines: [], globals: {} }
		}
	};
}

describe('urlForReport', () => {
	it('keeps scheme, host, port and path', () => {
		expect(urlForReport('http://localhost:8080')).toBe('http://localhost:8080');
		expect(urlForReport('https://api.example.com/v1/')).toBe('https://api.example.com/v1/');
	});

	it('drops userinfo, query and fragment', () => {
		expect(urlForReport('https://u:p@api.example.com:8443/v1?key=k#f')).toBe(
			'https://api.example.com:8443/v1'
		);
	});

	it('says so rather than echoing an unparsable value', () => {
		expect(urlForReport('not a url with secret-ish text')).toBe('(not a valid URL)');
		expect(urlForReport('')).toBe('');
	});
});

describe('feedback reports', () => {
	beforeEach(plantSecrets);

	it('the public issue URL carries no credential, prompt or address secret', () => {
		const url = decodeURIComponent(buildFeedbackUrl(diagnostics()).replace(/\+/g, ' '));
		for (const secret of SECRETS) expect(url, secret).not.toContain(secret);
	});

	it('the saved bundle carries none either, outside the logs it was given', () => {
		const bundle = buildFullBundle(diagnostics());
		for (const secret of SECRETS) expect(bundle, secret).not.toContain(secret);
	});

	it('still says which credentials are configured', () => {
		const url = decodeURIComponent(buildFeedbackUrl(diagnostics()).replace(/\+/g, ' '));
		expect(url).toContain('"remoteApiKeyConfigured": true');
		expect(url).toContain('"braveApiKeyConfigured": true');
		expect(url).toContain('"remoteBaseUrl": "https://api.example.com/v1"');
		expect(url).toContain('"hasUrl": true');
	});

	it('puts session search stats in the URL and logs only in the bundle', () => {
		const d = diagnostics();
		const url = decodeURIComponent(buildFeedbackUrl(d).replace(/\+/g, ' '));
		expect(url).toContain('rate_limited:1');
		expect(url).not.toContain('app line');
		const bundle = buildFullBundle(d);
		expect(bundle).toContain('app line');
		expect(bundle).toContain('debug line');
	});

	it('saves every log the log viewer shows', () => {
		const bundle = buildFullBundle(diagnostics());
		expect(bundle).toContain('## llama-server crash log (1 lines)\n```\ncrash line');
		expect(bundle).toContain('## Image engine (sd-server) (1 lines)\n```\nsd line');
		expect(bundle).toContain('## ComfyUI calls (1 lines)\n```\ncomfy line');
		expect(bundle).toContain('## MCP: GitHub (1 lines)\n```\nmcp line');
	});
});

describe('gatherDiagnostics', () => {
	it('hands the webview debug log to Rust for redaction and reports what comes back', async () => {
		beginTurn();
		logDebug('agent', 'token=hunter2 sent');
		const sent: string[][] = [];
		vi.mocked(invoke).mockImplementation(
			invokeRouter({
				get_diagnostics: { app_log: [], llama_log: [], whisper_log: [], tts_log: [] },
				feedback_redact: (args) => {
					const lines = (args as { lines: string[] }).lines;
					sent.push(lines);
					return lines.map((l) => l.replace('hunter2', '[redacted]'));
				}
			})
		);
		const d = await gatherDiagnostics();
		expect(sent[0].some((l) => l.includes('hunter2'))).toBe(true);
		expect(d.debug_log.join('\n')).not.toContain('hunter2');
		expect(d.debug_log.join('\n')).toContain('token=[redacted] sent');
	});

	it("collects each switched-on MCP server's log, redacted, under its name", async () => {
		const s = getSettings();
		updateSettings({
			integrations: {
				...s.integrations,
				mcp: {
					...s.integrations.mcp,
					servers: [
						{ id: 'on', label: 'Blender', enabled: true, setupComplete: true },
						{ id: 'off', label: 'Godot', enabled: false, setupComplete: true },
						{ id: 'broken', label: 'Broken', enabled: true, setupComplete: true }
					]
				}
			} as never
		});
		vi.mocked(invoke).mockImplementation(
			invokeRouter({
				get_diagnostics: { app_log: [], llama_log: [], whisper_log: [], tts_log: [] },
				mcp_server_logs: (args) => {
					if ((args as { id: string }).id === 'broken') throw new Error('gone');
					return ['key=abc started'];
				},
				feedback_redact: (args) =>
					(args as { lines: string[] }).lines.map((l) => l.replace('abc', '[redacted]'))
			})
		);
		const d = await gatherDiagnostics();
		expect(d.mcp_logs).toEqual([{ label: 'Blender', lines: ['key=[redacted] started'] }]);
	});
});
