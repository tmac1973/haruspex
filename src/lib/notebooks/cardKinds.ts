/**
 * The card kinds the Notebooks tab can show and add, in "Add card" order.
 * A card whose kind isn't here (one made by a newer version, or a kind
 * whose phase isn't built) shows as `UnavailableCard`.
 */
import type { Component } from 'svelte';
import type { NewCard, NotebookCard } from '#lib/notebooks/api.ts';
import TextCard from '#lib/components/notebooks/cards/TextCard.svelte';

export interface CardViewProps {
	card: NotebookCard;
	/** A History preview: shown, never edited. */
	readonly?: boolean;
}

export interface CardKindDef {
	kind: string;
	/** "Add card" menu label. */
	label: string;
	component: Component<CardViewProps>;
	/** The card "Add card" makes; null when adding needs more (a file picker). */
	create: (() => NewCard) | null;
}

const KINDS: CardKindDef[] = [
	{
		kind: 'text',
		label: 'Text',
		component: TextCard,
		create: () => ({ kind: 'text', title: '', body: '', meta: '{}', rows: null })
	}
];

export function cardKinds(): CardKindDef[] {
	return KINDS;
}

export function cardKind(kind: string): CardKindDef | undefined {
	return KINDS.find((k) => k.kind === kind);
}
