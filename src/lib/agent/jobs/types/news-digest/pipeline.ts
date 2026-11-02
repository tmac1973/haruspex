/**
 * News digest: the job behind Home's News card. Two stages.
 *
 * - Fetch (no model): read each feed and keep the items from the last
 *   `hours`, newest first.
 * - Pick: one model turn chooses the items that match the user's interests,
 *   by id, each with a one-line summary. Ids it made up are dropped, and the
 *   card's headline, link and source come from the feed, never from the model.
 */
import {
	markRunStarted,
	markRunStepFinished,
	markRunStepStarted
} from '#lib/stores/jobRuns.svelte.ts';
import { normalizeAbort, errMessage } from '#lib/utils/error.ts';
import { pickWithRetry, type ResultSchema } from '#lib/agent/jobs/cardResult.ts';
import type { JobRunContext, PlannedStep } from '#lib/agent/jobs/types/types.ts';
import { parseNewsDigestConfig } from '#lib/agent/jobs/types/news-digest/config.ts';
import { fetchFeed, freshItems, type FeedItem } from '#lib/agent/jobs/types/news-digest/feeds.ts';

/** Items the model chooses from, newest first. */
const MAX_CANDIDATES = 60;
/** Summary characters the model sees per item. */
const SUMMARY_CHARS = 200;

const FETCH = 0;
const PICK = 1;

export function planNewsDigestSteps(): PlannedStep[] {
	return [
		{ authored: 'Fetch', deepResearch: false, description: 'Reads your feeds.' },
		{ authored: 'Pick', deepResearch: false, description: 'Picks what fits your interests.' }
	];
}

/** What the card shows for one picked item. */
export interface NewsItem {
	id: string;
	summary: string;
	source: {
		title: string;
		link: string;
		source: string;
		published: number | null;
		/** The feed's own summary. */
		excerpt: string;
	};
}

export function resultSchema(max: number): ResultSchema {
	return { idField: 'id', fields: { summary: 'string' }, max };
}

export function pickPrompt(items: FeedItem[], interests: string, max: number): string {
	const lines = items.map(
		(c, i) =>
			`${i + 1}. id: ${c.id}\n   ${c.title} (${c.source})\n   ${c.summary.slice(0, SUMMARY_CHARS)}`
	);
	return [
		`Here are ${items.length} news items.`,
		'',
		...lines,
		'',
		`Which of them match these interests: ${interests}`,
		'',
		`Reply with only a JSON object: {"items":[{"id":"…","summary":"…"}]}. Use the ids exactly as written above. Pick at most ${max}, best match first, and none if nothing fits. "summary" says in under 20 words what the story is.`
	].join('\n');
}

const SYSTEM_PROMPT =
	'You pick news stories that match a person’s interests. You answer with JSON only, and you only use ids from the list you are given.';

/** The Fetch stage: every feed's fresh items, and a line per feed. */
async function fetchItems(
	feeds: string[],
	hours: number
): Promise<{ items: FeedItem[]; notes: string[] }> {
	const all: FeedItem[] = [];
	const notes: string[] = [];
	for (const url of feeds) {
		try {
			const items = await fetchFeed(url);
			notes.push(`- ${items[0]?.source ?? url}: ${items.length} items`);
			all.push(...items);
		} catch (e) {
			// One feed down doesn't stop the others.
			notes.push(`- Skipped ${url}: ${errMessage(e)}`);
		}
	}
	return { items: freshItems(all, hours, Date.now(), MAX_CANDIDATES), notes };
}

export async function runNewsDigestPipeline(ctx: JobRunContext): Promise<void> {
	const { job, runId } = ctx;
	const config = parseNewsDigestConfig(job.type_config);
	void markRunStarted(runId, Date.now());

	const start = (step: number) => {
		const startedAt = Date.now();
		ctx.patchStep(step, { status: 'running', startedAt });
		ctx.setCurrentStepIndex(step);
		void markRunStepStarted(runId, step, startedAt, ctx.stepAuthored(step));
	};
	const finish = (
		step: number,
		status: 'succeeded' | 'failed' | 'cancelled',
		output: string | null,
		error: string | null
	) => {
		const finishedAt = Date.now();
		ctx.patchStep(step, { status, output: output ?? '', error, finishedAt });
		void markRunStepFinished(runId, step, status, output, error, finishedAt);
	};

	let step = FETCH;
	try {
		start(FETCH);
		const { items, notes } = await fetchItems(config.feeds, config.hours);
		finish(FETCH, 'succeeded', notes.join('\n') || 'No feeds to read.', null);

		step = PICK;
		start(PICK);
		if (items.length === 0) {
			await ctx.setResult({ items: [] });
			finish(PICK, 'succeeded', 'No recent items to pick from.', null);
			ctx.finalizeRun('succeeded', null);
			return;
		}
		const picked = await pickWithRetry(
			ctx,
			{
				systemPrompt: SYSTEM_PROMPT,
				userMessage: pickPrompt(items, config.interests, config.max),
				contextSize: ctx.contextSize(),
				toolAllowlist: [],
				turnKind: 'news_digest.pick',
				...ctx.buildStreamCallbacks(PICK)
			},
			resultSchema(config.max),
			new Set(items.map((i) => i.id))
		);
		const result: NewsItem[] = picked.items.map((p) => {
			const item = items.find((i) => i.id === p.id) as FeedItem;
			return {
				id: item.id,
				summary: String(p.summary),
				source: {
					title: item.title,
					link: item.link,
					source: item.source,
					published: item.published,
					excerpt: item.summary
				}
			};
		});
		await ctx.setResult({ items: result });
		const lines = result.map((i) => `- ${i.source.title} — ${i.summary}`);
		if (picked.dropped > 0) lines.push(`- Ignored ${picked.dropped} id(s) the model made up.`);
		finish(PICK, 'succeeded', lines.join('\n') || 'Nothing matches your interests.', null);
		ctx.finalizeRun('succeeded', null);
	} catch (e) {
		const { aborted, msg } = normalizeAbort(e);
		finish(step, aborted ? 'cancelled' : 'failed', null, msg);
		ctx.finalizeRun(aborted ? 'cancelled' : 'failed', msg);
	} finally {
		ctx.onSettled();
	}
}
