import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/toasts.svelte.ts', () => ({ showToast: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { printable, printHtml } from './print';

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	vi.mocked(showToast).mockReset();
});

describe('print', () => {
	it('drops action buttons, keeps the text of the others, and opens folded parts', () => {
		const html = printable(
			'<div class="code-block"><div class="code-actions"><button data-action="copy">Copy</button></div>' +
				'<pre><code>ls</code></pre></div>' +
				'<button data-action="notebook-add-table">📓 Save</button>' +
				'<button class="notebook-link" data-action="notebook-open">Trip notes</button>' +
				'<details><summary>More</summary>Hidden</details>'
		);
		expect(html).not.toContain('<button');
		expect(html).not.toContain('Copy');
		expect(html).not.toContain('Save');
		expect(html).toContain('<span>Trip notes</span>');
		expect(html).toContain('<details open="">');
		expect(html).toContain('<code>ls</code>');
	});

	it('removes script a page should never carry', () => {
		expect(printable('<p>ok</p><script>alert(1)</script>')).toBe('<p>ok</p>');
	});

	it('hands the document to a print window', async () => {
		await printHtml('Trip', '<p>Go</p>');
		expect(invoke).toHaveBeenCalledWith('print_open', {
			doc: { title: 'Trip', html: '<p>Go</p>' }
		});
	});

	it('says so when the window cannot open', async () => {
		vi.mocked(invoke).mockRejectedValueOnce("Couldn't open the window: no display");
		await printHtml('Trip', '<p>Go</p>');
		expect(showToast).toHaveBeenCalledWith(expect.stringContaining('no display'), {
			kind: 'error'
		});
	});
});
