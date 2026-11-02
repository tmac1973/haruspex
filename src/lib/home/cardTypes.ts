/**
 * The kinds of card Home can show. Later card types register here; a stored
 * card whose type is not listed shows as "Unknown card" with Remove only.
 */
import type { Component } from 'svelte';
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';
import JobsCard from '#lib/components/home/cards/JobsCard.svelte';
import CodeSessionsCard from '#lib/components/home/cards/CodeSessionsCard.svelte';

export type CardSize = 'normal' | 'wide';

/**
 * - `live`: app state, no schedule and no model.
 * - `fetched`: a source read on an interval, no model.
 * - `judged`: a scheduled job whose model picks from a source.
 * - `pinned`: an existing job's latest output.
 */
export type CardKind = 'live' | 'fetched' | 'judged' | 'pinned';

export interface CardType {
	id: string;
	/** The card's title and its name in Add card. */
	label: string;
	kind: CardKind;
	/** Rendered inside the card's frame; given the card's row, which a live card may ignore. */
	component: Component<{ card: HomeCard }>;
	defaultSize: CardSize;
	/** Whether Add card offers it now (an email card needs an account, say). */
	addable: () => boolean;
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
	}
];

export function cardTypes(): CardType[] {
	return CARD_TYPES;
}

export function getCardType(id: string): CardType | undefined {
	return CARD_TYPES.find((t) => t.id === id);
}
