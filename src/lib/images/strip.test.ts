import { describe, it, expect, beforeEach } from 'vitest';
import { stripFor } from './figure';
import { clearResolvedImages, getResolvedImages } from './resolve.svelte';
import type { SearchStep } from '$lib/agent/loop';
import type { ImageRow } from '$lib/ipc/gen/ImageRow';

const HASH = '0123456789abcdef'.repeat(4);
const THUMB = 'https://e.test/960px.jpg';
const FULL = 'https://e.test/big.jpg';

function row(source_url: string, hash = HASH): ImageRow {
	return {
		hash,
		source_url,
		source: 'commons',
		mime: 'image/jpeg',
		width: 960,
		height: 640,
		bytes: 170000,
		license: 'cc-by-sa-4.0',
		attribution: 'A Photographer',
		description_url: 'https://commons.wikimedia.org/wiki/File:X.jpg',
		embeddable: true,
		created_at: 0,
		last_used_at: 0
	};
}

function searchStep(): SearchStep {
	return {
		id: 's1',
		toolName: 'image_search',
		query: 'monkeys',
		status: 'done',
		result: JSON.stringify({
			results: [
				{
					url: FULL,
					thumb_url: THUMB,
					source: 'commons',
					license: 'CC BY-SA 4.0',
					attribution: 'A Photographer',
					description_url: 'https://commons.wikimedia.org/wiki/File:X.jpg'
				}
			]
		})
	} as SearchStep;
}

/** Put a resolved image into the shared map the renderer reads. */
function resolve(url: string, hash = HASH) {
	(getResolvedImages() as Map<string, ImageRow>).set(url, row(url, hash));
}

describe('stripFor', () => {
	beforeEach(() => clearResolvedImages());

	it('shows the searched image when the answer embedded none', () => {
		resolve(THUMB);
		const out = stripFor('An answer with no pictures in it.', [searchStep()]);
		expect(out).toHaveLength(1);
		expect(out[0].source_url).toBe(THUMB);
	});

	// The whole point of the hybrid: inline placement next to the relevant
	// paragraph is the better outcome, and the strip must not duplicate it.
	it('shows nothing when the answer already embedded an image', () => {
		resolve(THUMB);
		const out = stripFor(`Here it is:\n\n![a monkey](${THUMB})`, [searchStep()]);
		expect(out).toHaveLength(0);
	});

	it('stands down even when the inline image was a different one', () => {
		resolve(THUMB);
		resolve('https://e.test/other.jpg', 'f'.repeat(64));
		const out = stripFor(`![another](https://e.test/other.jpg)`, [searchStep()]);
		expect(out).toHaveLength(0);
	});

	// An unresolved inline ref renders as nothing, so the answer really does
	// have no picture and the strip should still step in.
	it('still shows when the answer embedded a URL that never resolved', () => {
		resolve(THUMB);
		const out = stripFor('![missing](https://e.test/never-fetched.jpg)', [searchStep()]);
		expect(out).toHaveLength(1);
	});

	it('shows nothing when the candidates never resolved', () => {
		// Nothing seeded into the map: the fetches failed, so the strip is empty
		// rather than a row of broken boxes.
		expect(stripFor('An answer.', [searchStep()])).toHaveLength(0);
	});

	it('shows nothing when no image_search ran', () => {
		resolve(THUMB);
		expect(stripFor('An answer.', [])).toHaveLength(0);
	});
});
