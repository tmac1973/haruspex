import { describe, expect, it } from 'vitest';
import { freshItems, parseFeed, type FeedItem } from './feeds';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>BBC News</title>
    <item>
      <title>Storm reaches the coast</title>
      <link>https://example.com/storm</link>
      <guid isPermaLink="false">storm-1</guid>
      <pubDate>Mon, 02 Nov 2026 08:00:00 GMT</pubDate>
      <description><![CDATA[<p>Winds of <b>120 km/h</b> are expected.</p>]]></description>
    </item>
    <item>
      <title>No guid here</title>
      <link>https://example.com/no-guid</link>
      <description>Plain text.</description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Ars Technica</title>
  <entry>
    <title>A new Rust release</title>
    <link rel="alternate" href="https://example.com/rust"/>
    <link rel="replies" href="https://example.com/rust#comments"/>
    <id>tag:example.com,2026:rust</id>
    <updated>2026-11-02T09:30:00Z</updated>
    <summary type="html">&lt;p&gt;Faster builds.&lt;/p&gt;</summary>
  </entry>
</feed>`;

describe('parseFeed', () => {
	it('reads RSS 2.0, stripping markup from the description', async () => {
		const [storm, noGuid] = await parseFeed(RSS, 'https://bbc.example/rss.xml');
		expect(storm).toMatchObject({
			title: 'Storm reaches the coast',
			link: 'https://example.com/storm',
			source: 'BBC News',
			published: Date.parse('2026-11-02T08:00:00Z'),
			summary: 'Winds of 120 km/h are expected.'
		});
		expect(storm.id).toMatch(/^[0-9a-f]{16}$/);
		expect(noGuid.published).toBeNull();
	});

	it('reads Atom, taking the alternate link', async () => {
		const [entry] = await parseFeed(ATOM, 'https://ars.example/feed');
		expect(entry).toMatchObject({
			title: 'A new Rust release',
			link: 'https://example.com/rust',
			source: 'Ars Technica',
			published: Date.parse('2026-11-02T09:30:00Z'),
			summary: 'Faster builds.'
		});
	});

	it('gives an item the same id every time, and a different one in another feed', async () => {
		const a = await parseFeed(RSS, 'https://bbc.example/rss.xml');
		const b = await parseFeed(RSS, 'https://bbc.example/rss.xml');
		const other = await parseFeed(RSS, 'https://mirror.example/rss.xml');
		expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
		expect(other[0].id).not.toBe(a[0].id);
		// An item with no guid is keyed by its link.
		expect(a[1].id).not.toBe(a[0].id);
	});

	it('refuses an HTML page where a feed was expected', async () => {
		await expect(
			parseFeed('<!doctype html><html><body>Hi</body></html>', 'https://x.example')
		).rejects.toThrow('Not a feed.');
	});
});

describe('freshItems', () => {
	const now = Date.parse('2026-11-02T12:00:00Z');
	const item = (id: string, hoursAgo: number | null, link = `https://x/${id}`): FeedItem => ({
		id,
		title: id,
		link,
		source: 'S',
		published: hoursAgo === null ? null : now - hoursAgo * 3_600_000,
		summary: ''
	});

	it('keeps recent and undated items, newest first, one per link, up to the cap', () => {
		const out = freshItems(
			[
				item('old', 30),
				item('b', 2),
				item('a', 1),
				item('same', 3, 'https://x/a'),
				item('n', null)
			],
			24,
			now,
			3
		);
		expect(out.map((i) => i.id)).toEqual(['a', 'b', 'n']);
	});
});
