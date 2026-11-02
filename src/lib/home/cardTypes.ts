/**
 * The kinds of card Home can show. Later card types register here; a stored
 * card whose type is not listed shows as "Unknown card" with Remove only.
 */
import type { Component } from 'svelte';
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
import JobsCard from '#lib/components/home/cards/JobsCard.svelte';
import CodeSessionsCard from '#lib/components/home/cards/CodeSessionsCard.svelte';
import PinnedJobCard from '#lib/components/home/cards/PinnedJobCard.svelte';
import ImportantEmailsCard from '#lib/components/home/cards/ImportantEmailsCard.svelte';
import ImportantEmailsForm from '#lib/components/home/forms/ImportantEmailsForm.svelte';
import NewsCard from '#lib/components/home/cards/NewsCard.svelte';
import NewsForm from '#lib/components/home/forms/NewsForm.svelte';
import MeetingsCard from '#lib/components/home/cards/MeetingsCard.svelte';
import MeetingsForm from '#lib/components/home/forms/MeetingsForm.svelte';
import WeatherCard from '#lib/components/home/cards/WeatherCard.svelte';
import WeatherForm from '#lib/components/home/forms/WeatherForm.svelte';
import GitHubCard from '#lib/components/home/cards/GitHubCard.svelte';
import GitHubForm from '#lib/components/home/forms/GitHubForm.svelte';
import { GITHUB_PRESETS, fetchGitHub, githubConfigOf, githubServer } from '#lib/home/github.ts';
import { DEFAULT_MEETING_HOURS, fetchMeetings, type MeetingsConfig } from '#lib/home/meetings.ts';
import { fetchWeather, type WeatherConfig } from '#lib/home/weather.ts';
import { getJobs, type JobType, type Schedule } from '#lib/stores/jobs.svelte.ts';
import { getSettings, hasEnabledCalendarAccount } from '#lib/stores/settings.ts';

export type CardSize = 'normal' | 'wide';

/**
 * - `live`: app state, no schedule and no model.
 * - `fetched`: a source read on an interval, no model.
 * - `judged`: a scheduled job whose model picks from a source.
 * - `pinned`: an existing job's latest output.
 */
export type CardKind = 'live' | 'fetched' | 'judged' | 'pinned';

/** What an Add card form is given; `onadd` makes the card's job and the card. */
export interface CardFormProps {
	open: boolean;
	defaultSchedule: Schedule;
	/**
	 * Resolves true once the card is added. A card with a job gets `config`
	 * as its job's settings and the schedule; a fetched card keeps `config`
	 * itself and has no schedule.
	 */
	onadd: (config: Record<string, unknown>, schedule: Schedule) => Promise<boolean>;
	ondone: () => void;
}

export interface CardType {
	id: string;
	/** The card's name in Add card, and its title unless `title` gives one. */
	label: string;
	/** The title for one card of this type (a pinned job's name). */
	title?: (card: HomeCard) => string;
	kind: CardKind;
	/** Rendered inside the card's frame; given the card's row, which a live card may ignore. */
	component: Component<{ card: HomeCard }>;
	defaultSize: CardSize;
	/** Whether Add card offers it now (an email card needs an account, say). */
	addable: () => boolean;
	/**
	 * The job type of the job this card owns (a judged card), made by
	 * `createCardJob` when the card is added. Absent for live and pinned cards.
	 */
	jobType?: JobType;
	/** Whether the card's menu offers Notify on new items. */
	notifies?: boolean;
	/** One result item as a notification names it (an email's subject). */
	itemLabel?: (item: Record<string, unknown>) => string;
	/** The schedule the Add card form starts from. */
	defaultSchedule?: Schedule;
	/** The Add card form, for a card that needs settings before it is added. */
	form?: Component<CardFormProps>;
	/**
	 * A fetched card's source, read with no model; the result is stored on
	 * the card (`last_result`) and is what its component shows.
	 */
	fetch?: (config: Record<string, unknown>) => Promise<unknown>;
	/** How often a fetched card reads its source. */
	intervalMinutes?: (config: Record<string, unknown>) => number;
}

const CARD_TYPES: CardType[] = [
	{
		id: 'jobs',
		label: 'Jobs',
		kind: 'live',
		component: JobsCard,
		defaultSize: 'normal',
		addable: () => true
	},
	{
		id: 'code_sessions',
		label: 'Code sessions',
		kind: 'live',
		component: CodeSessionsCard,
		defaultSize: 'normal',
		addable: () => true
	},
	{
		// The job is the card's `job_id`; Add card asks which one.
		id: 'pinned_job',
		label: 'Pinned job',
		title: (card) => getJobs().find((j) => j.id === card.job_id)?.name ?? 'Pinned job',
		kind: 'pinned',
		component: PinnedJobCard,
		defaultSize: 'normal',
		addable: () => getJobs().length > 0
	},
	{
		id: 'important_emails',
		label: 'Important emails',
		kind: 'judged',
		component: ImportantEmailsCard,
		form: ImportantEmailsForm,
		defaultSize: 'normal',
		addable: () => getSettings().integrations.email.accounts.some((a) => a.enabled),
		jobType: 'email_digest',
		notifies: true,
		itemLabel: (item) => String((item.source as { subject?: string } | undefined)?.subject ?? ''),
		defaultSchedule: { kind: 'interval', minutes: 30 }
	},
	{
		id: 'news',
		label: 'News',
		kind: 'judged',
		component: NewsCard,
		form: NewsForm,
		defaultSize: 'normal',
		addable: () => true,
		jobType: 'news_digest',
		notifies: true,
		itemLabel: (item) => String((item.source as { title?: string } | undefined)?.title ?? ''),
		defaultSchedule: { kind: 'daily', time: '07:00' }
	},
	{
		id: 'upcoming_meetings',
		label: 'Upcoming meetings',
		kind: 'fetched',
		component: MeetingsCard,
		form: MeetingsForm,
		defaultSize: 'normal',
		addable: hasEnabledCalendarAccount,
		fetch: (config) =>
			fetchMeetings({
				hours: DEFAULT_MEETING_HOURS,
				accountIds: [],
				...(config as Partial<MeetingsConfig>)
			}),
		intervalMinutes: () => 10
	},
	{
		id: 'weather',
		label: 'Weather',
		kind: 'fetched',
		component: WeatherCard,
		form: WeatherForm,
		defaultSize: 'normal',
		addable: () => true,
		fetch: (config) => fetchWeather(config as unknown as WeatherConfig),
		intervalMinutes: () => 30
	},
	{
		// Read through the catalog's GitHub MCP server; a card's preset is its title.
		id: 'github',
		label: 'GitHub',
		title: (card) => GITHUB_PRESETS[githubConfigOf(card.config).preset],
		kind: 'fetched',
		component: GitHubCard,
		form: GitHubForm,
		defaultSize: 'normal',
		addable: () => githubServer() !== null,
		notifies: true,
		itemLabel: (item) => `${String(item.repo)}#${String(item.number)} ${String(item.title)}`,
		fetch: (config) => fetchGitHub(config),
		intervalMinutes: () => 15
	}
];

export function cardTypes(): CardType[] {
	return CARD_TYPES;
}

export function getCardType(id: string): CardType | undefined {
	return CARD_TYPES.find((t) => t.id === id);
}
