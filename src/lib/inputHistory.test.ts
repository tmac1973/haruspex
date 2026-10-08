import { describe, expect, it } from 'vitest';
import { InputHistory, caretOnFirstLine, caretOnLastLine, sentHistory } from './inputHistory';

function box(value: string, caret = value.length): HTMLTextAreaElement {
	const el = document.createElement('textarea');
	el.value = value;
	el.setSelectionRange(caret, caret);
	return el;
}

const key = (k: string, mods: KeyboardEventInit = {}) =>
	new KeyboardEvent('keydown', { key: k, ...mods });

describe('sentHistory', () => {
	it('drops blanks and repeats in a row', () => {
		expect(sentHistory(['a', ' ', 'a', 'b ', 'a'])).toEqual(['a', 'b', 'a']);
	});
});

describe('caret lines', () => {
	it('knows the first and last line, and not with a selection', () => {
		const el = box('one\ntwo', 2);
		expect(caretOnFirstLine(el)).toBe(true);
		expect(caretOnLastLine(el)).toBe(false);
		el.setSelectionRange(5, 5);
		expect(caretOnFirstLine(el)).toBe(false);
		expect(caretOnLastLine(el)).toBe(true);
		el.setSelectionRange(0, 3);
		expect(caretOnFirstLine(el)).toBe(false);
	});
});

describe('InputHistory', () => {
	const history = () => new InputHistory(() => ['first', 'second\nline two', 'third']);

	it('steps back with Up, newest first, and stops at the oldest', () => {
		const h = history();
		const el = box('');
		expect(h.key(key('ArrowUp'), el)).toEqual({ text: 'third', caret: 'start' });
		expect(h.key(key('ArrowUp'), box('third', 0))).toEqual({
			text: 'second\nline two',
			caret: 'start'
		});
		expect(h.key(key('ArrowUp'), box('x', 0))).toEqual({ text: 'first', caret: 'start' });
		expect(h.key(key('ArrowUp'), box('first', 0))).toBeNull();
	});

	it('steps forward with Down, back to what was typed', () => {
		const h = history();
		h.key(key('ArrowUp'), box('half-typed'));
		h.key(key('ArrowUp'), box('third', 0));
		expect(h.key(key('ArrowDown'), box('second\nline two'))).toEqual({
			text: 'third',
			caret: 'end'
		});
		expect(h.key(key('ArrowDown'), box('third'))).toEqual({ text: 'half-typed', caret: 'end' });
		expect(h.key(key('ArrowDown'), box('half-typed'))).toBeNull();
	});

	it('leaves the arrows alone inside a multi-line message, with modifiers, or with no history', () => {
		const h = history();
		expect(h.key(key('ArrowUp'), box('a\nb'))).toBeNull();
		expect(h.key(key('ArrowDown'), box('x'))).toBeNull();
		expect(h.key(key('ArrowUp', { shiftKey: true }), box(''))).toBeNull();
		expect(new InputHistory(() => []).key(key('ArrowUp'), box(''))).toBeNull();
	});

	it('starts over after a reset, or when the history shrinks under it', () => {
		let list = ['a', 'b'];
		const h = new InputHistory(() => list);
		h.key(key('ArrowUp'), box(''));
		h.key(key('ArrowUp'), box('b', 0));
		h.reset();
		expect(h.key(key('ArrowUp'), box(''))).toEqual({ text: 'b', caret: 'start' });
		list = [];
		expect(h.key(key('ArrowUp'), box(''))).toBeNull();
	});
});
