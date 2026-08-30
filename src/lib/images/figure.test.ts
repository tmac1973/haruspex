import { describe, it, expect } from 'vitest';
import { figureHtml } from './figure';
import { captionFor } from './caption';
import type { ImageRow } from '$lib/ipc/gen/ImageRow';

const HASH = '0123456789abcdef'.repeat(4);

function row(partial: Partial<ImageRow> = {}): ImageRow {
	return {
		hash: HASH,
		source_url: 'https://upload.wikimedia.org/panda.jpg',
		source: 'commons',
		mime: 'image/jpeg',
		width: 800,
		height: 600,
		bytes: 12345,
		license: 'cc-by-sa-4.0',
		attribution: 'A Photographer',
		description_url: 'https://commons.wikimedia.org/wiki/File:Panda.jpg',
		embeddable: true,
		created_at: 0,
		last_used_at: 0,
		...partial
	};
}

describe('figureHtml', () => {
	it('serves the image from the custom scheme, never the source URL', () => {
		const html = figureHtml(row(), 'a red panda')!;
		expect(html).toContain(HASH);
		expect(html).toMatch(/haruspex-img/);
		// The whole point of the pipeline: the remote URL never reaches an
		// <img src>, so the webview never contacts the origin host.
		expect(html).not.toContain('upload.wikimedia.org/panda.jpg');
	});

	it('sets intrinsic dimensions so text does not jump as images land', () => {
		const html = figureHtml(row(), '')!;
		expect(html).toContain('width="800"');
		expect(html).toContain('height="600"');
	});

	it('escapes alt text rather than letting it close the tag', () => {
		const html = figureHtml(row(), '"><script>alert(1)</script>')!;
		expect(html).not.toContain('<script>');
		expect(html).toContain('&quot;');
	});

	it('renders nothing when the row carries a corrupt hash', () => {
		expect(figureHtml(row({ hash: 'not-a-hash' }), 'x')).toBeNull();
	});
});

describe('captionFor', () => {
	it('credits the creator and links the licence for CC BY-SA', () => {
		const caption = captionFor(row())!;
		expect(caption.text).toContain('A Photographer');
		expect(caption.linkLabel).toBe('CC BY-SA 4.0');
		expect(caption.linkHref).toBe('https://commons.wikimedia.org/wiki/File:Panda.jpg');
	});

	it('gives public-domain images no caption at all', () => {
		// PD and CC0 require no credit; a line saying so would be noise.
		expect(captionFor(row({ license: 'pd' }))).toBeNull();
	});

	it('names the site for a scraped image and claims no licence', () => {
		const caption = captionFor(
			row({
				license: 'unknown',
				source: 'page_og',
				source_url: 'https://www.news.example/story',
				attribution: null,
				description_url: null
			})
		)!;
		expect(caption.linkLabel).toBe('news.example');
		expect(JSON.stringify(caption)).not.toMatch(/unknown/i);
	});

	it('still credits the creator when there is no page to link to', () => {
		const caption = captionFor(row({ description_url: null }))!;
		expect(caption.text).toContain('A Photographer');
		expect(caption.text).toContain('CC BY-SA 4.0');
		expect(caption.linkHref).toBe('');
	});

	it('never shows an empty caption or the word unknown', () => {
		const caption = captionFor(
			row({ license: 'unknown', source_url: 'not a url', description_url: null })
		);
		expect(caption).toBeNull();
	});

	it.each([
		['cc-by-4.0', 'CC BY 4.0'],
		['cc-by-sa-3.0', 'CC BY-SA 3.0'],
		['cc-by-nc-2.0', 'CC BY-NC 2.0'],
		['cc-by-nc-nd-4.0', 'CC BY-NC-ND 4.0'],
		['cc-by', 'CC BY']
	])('renders %s as %s', (code, label) => {
		expect(captionFor(row({ license: code }))!.linkLabel).toBe(label);
	});
});
