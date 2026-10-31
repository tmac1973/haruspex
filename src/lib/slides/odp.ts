import { plainText } from '#lib/slides/markdown.ts';
import type { Slide, SlideBullet, SlideChart, SlideLayout } from '#lib/slides/types.ts';

/**
 * The .odp writer (Rust, `fs_tools/odp.rs`) draws two layouts, content and
 * section, with no theme, speaker notes, charts or tables. Every other
 * layout becomes the nearer of those two, keeping its words:
 *
 * - cover, quote and stat → section (title, and subtitle as the tagline);
 * - two-column → content, the right column after the left;
 * - image → content with the image beside the subtitle;
 * - a chart or table → bullets after the slide's own, its numbers in words.
 */

/** A chart as bullets: one a label, its value, or each series' value. */
function chartBullets(chart: SlideChart): SlideBullet[] {
	return chart.labels.map((label, i) => {
		if (chart.series.length === 1) return `${label}: ${chart.series[0].values[i]}`;
		return `${label}: ${chart.series.map((s) => `${s.name} ${s.values[i]}`).join(', ')}`;
	});
}

/** A table as bullets: the header, then each row under it. */
function tableBullets(table: string[][]): SlideBullet[] {
	const [header, ...rows] = table;
	return [header.join(' · '), ...rows.map((r) => ({ text: r.join(' · '), level: 1 }))];
}

const FOLDED_NAMES: Partial<Record<SlideLayout, string>> = {
	cover: 'cover',
	'two-column': 'two-column',
	image: 'image',
	quote: 'quote',
	stat: 'stat'
};

function fold(slide: Slide): Slide {
	const { title, subtitle, bullets = [], right = [], image } = slide;
	switch (slide.layout) {
		case 'cover':
		case 'quote':
		case 'stat':
			return { title, subtitle, layout: 'section' };
		case 'two-column':
			return { title, bullets: [...bullets, ...right], layout: 'content' };
		case 'image':
			return { title, bullets: subtitle ? [subtitle] : [], image, layout: 'content' };
		default: {
			const plain = { ...slide };
			delete plain.right;
			delete plain.notes;
			delete plain.chart;
			delete plain.table;
			const data = slide.chart
				? chartBullets(slide.chart)
				: slide.table
					? tableBullets(slide.table)
					: [];
			if (data.length > 0) plain.bullets = [...bullets, ...data];
			return plain;
		}
	}
}

/**
 * The slides as the .odp writer takes them, and what of the deck it can't
 * show, in words for the tool result: the layouts it drew more plainly, and
 * whether notes were left out. Empty when nothing changed.
 */
export function foldForOdp(slides: Slide[]): { slides: Slide[]; dropped: string[] } {
	const layouts = new Set<string>();
	const data = new Set<string>();
	let notes = false;
	for (const s of slides) {
		const name = s.layout === undefined ? undefined : FOLDED_NAMES[s.layout];
		if (name) layouts.add(name);
		if (s.chart) data.add('charts');
		if (s.table) data.add('tables');
		if (s.notes?.trim()) notes = true;
	}
	const dropped: string[] = [];
	if (layouts.size > 0) {
		dropped.push(`${[...layouts].join(', ')} slides were drawn as plain title or bullet slides`);
	}
	if (data.size > 0) dropped.push(`${[...data].join(' and ')} were listed as bullets`);
	if (notes) dropped.push('speaker notes were left out');
	return { slides: slides.map(fold).map(plainBullets), dropped };
}

/** The .odp writer has no bold runs, so bullets lose their `**` markers. */
function plainBullets(slide: Slide): Slide {
	if (!slide.bullets) return slide;
	const bullets = slide.bullets.map((b) =>
		typeof b === 'string' ? plainText(b) : { ...b, text: plainText(b.text) }
	);
	return { ...slide, bullets };
}
