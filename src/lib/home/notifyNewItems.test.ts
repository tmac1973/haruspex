import { describe, expect, it } from 'vitest';
import { newItemsMessage } from './notifyNewItems';

const label = (i: { id: string; subject: string }) => i.subject;
const a = { id: 'a', subject: 'Invoice' };
const b = { id: 'b', subject: 'Offsite' };
const c = { id: 'c', subject: 'Payroll' };

describe('newItemsMessage', () => {
	it('stays quiet for the first result and when nothing is new', () => {
		expect(newItemsMessage(undefined, [a], 'id', label)).toBeNull();
		expect(newItemsMessage([a, b], [b, a], 'id', label)).toBeNull();
		expect(newItemsMessage([a, b], [a], 'id', label)).toBeNull();
	});

	it('names the first new item, and counts the rest', () => {
		expect(newItemsMessage([a], [a, b], 'id', label)).toBe('Offsite');
		expect(newItemsMessage([a], [b, a, c], 'id', label)).toBe('Offsite and 1 more');
	});
});
