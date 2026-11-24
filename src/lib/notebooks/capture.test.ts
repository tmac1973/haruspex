// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

vi.mock('#lib/stores/notebooks.svelte.ts', () => ({
	emitNotebookChanged: vi.fn(),
	openNotebook: vi.fn()
}));
vi.mock('#lib/notebooks/api.ts', () => ({}));

import { tableToCsv, titleFor } from './capture';

function table(html: string): HTMLTableElement {
	const div = document.createElement('div');
	div.innerHTML = `<table>${html}</table>`;
	return div.querySelector('table')!;
}

describe('capturing a rendered table', () => {
	it('keeps text, turns a link-only cell into its address, and names empty headers', () => {
		const t = table(
			'<thead><tr><th>Name</th><th></th></tr></thead><tbody>' +
				'<tr><td>JBL, Flip</td><td><a href="https://example.com/a">example.com/a</a></td></tr>' +
				'<tr><td>Buy <a href="https://x.com">here</a></td><td>$5</td></tr></tbody>'
		);
		expect(tableToCsv(t)).toBe('Name,Column 2\n"JBL, Flip",https://example.com/a\nBuy here,$5');
	});
});

describe('titleFor', () => {
	it('uses the first heading, else the first words', () => {
		expect(titleFor('intro\n## Best speakers\nmore')).toBe('Best speakers');
		expect(titleFor('**Short** answer here')).toBe('Short answer here');
		expect(titleFor('x'.repeat(100)).length).toBeLessThanOrEqual(58);
	});
});
