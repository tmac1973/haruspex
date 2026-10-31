import PptxGenJS from 'pptxgenjs';
import { bytesToBase64 } from '#lib/utils/base64.ts';
import { bodyBoxes, fitImage, sectionBoxes, titleBox } from '#lib/slides/geometry.ts';
import type { Box } from '#lib/slides/geometry.ts';
import type { Slide, SlideBullet, SlideImage, SlideOrientation } from '#lib/slides/types.ts';

const PORTRAIT_LAYOUT = 'HARUSPEX_PORTRAIT';

/** Bullet font sizes by nesting level, in points. */
const BULLET_PT = [18, 16, 14];

type Sizes = { title: number; section: number; subtitle: number };
const SIZES: Record<SlideOrientation, Sizes> = {
	landscape: { title: 32, section: 44, subtitle: 24 },
	portrait: { title: 28, section: 36, subtitle: 20 }
};

const at = (box: Box) => ({ x: box.x, y: box.y, w: box.w, h: box.h });

function bulletRuns(bullets: SlideBullet[]): PptxGenJS.TextProps[] {
	return bullets.map((b) => {
		const text = (typeof b === 'string' ? b : b.text).trim();
		const raw = typeof b === 'string' ? 0 : (b.level ?? 0);
		const level = Math.min(Math.max(Math.trunc(raw), 0), 2);
		return {
			text,
			options: { bullet: true, indentLevel: level, fontSize: BULLET_PT[level], breakLine: true }
		};
	});
}

function addSection(out: PptxGenJS.Slide, slide: Slide, orientation: SlideOrientation): void {
	const boxes = sectionBoxes(orientation);
	const sizes = SIZES[orientation];
	out.addText(slide.title.trim(), {
		...at(boxes.title),
		fontSize: sizes.section,
		bold: true,
		align: 'center',
		valign: 'middle',
		fit: 'shrink'
	});
	const subtitle = slide.subtitle?.trim();
	if (subtitle) {
		out.addText(subtitle, {
			...at(boxes.subtitle),
			fontSize: sizes.subtitle,
			align: 'center',
			valign: 'middle',
			fit: 'shrink'
		});
	}
}

function addContent(
	out: PptxGenJS.Slide,
	slide: Slide,
	orientation: SlideOrientation,
	image: SlideImage | undefined
): void {
	out.addText(slide.title.trim(), {
		...at(titleBox(orientation)),
		fontSize: SIZES[orientation].title,
		bold: true,
		valign: 'top',
		fit: 'shrink'
	});
	const boxes = bodyBoxes(orientation, image !== undefined);
	const bullets = slide.bullets ?? [];
	if (bullets.length > 0) {
		out.addText(bulletRuns(bullets), { ...at(boxes.bullets), valign: 'top', fit: 'shrink' });
	}
	if (image && boxes.image) {
		out.addImage({
			data: `${image.mime};base64,${bytesToBase64(image.bytes)}`,
			...at(fitImage(boxes.image, image.width, image.height))
		});
	}
}

/**
 * Build a .pptx deck. `images` holds every picture the slides name, read by
 * `loadSlideImages`; a slide whose picture is missing from it is a bug in
 * the caller, so it throws rather than leaving a hole.
 */
export async function buildPptx(
	slides: Slide[],
	orientation: SlideOrientation,
	images: Map<string, SlideImage>
): Promise<Uint8Array> {
	if (slides.length === 0) throw new Error('At least one slide is required');
	const deck = new PptxGenJS();
	deck.author = 'Haruspex';
	if (orientation === 'portrait') {
		deck.defineLayout({ name: PORTRAIT_LAYOUT, width: 7.5, height: 13.333 });
		deck.layout = PORTRAIT_LAYOUT;
	} else {
		deck.layout = 'LAYOUT_WIDE';
	}
	for (const slide of slides) {
		const out = deck.addSlide();
		if (slide.layout === 'section') {
			addSection(out, slide, orientation);
			continue;
		}
		const image = slide.image === undefined ? undefined : images.get(slide.image);
		if (slide.image !== undefined && !image) throw new Error(`Image not loaded: ${slide.image}`);
		addContent(out, slide, orientation, image);
	}
	return (await deck.write({ outputType: 'uint8array' })) as Uint8Array;
}
