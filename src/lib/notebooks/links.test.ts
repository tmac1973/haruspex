import { describe, it, expect, vi } from 'vitest';
import type { NotebookCard, NotebookSummary } from '#lib/notebooks/api.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/settings.ts', () => ({ getSettings: () => ({}) }));

import { collectLinks, RECHECK_MS, shouldAutoCheck } from './links';

const card = (kind: string, over: Partial<NotebookCard>) =>
	({ kind, body: '', meta: '{}', rows: [], ...over }) as NotebookCard;

describe('notebook links', () => {
	it('finds Markdown links, bare URLs, links in lists and tables, and URL cells', () => {
		const links = collectLinks([
			card('text', {
				body: 'See [A](https://a.com) and https://b.com.\n\n- [C](http://c.com)\n\n| x |\n|---|\n| [D](https://d.com) |\n\n[local](notebook:abc)'
			}),
			card('table', {
				meta: JSON.stringify({
					columns: [
						{ id: 'u', name: 'Link', type: 'url' },
						{ id: 't', name: 'Text', type: 'text' }
					]
				}),
				rows: [
					{
						id: 'r',
						position: 1,
						cells: JSON.stringify({ u: 'https://e.com', t: 'https://not-a-link-column.com' })
					}
				]
			})
		]);
		expect(links.sort()).toEqual([
			'http://c.com',
			'https://a.com',
			'https://b.com',
			'https://d.com',
			'https://e.com'
		]);
	});

	it('checks on open when never checked or a week has passed', () => {
		const nb = (at: number | null) => ({ links_checked_at: at }) as NotebookSummary;
		const now = 10 * RECHECK_MS;
		expect(shouldAutoCheck(nb(null), true, now)).toBe(true);
		expect(shouldAutoCheck(nb(now - RECHECK_MS + 1000), true, now)).toBe(false);
		expect(shouldAutoCheck(nb(now - RECHECK_MS), true, now)).toBe(true);
		expect(shouldAutoCheck(nb(null), false, now)).toBe(false);
	});
});
