import { describe, it, expect, vi } from 'vitest';
import { createEditor, minimalChange } from './codemirror';

describe('createEditor', () => {
	it('holds a document, reports edits and takes a replacement', () => {
		const host = document.createElement('div');
		document.body.append(host);
		const onChange = vi.fn();
		const editor = createEditor(host, { doc: '# Plan\n', onChange });
		expect(editor.getValue()).toBe('# Plan\n');

		editor.setValue('# Revised\n');
		expect(editor.getValue()).toBe('# Revised\n');
		expect(onChange).toHaveBeenLastCalledWith('# Revised\n');

		editor.destroy();
		expect(host.querySelector('.cm-editor')).toBeNull();
	});

	it('saves on Ctrl+S instead of letting the page handle it', () => {
		const host = document.createElement('div');
		document.body.append(host);
		const onSave = vi.fn();
		const editor = createEditor(host, { doc: 'x', onSave });
		const content = host.querySelector('.cm-content')!;
		const event = new KeyboardEvent('keydown', {
			key: 's',
			ctrlKey: true,
			bubbles: true,
			cancelable: true
		});
		content.dispatchEvent(event);
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
		editor.destroy();
	});

	it('keeps the cursor where it was when the text is reloaded', () => {
		const host = document.createElement('div');
		document.body.append(host);
		const editor = createEditor(host, { doc: 'line one\nline two\nline three\n' });
		// The cursor in "line three"; a change above it moves it with the text.
		editor.select(22);
		editor.setValue('line one, changed\nline two\nline three\n');
		expect(editor.selection()).toEqual({ anchor: 31, head: 31 });
		// A change below it leaves it alone.
		editor.setValue('line one, changed\nline two\nline three\nline four\n');
		expect(editor.selection().head).toBe(31);
		editor.destroy();
	});
});

describe('minimalChange', () => {
	it('replaces only what differs', () => {
		expect(minimalChange('abc', 'abc')).toBeNull();
		expect(minimalChange('hello world', 'hello there world')).toEqual({
			from: 6,
			to: 6,
			insert: 'there '
		});
		expect(minimalChange('aaa', 'aa')).toEqual({ from: 2, to: 3, insert: '' });
		expect(minimalChange('', 'new')).toEqual({ from: 0, to: 0, insert: 'new' });
	});
});
