import { describe, it, expect } from 'vitest';
import { checklistCells, parseChecklistItem } from './checklist';

describe('checklist items', () => {
	it('reads text, done and note, with defaults', () => {
		expect(parseChecklistItem('{"text":"A","done":true,"note":"ok"}')).toEqual({
			text: 'A',
			done: true,
			note: 'ok'
		});
		expect(parseChecklistItem('{}')).toEqual({ text: '', done: false, note: '' });
	});

	it('drops an empty note and keeps other keys', () => {
		const cells = checklistCells({ text: 'A', done: false, note: '  ' }, '{"note":"old","x":1}');
		expect(JSON.parse(cells)).toEqual({ x: 1, text: 'A', done: false });
	});
});
