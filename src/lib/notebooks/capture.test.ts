// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

vi.mock('#lib/stores/notebooks.svelte.ts', () => ({
	emitNotebookChanged: vi.fn(),
	openNotebook: vi.fn()
}));
vi.mock('#lib/notebooks/api.ts', () => ({}));

import { captureSource, tableToCsv, titleFor } from './capture';
import { jobSourceAttr, markedSource, SOURCE_ATTR } from './source';

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

describe('where a capture comes from', () => {
	function inside(attr: string | null): HTMLElement {
		const outer = document.createElement('div');
		if (attr !== null) outer.setAttribute(SOURCE_ATTR, attr);
		outer.innerHTML = '<div class="message assistant"><button>📓</button></div>';
		return outer.querySelector('button')!;
	}

	it("takes a job run's output from its container, not the active tab", async () => {
		const btn = inside(jobSourceAttr(3, 7, 'Audit'));
		expect(await captureSource(btn)).toEqual({ kind: 'job', ref: '3:7', label: 'Audit' });
	});

	it('uses the nearest marked container', () => {
		const btn = inside(jobSourceAttr(3, 7, 'Outer'));
		btn.parentElement!.setAttribute(SOURCE_ATTR, jobSourceAttr(4, null));
		expect(markedSource(btn)).toEqual({ kind: 'job', ref: '4' });
	});

	it('ignores a missing or unreadable mark', () => {
		expect(markedSource(inside(null))).toBeNull();
		expect(markedSource(inside('not json'))).toBeNull();
		expect(markedSource(null)).toBeNull();
	});
});
