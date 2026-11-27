import { describe, it, expect } from 'vitest';
import { runbookPrompt } from './runbook';

describe('runbookPrompt', () => {
	it('names the card, links the notebook and says how to record each step', () => {
		const p = runbookPrompt({
			notebookId: 'nb1',
			notebookTitle: 'OpenHands setup',
			cardId: 'c9',
			cardTitle: 'Steps'
		});
		expect(p).toContain('the checklist "Steps" (card c9)');
		expect(p).toContain('[OpenHands setup](notebook:nb1#c9)');
		expect(p).toContain('notebook_table_rows');
		expect(p).toContain('first item that is not done');
		expect(p).toContain('I type it in the terminal');
	});

	it('still reads without a card title', () => {
		const p = runbookPrompt({ notebookId: 'n', notebookTitle: '', cardId: 'c', cardTitle: '' });
		expect(p).toContain('Work through the checklist (card c)');
	});
});
