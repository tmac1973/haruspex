/**
 * The card kinds the Notebooks tab can show and add, in "Add card" order.
 * A card whose kind isn't here (one made by a newer version, or a kind
 * whose phase isn't built) shows as `UnavailableCard`.
 */
import type { Component } from 'svelte';
import type { NewCard, NotebookCard } from '#lib/notebooks/api.ts';
import TextCard from '#lib/components/notebooks/cards/TextCard.svelte';
import TableCard from '#lib/components/notebooks/cards/TableCard.svelte';
import ChecklistCard from '#lib/components/notebooks/cards/ChecklistCard.svelte';
import AttachmentCard from '#lib/components/notebooks/cards/AttachmentCard.svelte';
import ImageCard from '#lib/components/notebooks/cards/ImageCard.svelte';

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
	},
	{
		kind: 'table',
		label: 'Table',
		component: TableCard,
		create: () => ({
			kind: 'table',
			title: '',
			body: '',
			meta: JSON.stringify({
				columns: [
					{ id: 'name', name: 'Name', type: 'text' },
					{ id: 'notes', name: 'Notes', type: 'text' }
				]
			}),
			rows: ['{}']
		})
	},
	{
		kind: 'checklist',
		label: 'Checklist',
		component: ChecklistCard,
		create: () => ({
			kind: 'checklist',
			title: '',
			body: '',
			meta: '{}',
			rows: [JSON.stringify({ text: '', done: false })]
		})
	},
	// Both pick files first: NotebookView's onpickkind opens the dialog.
	{ kind: 'image', label: 'Picture…', component: ImageCard, create: null },
	{ kind: 'attachment', label: 'File…', component: AttachmentCard, create: null }
];

export function cardKinds(): CardKindDef[] {
	return KINDS;
}

export function cardKind(kind: string): CardKindDef | undefined {
	return KINDS.find((k) => k.kind === kind);
}
