/**
 * The notebook picker: a small popover listing notebooks (recent first) and
 * "New notebook…", shown next to whatever asked. One at a time, drawn by
 * `NotebookPickerHost` in the root layout; `pickNotebook` resolves with the
 * choice, or null when dismissed.
 */

export interface PickerRequest {
	/** Where to show it (page coordinates). */
	x: number;
	y: number;
	/** `add`: "New notebook…" is offered. `select`: only existing ones. */
	mode: 'add' | 'select';
	/** The heading ("Save table to"). */
	title: string;
	resolve: (notebookId: string | null) => void;
}

let open = $state<PickerRequest | null>(null);
/** The last notebook picked this session, offered first next time. */
let last = $state<string | null>(null);

export const getPicker = () => open;
export const getLastPicked = () => last;

export function pickNotebook(
	at: { x: number; y: number },
	title: string,
	mode: 'add' | 'select' = 'add'
): Promise<string | null> {
	open?.resolve(null);
	return new Promise((resolve) => {
		open = { ...at, mode, title, resolve };
	});
}

/** The host answers with the choice (or null). */
export function answerPicker(notebookId: string | null): void {
	const req = open;
	open = null;
	if (notebookId) last = notebookId;
	req?.resolve(notebookId);
}
