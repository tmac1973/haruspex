/**
 * Home for a client (the Remote control web client): `home.cards` answers
 * each card with what it shows, worked out here from the same sources the
 * desktop's cards read, so a client renders it with no Tauri call of its
 * own. Read-only; cards are app-wide in SQLite, so the main window answers.
 */
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
import type { RecentRun } from '#lib/ipc/gen/RecentRun.ts';
import type { ImportantEmail } from '#lib/agent/jobs/types/email-digest/pipeline.ts';
import type { NewsItem } from '#lib/agent/jobs/types/news-digest/pipeline.ts';
import { getCurrentRun, getPendingQueue, getQueueDepth } from '#lib/agent/jobs/runner.svelte.ts';
import { getJobType } from '#lib/agent/jobs/types/index.ts';
import { getCardType } from '#lib/home/cardTypes.ts';
import { getCardError } from '#lib/home/fetchedCards.svelte.ts';
import { currentRunLine, runStatusLabel } from '#lib/home/jobsCard.ts';
import { finalOutput } from '#lib/home/latestRun.svelte.ts';
import { groupOf, type MeetingGroup, type MeetingsResult } from '#lib/home/meetings.ts';
import { weatherLabel, type DayForecast, type WeatherResult } from '#lib/home/weather.ts';
import { dbQuery } from '#lib/stores/dbCall.ts';
import { getHomeCards, loadHomeCards } from '#lib/stores/homeCards.svelte.ts';
import { getJobRun, type JobRunSummary } from '#lib/stores/jobRuns.svelte.ts';
import { getJobs } from '#lib/stores/jobs.svelte.ts';
import type {
	HomeCardPayload,
	HomeCardView,
	HomeEmailItem,
	HomeJobState,
	HomeNewsItem
} from '#lib/engine/types.ts';

/** The most of a pinned job's output a card sends: a card's worth, not a report. */
export const HOME_OUTPUT_MAX = 4096;

const RECENT = 5;

function parse<T>(json: string | null): T | null {
	if (!json) return null;
	try {
		return JSON.parse(json) as T;
	} catch {
		return null;
	}
}

async function jobsPayload(): Promise<HomeCardPayload> {
	const run = getCurrentRun();
	const recent = await dbQuery<RecentRun[]>({
		cmd: 'db_job_runs_list_recent',
		category: 'home',
		args: { limit: RECENT },
		fallback: [],
		onError: 'loading recent job runs failed'
	});
	return {
		type: 'jobs',
		current: run
			? {
					jobName: run.jobName,
					line: currentRunLine(run, getJobType(run.jobType)?.background ?? false)
				}
			: null,
		queued: getQueueDepth(),
		recent: recent.map((r) => ({
			jobName: r.job_name,
			status: runStatusLabel(r.status),
			at: r.finished_at ?? r.started_at
		}))
	};
}

/** A job's latest run, its latest successful one with steps, and what it is doing now. */
async function jobState(jobId: number) {
	const runs = await dbQuery<JobRunSummary[]>({
		cmd: 'db_list_job_runs',
		args: { jobId },
		fallback: [],
		onError: 'loading runs for a Home card failed',
		ctx: { jobId }
	});
	const succeeded = runs.find((r) => r.status === 'succeeded');
	const withSteps = succeeded ? await getJobRun(succeeded.id) : null;
	const current = getCurrentRun();
	const running = current !== null && current.jobId === jobId && current.status === 'running';
	const latest = runs[0] ?? null;
	const state: HomeJobState = {
		running,
		waiting: running && current?.waitingForSlot === true,
		queued: getPendingQueue().some((q) => q.jobId === jobId),
		failed: latest?.status === 'failed' ? (latest.error ?? 'The last run failed.') : null,
		updatedAt: withSteps?.finished_at ?? null
	};
	return { state, run: withSteps };
}

async function pinnedPayload(card: HomeCard): Promise<HomeCardPayload> {
	const jobId = card.job_id;
	const exists = jobId !== null && getJobs().some((j) => j.id === jobId);
	if (jobId === null || !exists) {
		return { type: 'pinned_job', exists: false, ...IDLE, output: null, truncated: false };
	}
	const { state, run } = await jobState(jobId);
	const output = run ? finalOutput(run) : null;
	const truncated = output !== null && output.length > HOME_OUTPUT_MAX;
	return {
		type: 'pinned_job',
		exists: true,
		...state,
		output: truncated ? output.slice(0, HOME_OUTPUT_MAX) : output,
		truncated
	};
}

const IDLE: HomeJobState = {
	running: false,
	waiting: false,
	queued: false,
	failed: null,
	updatedAt: null
};

/** Only what the card shows: the snippet and message handle stay on this computer. */
function emailItems(json: string | null): HomeEmailItem[] | null {
	const items = parse<{ items: ImportantEmail[] }>(json)?.items;
	return (
		items?.map((i) => ({
			from: i.source.from,
			subject: i.source.subject,
			date: i.source.date,
			why: i.why
		})) ?? null
	);
}

function newsItems(json: string | null): HomeNewsItem[] | null {
	const items = parse<{ items: NewsItem[] }>(json)?.items;
	return (
		items?.map((i) => ({
			title: i.source.title,
			link: i.source.link,
			source: i.source.source,
			published: i.source.published,
			summary: i.summary
		})) ?? null
	);
}

async function judgedPayload(
	card: HomeCard,
	type: 'important_emails' | 'news'
): Promise<HomeCardPayload> {
	const job = card.job_id === null ? null : await jobState(card.job_id);
	const state = job?.state ?? IDLE;
	const json = job?.run?.result_json ?? null;
	return type === 'important_emails'
		? { type, ...state, items: emailItems(json) }
		: { type, ...state, items: newsItems(json) };
}

const MEETING_ORDER: MeetingGroup[] = ['Now', 'Later today', 'Tomorrow', 'Later'];

function meetingsPayload(card: HomeCard, now: Date): HomeCardPayload {
	const result = parse<MeetingsResult>(card.last_result);
	const time = (start: string, end: string, allDay: boolean) => {
		if (allDay) return 'All day';
		const fmt = (s: string) =>
			new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		return `${fmt(start)}–${fmt(end)}`;
	};
	let groups = null;
	if (result) {
		const by: Partial<Record<MeetingGroup, typeof result.events>> = {};
		for (const m of result.events) (by[groupOf(m, now)] ??= []).push(m);
		groups = MEETING_ORDER.filter((g) => by[g]).map((g) => ({
			name: g,
			events: by[g]!.map((m) => ({
				summary: m.summary,
				time: time(m.start, m.end, m.allDay),
				location: m.location,
				joinUrl: m.joinUrl
			}))
		}));
	}
	return {
		type: 'upcoming_meetings',
		groups,
		problems: result?.problems ?? [],
		error: getCardError(card.id),
		updatedAt: card.updated_at
	};
}

function weatherPayload(card: HomeCard): HomeCardPayload {
	const result = parse<WeatherResult>(card.last_result);
	const place = parse<{ place?: string }>(card.config)?.place ?? '';
	const deg = result?.units === 'imperial' ? '°F' : '°C';
	const speed = result?.units === 'imperial' ? 'mph' : 'km/h';
	const day = (d: DayForecast) => {
		const rain = d.rain === null ? '' : ` · ${d.rain}% rain`;
		return `${weatherLabel(d.code).label}, ${Math.round(d.min)}–${Math.round(d.max)}${deg}${rain}`;
	};
	const label = result ? weatherLabel(result.now.code) : null;
	return {
		type: 'weather',
		place,
		now:
			result && label
				? {
						temp: `${Math.round(result.now.temp)}${deg}`,
						label: label.label,
						icon: label.icon,
						wind: `${Math.round(result.now.wind)} ${speed}`
					}
				: null,
		today: result ? day(result.today) : null,
		tomorrow: result?.tomorrow ? day(result.tomorrow) : null,
		error: getCardError(card.id),
		updatedAt: card.updated_at
	};
}

async function payloadOf(card: HomeCard, now: Date): Promise<HomeCardPayload> {
	switch (card.card_type) {
		case 'jobs':
			return jobsPayload();
		case 'code_sessions':
			return { type: 'code_sessions' };
		case 'pinned_job':
			return pinnedPayload(card);
		case 'important_emails':
		case 'news':
			return judgedPayload(card, card.card_type);
		case 'upcoming_meetings':
			return meetingsPayload(card, now);
		case 'weather':
			return weatherPayload(card);
		default:
			return { type: 'unknown' };
	}
}

/** Every card, in Home's order, with what it shows. */
export async function homeCards(now = new Date()): Promise<HomeCardView[]> {
	await loadHomeCards();
	return Promise.all(
		getHomeCards().map(async (card) => {
			const type = getCardType(card.card_type);
			return {
				id: card.id,
				size: card.size === 'wide' ? ('wide' as const) : ('normal' as const),
				title: type ? (type.title?.(card) ?? type.label) : 'Unknown card',
				payload: await payloadOf(card, now)
			};
		})
	);
}
