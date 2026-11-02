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
import { getJobs, type JobType, type Schedule } from '#lib/stores/jobs.svelte.ts';
import { getSettings } from '#lib/stores/settings.ts';

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
	/** Resolves true once the card is added. */
	onadd: (typeConfig: Record<string, unknown>, schedule: Schedule) => Promise<boolean>;
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
	}
];

export function cardTypes(): CardType[] {
	return CARD_TYPES;
}

export function getCardType(id: string): CardType | undefined {
	return CARD_TYPES.find((t) => t.id === id);
}
