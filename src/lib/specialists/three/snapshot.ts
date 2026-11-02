const SAMPLE_W = 64;
const SAMPLE_H = 48;
/** How far a channel may stray from the first pixel and still count as flat. */
const TOLERANCE = 4;

/**
 * What is wrong with a scene's snapshot: today only a picture of one flat
 * colour, which is what a scene that failed to draw anything leaves behind.
 */
export async function snapshotProblems(png: string): Promise<string[]> {
	const bitmap = await createImageBitmap(dataUrlBlob(png));
	const canvas = new OffscreenCanvas(SAMPLE_W, SAMPLE_H);
	const ctx = canvas.getContext('2d');
	if (!ctx) return [];
	ctx.drawImage(bitmap, 0, 0, SAMPLE_W, SAMPLE_H);
	bitmap.close();
	const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
	for (let i = 4; i < data.length; i += 4) {
		for (let c = 0; c < 3; c++) {
			if (Math.abs(data[i + c] - data[c]) > TOLERANCE) return [];
		}
	}
	return ['The scene rendered nothing visible.'];
}

/** A base64 data URL as a Blob. Not `fetch`: the app's CSP keeps `data:` out of connect-src. */
function dataUrlBlob(url: string): Blob {
	const comma = url.indexOf(',');
	const type = /^data:([^;,]*)/.exec(url)?.[1] || 'image/png';
	const bin = atob(url.slice(comma + 1));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Blob([bytes], { type });
}
