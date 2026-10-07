import { describe, it, expect, vi } from 'vitest';
import { createEditor } from './codemirror';

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
});
