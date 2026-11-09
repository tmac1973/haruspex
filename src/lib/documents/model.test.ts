import { describe, it, expect } from 'vitest';
import { documentModel, modelImages, runText } from './model';

describe('documentModel', () => {
	it('reads headings and styled runs, links only to web and mail', () => {
		const [h, p] = documentModel(
			'## Heat **pumps**\n\n**Bold** *it* ~~old~~ `code` [web](https://x.org) [file](notes.md) &amp;<br>next'
		);
		expect(h).toEqual({
			kind: 'heading',
			level: 2,
			runs: [{ text: 'Heat ' }, { text: 'pumps', bold: true }]
		});
		expect(p.kind === 'paragraph' && p.runs).toEqual([
			{ text: 'Bold', bold: true },
			{ text: ' ' },
			{ text: 'it', italic: true },
			{ text: ' ' },
			{ text: 'old', strike: true },
			{ text: ' ' },
			{ text: 'code', code: true },
			{ text: ' ' },
			{ text: 'web', link: 'https://x.org' },
			{ text: ' ' },
			{ text: 'file' },
			{ text: ' &' },
			{ text: '', br: true },
			{ text: 'next' }
		]);
	});

	it('nests lists, keeps where a numbered one starts, and ticks checklists', () => {
		const [list, tasks] = documentModel('3. one\n4. two\n   - inner\n\n- [x] done\n- [ ] not');
		expect(list).toMatchObject({ kind: 'list', ordered: true, start: 3 });
		const items = list.kind === 'list' ? list.items : [];
		expect(items[1].blocks.map((b) => b.kind)).toEqual(['paragraph', 'list']);
		expect(tasks.kind === 'list' && tasks.items.map((i) => i.checked)).toEqual([true, false]);
		const first = tasks.kind === 'list' ? tasks.items[0].blocks[0] : undefined;
		expect(first?.kind === 'paragraph' && runText(first.runs)).toBe('done');
	});

	it('right-aligns a column of numbers unless the markdown aligns it', () => {
		const [t] = documentModel('| A | N | C |\n|---|---|:-:|\n| x | 1,200 | 3 |\n| y | 4.5% | 4 |');
		expect(t.kind === 'table' && t.align).toEqual(['left', 'right', 'center']);
	});

	it('takes a picture on its own line with its options, and code, quotes and rules', () => {
		const tree = documentModel(
			'![Chart](c.png "center 50%")\n\n```\n  a\tb\n```\n\n> said\n\n---\n\n- ![Pic](d.png)'
		);
		expect(tree[0]).toEqual({
			kind: 'image',
			path: 'c.png',
			alt: 'Chart',
			align: 'center',
			fraction: 0.5
		});
		expect(tree[1]).toEqual({ kind: 'code', text: '  a    b' });
		expect(tree[2].kind).toBe('quote');
		expect(tree[3].kind).toBe('rule');
		expect(modelImages(tree)).toEqual(['c.png', 'd.png']);
	});

	it('writes an inline picture as its alt text', () => {
		const [p] = documentModel('See ![the chart](c.png) here.');
		expect(p.kind === 'paragraph' && runText(p.runs)).toBe('See [the chart] here.');
	});
});
