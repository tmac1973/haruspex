import PptxGenJS from 'pptxgenjs';
import { bytesToBase64 } from '#lib/utils/base64.ts';
import {
	bodyBoxes,
	columnBoxes,
	coverBoxes,
	coverImage,
	fitImage,
	imageBoxes,
	LONG,
	numberBox,
	SHORT,
	quoteBoxes,
	ruleBox,
	sectionBoxes,
	statBoxes,
	titleBox
} from '#lib/slides/geometry.ts';
import type { Box } from '#lib/slides/geometry.ts';
import { addChart, addTable } from '#lib/slides/pptxData.ts';
import { dropStrayParagraphProps } from '#lib/slides/pptxRuns.ts';
import { addBullets, addFitted, at, fitBullets, type Build } from '#lib/slides/pptxText.ts';
import { DeckFitError, OVERFLOW_LIMIT, tableProblem } from '#lib/slides/textfit.ts';
import { THEMES } from '#lib/slides/themes.ts';
import { SIZES } from '#lib/slides/sizes.ts';
import type { SlideTheme } from '#lib/slides/themes.ts';
import type { Slide, SlideImage, SlideOrientation } from '#lib/slides/types.ts';

const PORTRAIT_LAYOUT = 'HARUSPEX_PORTRAIT';

function addRule(build: Build, out: PptxGenJS.Slide, box: Box): void {
	out.addShape(build.deck.ShapeType.rect, {
		...at(box),
		fill: { color: build.theme.accent },
		line: { color: build.theme.accent, width: 0 }
	});
}

function imageData(image: SlideImage): string {
	return `${image.mime};base64,${bytesToBase64(image.bytes)}`;
}

/** A content or two-column slide's title, the rule under it, and its number. */
function addHeading(build: Build, out: PptxGenJS.Slide, where: string, slide: Slide): void {
	const { theme, orientation } = build;
	addFitted(build, out, where, 'the title', slide.title, titleBox(orientation), build.sizes.title, {
		bold: true,
		valign: 'bottom',
		color: theme.text,
		fontFace: theme.headFont
	});
	addRule(build, out, ruleBox(orientation));
	out.slideNumber = {
		...at(numberBox(orientation)),
		fontSize: 11,
		align: 'right',
		color: theme.muted,
		fontFace: theme.bodyFont
	};
}

function addCover(build: Build, out: PptxGenJS.Slide, where: string, slide: Slide): void {
	const { theme, sizes } = build;
	const boxes = coverBoxes(build.orientation);
	out.background = { color: theme.band };
	addRule(build, out, boxes.stripe);
	addFitted(build, out, where, 'the title', slide.title, boxes.title, sizes.cover, {
		bold: true,
		valign: 'bottom',
		color: theme.bandText,
		fontFace: theme.headFont
	});
	if (slide.subtitle) {
		out.addText(slide.subtitle, {
			...at(boxes.subtitle),
			fontSize: sizes.tagline,
			valign: 'top',
			color: theme.bandText,
			transparency: 20,
			fontFace: theme.bodyFont
		});
	}
}

function addSection(build: Build, out: PptxGenJS.Slide, where: string, slide: Slide): void {
	const { theme, sizes } = build;
	const boxes = sectionBoxes(build.orientation);
	addRule(build, out, boxes.rule);
	addFitted(build, out, where, 'the title', slide.title, boxes.title, sizes.section, {
		bold: true,
		valign: 'bottom',
		color: theme.text,
		fontFace: theme.headFont
	});
	if (slide.subtitle) {
		out.addText(slide.subtitle, {
			...at(boxes.subtitle),
			fontSize: sizes.tagline,
			valign: 'top',
			color: theme.muted,
			fontFace: theme.bodyFont
		});
	}
}

function addContent(
	build: Build,
	out: PptxGenJS.Slide,
	where: string,
	slide: Slide,
	image: SlideImage | undefined
): void {
	addHeading(build, out, where, slide);
	const bullets = slide.bullets ?? [];
	const data = slide.chart !== undefined || slide.table !== undefined;
	const visual = data ? 'data' : image ? 'image' : undefined;
	const boxes = bodyBoxes(build.orientation, visual, bullets.length > 0);
	let bulletBox = boxes.bullets;
	const box = boxes.visual;
	if (slide.chart && box) addChart(build.deck, out, build.theme, box, slide.chart);
	else if (slide.table && box) {
		const { ratio, height } = addTable(out, build.theme, box, slide.table, build.orientation);
		if (ratio > OVERFLOW_LIMIT) build.problems.push(tableProblem(where, slide.table.length, ratio));
		// Portrait stacks the bullets under the table: under where it ends,
		// not where its share of the body does.
		if (build.orientation === 'portrait' && bullets.length > 0) {
			const y = box.y + Math.min(height, box.h) + 0.5;
			bulletBox = { ...bulletBox, y, h: bulletBox.y + bulletBox.h - y };
		}
	} else if (image && box) {
		out.addImage({ data: imageData(image), ...at(fitImage(box, image.width, image.height)) });
	}
	const scale = fitBullets(build, where, 'the bullets', bullets, bulletBox);
	// A portrait slide of bullets alone sits in the middle of the page, not
	// at the top of an empty one.
	const middle = build.orientation === 'portrait' && !visual;
	addBullets(build, out, bullets, bulletBox, scale, { middle });
}

/**
 * Both columns at one scale, so they match. Portrait stacks them as one
 * list, the second after a wider space: two half-page boxes left a short
 * column's half mostly empty and the pair far apart.
 */
function addTwoColumn(build: Build, out: PptxGenJS.Slide, where: string, slide: Slide): void {
	addHeading(build, out, where, slide);
	const left = slide.bullets ?? [];
	const right = slide.right ?? [];
	if (build.orientation === 'portrait') {
		const box = bodyBoxes('portrait').bullets;
		const all = [...left, ...right];
		const scale = fitBullets(build, where, 'the two columns', all, box, left.length);
		addBullets(build, out, all, box, scale, { breakAt: left.length, middle: true });
		return;
	}
	const boxes = columnBoxes(build.orientation);
	const scale = Math.min(
		fitBullets(build, where, 'the left column', left, boxes.left),
		fitBullets(build, where, 'the right column', right, boxes.right)
	);
	addBullets(build, out, left, boxes.left, scale);
	addBullets(build, out, right, boxes.right, scale);
}

function addImageSlide(
	build: Build,
	out: PptxGenJS.Slide,
	where: string,
	slide: Slide,
	image: SlideImage
): void {
	const { theme, sizes } = build;
	const boxes = imageBoxes(build.orientation);
	const cover = coverImage(boxes.page, image.width, image.height);
	out.addImage({
		data: imageData(image),
		x: 0,
		y: 0,
		...cover.size,
		sizing: { type: 'crop', ...cover.crop }
	});
	out.addShape(build.deck.ShapeType.rect, {
		...at(boxes.strip),
		fill: { color: theme.band, transparency: 15 },
		line: { color: theme.band, width: 0 }
	});
	addFitted(build, out, where, 'the title', slide.title, boxes.title, sizes.imageTitle, {
		bold: true,
		valign: 'top',
		color: theme.bandText,
		fontFace: theme.headFont
	});
	if (slide.subtitle) {
		out.addText(slide.subtitle, {
			...at(boxes.subtitle),
			fontSize: sizes.imageSubtitle,
			valign: 'top',
			color: theme.bandText,
			fontFace: theme.bodyFont
		});
	}
}

function addQuote(build: Build, out: PptxGenJS.Slide, where: string, slide: Slide): void {
	const { theme, sizes } = build;
	const boxes = quoteBoxes(build.orientation);
	out.addText('“', {
		...at(boxes.mark),
		fontSize: sizes.quoteMark,
		bold: true,
		valign: 'top',
		color: theme.accent,
		fontFace: theme.headFont
	});
	addFitted(build, out, where, 'the quote', slide.title, boxes.quote, sizes.quote, {
		italic: true,
		valign: 'middle',
		color: theme.text,
		fontFace: theme.headFont
	});
	if (slide.subtitle) {
		const speaker = /^[-–—]/.test(slide.subtitle) ? slide.subtitle : `— ${slide.subtitle}`;
		out.addText(speaker, {
			...at(boxes.speaker),
			fontSize: sizes.speaker,
			valign: 'top',
			color: theme.muted,
			fontFace: theme.bodyFont
		});
	}
}

function addStat(build: Build, out: PptxGenJS.Slide, where: string, slide: Slide): void {
	const { theme, sizes } = build;
	const boxes = statBoxes(build.orientation);
	addFitted(build, out, where, 'the number', slide.title, boxes.number, sizes.stat, {
		bold: true,
		align: 'center',
		valign: 'bottom',
		color: theme.accent,
		fontFace: theme.headFont
	});
	if (slide.subtitle) {
		out.addText(slide.subtitle, {
			...at(boxes.meaning),
			fontSize: sizes.meaning,
			align: 'center',
			valign: 'top',
			color: theme.text,
			fontFace: theme.bodyFont
		});
	}
}

/** "Slide 3 ("Growth by region")", for a problem the model has to find. */
function slideLabel(num: number, title: string): string {
	const short = title.length > 40 ? `${title.slice(0, 37)}…` : title;
	return `Slide ${num} ("${short}")`;
}

/**
 * Build a .pptx deck. `images` holds every picture the slides name, read by
 * `loadSlideImages`; a slide whose picture is missing from it is a bug in
 * the caller, so it throws rather than leaving a hole. Throws a
 * `DeckFitError` naming every slide whose text won't fit even shrunk, so the
 * caller can refuse the deck before writing anything.
 */
export async function buildPptx(
	slides: Slide[],
	orientation: SlideOrientation,
	images: Map<string, SlideImage>,
	themeName: SlideTheme = 'light'
): Promise<Uint8Array> {
	if (slides.length === 0) throw new Error('At least one slide is required');
	const deck = new PptxGenJS();
	deck.author = 'Haruspex';
	if (orientation === 'portrait') {
		deck.defineLayout({ name: PORTRAIT_LAYOUT, width: SHORT, height: LONG });
		deck.layout = PORTRAIT_LAYOUT;
	} else {
		deck.layout = 'LAYOUT_WIDE';
	}
	const theme = THEMES[themeName];
	const build: Build = {
		deck,
		orientation,
		theme,
		sizes: SIZES[orientation],
		problems: [],
		mixedRuns: false
	};
	slides.forEach((raw, i) => {
		const slide = {
			...raw,
			title: raw.title.trim(),
			subtitle: raw.subtitle?.trim() || undefined
		};
		const where = slideLabel(i + 1, slide.title);
		const image = slide.image === undefined ? undefined : images.get(slide.image);
		if (slide.image !== undefined && !image) throw new Error(`Image not loaded: ${slide.image}`);
		const out = deck.addSlide();
		out.background = { color: theme.background };
		switch (slide.layout) {
			case 'cover':
				addCover(build, out, where, slide);
				break;
			case 'section':
				addSection(build, out, where, slide);
				break;
			case 'two-column':
				addTwoColumn(build, out, where, slide);
				break;
			case 'image':
				if (image) addImageSlide(build, out, where, slide, image);
				else addContent(build, out, where, slide, undefined);
				break;
			case 'quote':
				addQuote(build, out, where, slide);
				break;
			case 'stat':
				addStat(build, out, where, slide);
				break;
			default:
				addContent(build, out, where, slide, image);
		}
		const notes = slide.notes?.trim();
		if (notes) out.addNotes(notes);
	});
	if (build.problems.length > 0) throw new DeckFitError(build.problems);
	const bytes = (await deck.write({ outputType: 'uint8array' })) as Uint8Array;
	return build.mixedRuns ? dropStrayParagraphProps(bytes) : bytes;
}
