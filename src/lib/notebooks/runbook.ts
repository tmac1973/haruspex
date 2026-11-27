/**
 * A checklist card's **Work through in Shell…**: the message a new Shell tab
 * starts with, typed into its assistant box for you to read, change and send.
 * The checklist is the run's record: the agent ticks each item and writes a
 * note on it, so a stopped turn (or a closed tab) carries on from the first
 * unticked item.
 */

export interface RunbookTarget {
	notebookId: string;
	notebookTitle: string;
	cardId: string;
	cardTitle: string;
}

export function runbookPrompt(t: RunbookTarget): string {
	const card = t.cardTitle ? `the checklist "${t.cardTitle}"` : 'the checklist';
	const link = `[${t.notebookTitle || 'notebook'}](notebook:${t.notebookId}#${t.cardId})`;
	return [
		`Work through ${card} (card ${t.cardId}) in notebook ${link}, here in this terminal.`,
		'Read the notebook first: its other cards may hold the details for each step.',
		'Start at the first item that is not done. For each item: run what it needs, check that it worked, then tick it and write a short note on it (what you did, versions, anything I should know) with notebook_table_rows.',
		'Do one item, then stop and tell me what comes next.',
		'If a step fails or needs a decision from me, write the note, leave it unticked and stop.',
		'When sudo or ssh asks for a password, I type it in the terminal.'
	].join(' ');
}
