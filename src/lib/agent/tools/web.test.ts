import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from './types';
import { RUST_PAYWALL_SENTINEL } from '#lib/agent/paywall.ts';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	runSubAgent: vi.fn(),
	settings: {} as Record<string, unknown>
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

vi.mock('#lib/stores/settings.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/stores/settings.ts')>();
	return {
		...actual,
		getSettings: () => ({ ...actual.getSettings(), ...mocks.settings }),
		getSearchProxy: () => ({ mode: 'none', url: '', bypass: '' })
	};
});

vi.mock('./_helpers', async (importOriginal) => ({
	...(await importOriginal<typeof import('./_helpers')>()),
	runSubAgent: mocks.runSubAgent
}));

import './web';
import { executeTool } from './registry';
import { DEFAULT_SEARXNG_URL } from '#lib/stores/settings.ts';

const ctx = {
	workingDir: null,
	pendingImages: [],
	deepResearch: true,
	shellMode: false,
	codeMode: false,
	codeAutoApprove: false,
	filesWrittenThisTurn: new Set<string>()
} as unknown as ToolContext;

beforeEach(() => {
	mocks.invoke.mockReset();
	mocks.runSubAgent.mockReset();
	mocks.settings = {};
});

function call(tool: string, args: Record<string, unknown>) {
	return executeTool(tool, args, ctx);
}

function errorOf(out: { result: string }): string {
	return (JSON.parse(out.result) as { error: string }).error;
}

/** Answer each command from a table; anything else is a test failure. */
function backend(table: Record<string, (args: Record<string, unknown>) => unknown>) {
	mocks.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
		const fn = table[cmd];
		if (!fn) throw new Error(`unexpected invoke: ${cmd}`);
		return fn(args);
	});
}

function page(text: string, hero: string | null = null) {
	return () => ({ text, hero_image: hero });
}

describe('web_search', () => {
	it('returns the results as JSON', async () => {
		const results = [{ title: 'A', url: 'https://a.test', snippet: 's' }];
		backend({ proxy_search: () => results });
		const out = await call('web_search', { query: 'tauri' });
		expect(JSON.parse(out.result)).toEqual(results);
	});

	it('sends blank settings as nulls and the default SearXNG instance', async () => {
		mocks.settings = { braveApiKey: '', searxngUrl: '', searchRecency: '', browserPath: '' };
		backend({ proxy_search: (a) => [{ echo: a }] });
		const [{ echo }] = JSON.parse((await call('web_search', { query: 'q' })).result);
		expect(echo).toMatchObject({
			query: 'q',
			apiKey: null,
			instanceUrl: DEFAULT_SEARXNG_URL,
			recency: null,
			browserPath: null,
			deepResearch: true
		});
	});

	it('sends configured settings through', async () => {
		mocks.settings = {
			searchProvider: 'brave',
			braveApiKey: 'test-key',
			searxngUrl: 'http://searx.test',
			searchRecency: 'week'
		};
		backend({ proxy_search: (a) => [{ echo: a }] });
		const [{ echo }] = JSON.parse((await call('web_search', { query: 'q' })).result);
		expect(echo).toMatchObject({
			provider: 'brave',
			apiKey: 'test-key',
			instanceUrl: 'http://searx.test',
			recency: 'week'
		});
	});

	it.each([
		['missing', {}],
		['blank', { query: '   ' }]
	])('refuses a %s query without calling the backend', async (_label, args) => {
		const out = await call('web_search', args);
		expect(JSON.parse(out.result)).toEqual({
			error: 'web_search needs a non-empty "query" string.'
		});
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('coerces a numeric query to a string', async () => {
		backend({ proxy_search: (a) => [{ query: a.query }] });
		expect(JSON.parse((await call('web_search', { query: 2024 })).result)).toEqual([
			{ query: '2024' }
		]);
	});

	it('returns a tool error when the search fails', async () => {
		mocks.invoke.mockRejectedValue(new Error('SearXNG unreachable'));
		expect(errorOf(await call('web_search', { query: 'q' }))).toBe(
			'web_search failed: SearXNG unreachable'
		);
	});

	it('returns a tool error for a string rejection', async () => {
		mocks.invoke.mockRejectedValue('rate limited');
		expect(errorOf(await call('web_search', { query: 'q' }))).toBe(
			'web_search failed: rate limited'
		);
	});
});

describe('fetch_url', () => {
	it('returns the page text and its hero image', async () => {
		backend({ proxy_fetch: page('Body text', 'https://a.test/hero.jpg') });
		const out = await call('fetch_url', { url: 'https://a.test' });
		expect(out.result).toBe('Body text');
		expect(out.heroImage).toBe('https://a.test/hero.jpg');
	});

	it('leaves the hero image unset when the page has none', async () => {
		backend({ proxy_fetch: page('Body text') });
		expect((await call('fetch_url', { url: 'https://a.test' })).heroImage).toBeUndefined();
	});

	it('adds https:// to a bare domain', async () => {
		backend({ proxy_fetch: (a) => ({ text: String(a.url), hero_image: null }) });
		expect((await call('fetch_url', { url: ' example.com/path ' })).result).toBe(
			'https://example.com/path'
		);
	});

	it('refuses to return a page the fetcher flagged as paywalled', async () => {
		backend({
			proxy_fetch: page(`${RUST_PAYWALL_SENTINEL} isAccessibleForFree=false\nSECRET-BODY`)
		});
		const out = await call('fetch_url', { url: 'https://news.test/a' });
		expect(out.result).toMatch(
			/^Paywalled: https:\/\/news\.test\/a — isAccessibleForFree=false\. Do NOT cite/
		);
		expect(out.result).not.toContain('SECRET-BODY');
	});

	// Plain text on purpose: the "Failed to fetch" prefix is how the loop and
	// the chat store recognise an unreadable page (FETCH_FAILURE_PREFIXES).
	it('reports a fetch failure as plain text, with the message only', async () => {
		mocks.invoke.mockRejectedValue(new Error('HTTP 404'));
		expect((await call('fetch_url', { url: 'https://a.test/x' })).result).toBe(
			'Failed to fetch URL: HTTP 404'
		);
	});

	it('refuses a missing url without fetching', async () => {
		const out = await call('fetch_url', {});
		expect(JSON.parse(out.result).error).toMatch(/needs a non-empty "url"/);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('reports a string rejection as plain text', async () => {
		mocks.invoke.mockRejectedValue('blocked by proxy');
		expect((await call('fetch_url', { url: 'https://a.test/x' })).result).toBe(
			'Failed to fetch URL: blocked by proxy'
		);
	});
});

describe('research_url', () => {
	const args = { url: 'https://a.test/post', focus: 'release date' };

	it('returns the sub-agent findings with the source and focus', async () => {
		backend({ proxy_fetch: page('Released on 3 March.', 'https://a.test/h.png') });
		mocks.runSubAgent.mockResolvedValue('- Released 3 March');
		const out = await call('research_url', args);
		expect(out.result).toBe(
			'Source: https://a.test/post\nFocus: release date\n\n- Released 3 March'
		);
		expect(out.heroImage).toBe('https://a.test/h.png');
	});

	it('gives the sub-agent the page and the focus', async () => {
		backend({ proxy_fetch: page('PAGE BODY') });
		mocks.runSubAgent.mockImplementation(
			async (messages: { content: string }[]) => messages[1].content
		);
		const out = await call('research_url', args);
		expect(out.result).toContain('Focus: release date\n\nPage URL: https://a.test/post');
		expect(out.result).toContain('Page content:\nPAGE BODY');
	});

	it('reports a fetch failure without running the sub-agent', async () => {
		mocks.invoke.mockRejectedValue(new Error('timeout'));
		mocks.runSubAgent.mockResolvedValue('should not appear');
		expect((await call('research_url', args)).result).toBe('Failed to fetch URL: timeout');
	});

	it('refuses a call without a focus', async () => {
		const out = await call('research_url', { url: 'https://a.test/post' });
		expect(JSON.parse(out.result).error).toMatch(/needs a non-empty "focus"/);
		expect(mocks.runSubAgent).not.toHaveBeenCalled();
	});

	it('reports an empty page', async () => {
		backend({ proxy_fetch: page('') });
		mocks.runSubAgent.mockResolvedValue('should not appear');
		expect((await call('research_url', args)).result).toBe(
			'Failed to fetch URL: https://a.test/post'
		);
	});

	it('passes through a page that is itself a fetch failure', async () => {
		backend({ proxy_fetch: page('Failed to fetch: connection reset') });
		mocks.runSubAgent.mockResolvedValue('should not appear');
		expect((await call('research_url', args)).result).toBe('Failed to fetch: connection reset');
	});

	it('refuses a paywalled page', async () => {
		backend({ proxy_fetch: page(`${RUST_PAYWALL_SENTINEL}\n`) });
		mocks.runSubAgent.mockResolvedValue('should not appear');
		expect((await call('research_url', args)).result).toMatch(
			/^Paywalled: https:\/\/a\.test\/post — page declares itself paywalled in metadata\./
		);
	});

	it('says so when the sub-agent finds nothing', async () => {
		backend({ proxy_fetch: page('Body') });
		mocks.runSubAgent.mockResolvedValue('');
		expect((await call('research_url', args)).result).toBe(
			'Sub-agent returned no findings for https://a.test/post.'
		);
	});

	it('returns a tool error when the sub-agent fails', async () => {
		backend({ proxy_fetch: page('Body') });
		mocks.runSubAgent.mockRejectedValue(new Error('context overflow'));
		expect(errorOf(await call('research_url', args))).toBe(
			'research_url sub-agent for https://a.test/post failed: context overflow'
		);
	});

	it('rethrows a user abort', async () => {
		backend({ proxy_fetch: page('Body') });
		mocks.runSubAgent.mockRejectedValue(new DOMException('aborted', 'AbortError'));
		await expect(call('research_url', args)).rejects.toMatchObject({ name: 'AbortError' });
	});
});

describe('image_search', () => {
	const result = (title: string, n: number) => ({
		title,
		url: `https://img.test/${n}.jpg`,
		thumb_url: `https://img.test/${n}-thumb.jpg`,
		width: 100,
		height: 100,
		license: 'CC BY',
		credit: 'someone'
	});

	it('returns a note when nothing is found', async () => {
		backend({ proxy_image_search: () => [] });
		expect(JSON.parse((await call('image_search', { query: 'zzz' })).result)).toEqual({
			results: [],
			note: 'No images found for "zzz". Try a broader or different query.'
		});
	});

	it('appends ready-made markdown for at most three results', async () => {
		const results = [
			result('File:Red panda.JPG', 1),
			result('Red panda eating', 2),
			result('File:Panda.v2.png', 3),
			result('Fourth', 4)
		];
		backend({ proxy_image_search: () => results });
		const out = (await call('image_search', { query: 'red panda' })).result;
		const [json, hint] = out.split('\n\n[Haruspex hint]');
		expect(JSON.parse(json)).toEqual({ results });
		expect(hint).toContain(
			'![Red panda](https://img.test/1-thumb.jpg)\n' +
				'![Red panda eating](https://img.test/2-thumb.jpg)\n' +
				'![Panda.v2](https://img.test/3-thumb.jpg)\n'
		);
		expect(hint).not.toContain('Fourth');
	});

	it('sends a missing max_results as null and coerces a numeric string', async () => {
		backend({ proxy_image_search: (a) => [result(`max=${a.maxResults}`, 1)] });
		expect((await call('image_search', { query: 'q' })).result).toContain('"max=null"');
		expect((await call('image_search', { query: 'q', max_results: '7' })).result).toContain(
			'"max=7"'
		);
	});

	it('returns a tool error when the search fails', async () => {
		mocks.invoke.mockRejectedValue(new Error('Openverse 503'));
		expect(errorOf(await call('image_search', { query: 'q' }))).toBe(
			'image_search failed: Openverse 503'
		);
	});
});

describe('fetch_url_images', () => {
	it('returns the images found', async () => {
		const images = [{ src: 'https://a.test/1.png', alt: 'one' }];
		backend({ proxy_fetch_url_images: () => images });
		expect(JSON.parse((await call('fetch_url_images', { url: 'https://a.test' })).result)).toEqual({
			images
		});
	});

	it('notes an empty page, naming the URL with its scheme added', async () => {
		backend({ proxy_fetch_url_images: () => [] });
		expect(JSON.parse((await call('fetch_url_images', { url: 'a.test/gallery' })).result)).toEqual({
			images: [],
			note: 'No images found on https://a.test/gallery. The page may be client-rendered or blocked.'
		});
	});

	it('returns a tool error when the fetch fails', async () => {
		mocks.invoke.mockRejectedValue(new Error('TLS handshake failed'));
		expect(errorOf(await call('fetch_url_images', { url: 'https://a.test' }))).toBe(
			'fetch_url_images failed: TLS handshake failed'
		);
	});
});
