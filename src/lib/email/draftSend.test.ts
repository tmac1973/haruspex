import { describe, expect, it } from 'vitest';
import type { EmailDraft } from '#lib/stores/emailReview.svelte.ts';
import { messageBody, previewHtml, sentSize, usedPictures } from './draftSend';

const draft: EmailDraft = {
	accountId: 'a1',
	to: [],
	cc: [],
	subject: 'Trip',
	body: '',
	references: [],
	format: 'markdown',
	pictures: [
		{
			partId: 'part-1',
			cid: 'p1',
			name: 'a.png',
			mime: 'image/png',
			size: 100,
			previewUrl: 'data:a'
		},
		{
			partId: 'part-2',
			cid: 'p10',
			name: 'b.png',
			mime: 'image/png',
			size: 200,
			previewUrl: 'data:b'
		}
	],
	attachments: [{ partId: 'part-3', name: 'ticket.pdf', mime: 'application/pdf', size: 1000 }]
};

describe('sending a reviewed draft', () => {
	it('sends only the pictures the edited text still shows', () => {
		expect(usedPictures(draft.pictures!, '![A](cid:p10)').map((p) => p.cid)).toEqual(['p10']);
		expect(usedPictures(draft.pictures!, '![A](cid:p1)').map((p) => p.cid)).toEqual(['p1']);
	});

	it('counts the files that will go', () => {
		expect(sentSize(draft, '![A](cid:p1)', new Set())).toBe(1100);
		expect(sentSize(draft, 'none', new Set(['part-3']))).toBe(0);
	});

	it('sends Markdown as text and HTML with its parts', () => {
		const m = messageBody(draft, '**Hi** ![A](cid:p1)', new Set(), [{ id: 'part-9' }]);
		expect(m.body).toBe('**Hi** [Picture: A]');
		expect(m.html).toContain('<strong>Hi</strong>');
		expect(m.html).toContain('src="cid:p1"');
		expect(m.parts).toEqual([{ id: 'part-1', cid: 'p1' }, { id: 'part-3' }, { id: 'part-9' }]);
	});

	it('sends a plain draft as it is, with nothing else', () => {
		const m = messageBody({ ...draft, format: undefined }, '**Hi**', new Set());
		expect(m).toEqual({ body: '**Hi**', parts: [] });
	});

	it('previews pictures from their preview URLs', () => {
		const html = previewHtml(draft, '![A](cid:p1) ![B](cid:p10)');
		expect(html).toContain('src="data:a"');
		expect(html).toContain('src="data:b"');
		expect(html).not.toContain('cid:');
	});
});
