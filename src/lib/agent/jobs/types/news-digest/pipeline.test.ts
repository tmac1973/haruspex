import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeRouter } from '#lib/testing/invoke.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => ({ proxy: null })
}));
vi.mock('#lib/stores/jobRuns.svelte.ts', () => ({
	markRunStarted: vi.fn(async () => {}),
	markRunStepStarted: vi.fn(async () => {}),
	markRunStepFinished: vi.fn(async () => {})
}));

import { runNewsDigestPipeline, type NewsItem } from './pipeline';
import { parseFeed } from './feeds';

const GOOD = 'https://good.example/rss';
const DOWN = 'https://down.example/rss';

function rss(...titles: string[]): string {
	const now = new Date().toUTCString();
	return `<rss version="2.0"><channel><title>Good News</title>${titles
		.map(
			(t) =>
				`<item><title>${t}</title><link>https://good.example/${t}</link><guid>${t}</guid><pubDate>${now}</pubDate><description>About ${t}</description></item>`
		)
		.join('')}</channel></rss>`;
}

function harness(replies: string[]) {
	const h = {
		result: undefined as { items: NewsItem[] } | undefined,
		finished: null as { status: string; error: string | null } | null,
		turns: [] as string[],
		steps: {} as Record<number, Record<string, unknown>>
	};
	const job = {
		id: 1,
		name: 'News',
		type_config: JSON.stringify({ feeds: [DOWN, GOOD], interests: 'space', hours: 24, max: 6 })
	} as unknown as JobWithSteps;
	const ctx = {
		job,
		runId: 9,
		abort: new AbortController(),
		runJobTurn: vi.fn(async (opts: { userMessage: string }) => {
			h.turns.push(opts.userMessage);
			const text = replies.shift() ?? '';
			return { finalText: text, rawText: text };
		}),
		patchStep: (i: number, patch: Record<string, unknown>) => {
			h.steps[i] = { ...h.steps[i], ...patch };
		},
		buildStreamCallbacks: () => ({}),
		setCurrentStepIndex: () => {},
		stepAuthored: () => '',
		contextSize: () => 8192,
		finalizeRun: (status: string, error: string | null) => (h.finished = { status, error }),
		onSettled: () => {},
		setResult: async (value: unknown) => {
			h.result = value as { items: NewsItem[] };
		}
	} as unknown as JobRunContext;
	return { h, ctx };
}

function serve(xml: string) {
	tauri.invoke.mockImplementation(
		invokeRouter({
			proxy_fetch: (a) => {
				if (a?.url === DOWN) throw 'connection refused';
				return { text: xml, full_length: xml.length };
			}
		})
	);
}

beforeEach(() => {
	tauri.invoke.mockReset();
});

describe('news digest pipeline', () => {
	it('keeps going when one feed is down, and takes headlines and links from the feed', async () => {
		serve(rss('Launch', 'Football'));
		const [launch] = await parseFeed(rss('Launch'), GOOD);
		const { h, ctx } = harness([
			`{"items":[{"id":"${launch.id}","summary":"A rocket went up.","title":"FAKE"},{"id":"made-up","summary":"?"}]}`
		]);
		await runNewsDigestPipeline(ctx);

		expect(h.finished).toEqual({ status: 'succeeded', error: null });
		expect(h.steps[0].output).toContain(`Skipped ${DOWN}: connection refused`);
		expect(h.turns[0]).toContain('space');
		expect(h.result?.items).toEqual([
			{
				id: launch.id,
				summary: 'A rocket went up.',
				source: {
					title: 'Launch',
					link: 'https://good.example/Launch',
					source: 'Good News',
					published: launch.published,
					excerpt: 'About Launch'
				}
			}
		]);
		expect(h.steps[1].output).toContain('Ignored 1 id(s)');
	});

	it('stores an empty result without a model turn when no feed has anything recent', async () => {
		serve(rss());
		const { h, ctx } = harness([]);
		await runNewsDigestPipeline(ctx);
		expect(h.result).toEqual({ items: [] });
		expect(h.turns).toEqual([]);
		expect(h.finished?.status).toBe('succeeded');
	});
});
