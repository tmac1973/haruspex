import JSZip from 'jszip';

/**
 * PptxGenJS writes paragraph properties before every run, not just the
 * first, and a run after the first has no `bullet`, so its properties turn
 * the bullet off: `**Habitat loss** - clearing` came out with no bullet. An
 * `<a:pPr>` after a run is never valid OOXML, so dropping each one leaves
 * the paragraph with the first run's properties, as written.
 */
const STRAY_PARAGRAPH_PROPS = /<\/a:r><a:pPr\b[^>]*(?:\/>|>.*?<\/a:pPr>)/g;

const SLIDE_PART = /^ppt\/slides\/slide\d+\.xml$/;

/** `deck` with the stray paragraph properties taken out of every slide. */
export async function dropStrayParagraphProps(deck: Uint8Array): Promise<Uint8Array> {
	const zip = await JSZip.loadAsync(deck);
	for (const name of Object.keys(zip.files).filter((n) => SLIDE_PART.test(n))) {
		const xml = await zip.file(name)!.async('string');
		const fixed = xml.replace(STRAY_PARAGRAPH_PROPS, '</a:r>');
		if (fixed !== xml) zip.file(name, fixed);
	}
	return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
