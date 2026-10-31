import type { Slide, SlideLayout } from '#lib/slides/types.ts';

/**
 * The .odp writer (Rust, `fs_tools/odp.rs`) draws two layouts, content and
 * section, with no theme and no speaker notes. Every other layout becomes
 * the nearer of those two, keeping its words:
 *
 * - cover, quote and stat → section (title, and subtitle as the tagline);
 * - two-column → content, the right column after the left;
 * - image → content with the image beside the subtitle.
 */

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
	let notes = false;
	for (const s of slides) {
		const name = s.layout === undefined ? undefined : FOLDED_NAMES[s.layout];
		if (name) layouts.add(name);
		if (s.notes?.trim()) notes = true;
	}
	const dropped: string[] = [];
	if (layouts.size > 0) {
		dropped.push(`${[...layouts].join(', ')} slides were drawn as plain title or bullet slides`);
	}
	if (notes) dropped.push('speaker notes were left out');
	return { slides: slides.map(fold), dropped };
}
