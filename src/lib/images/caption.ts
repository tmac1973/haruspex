/**
 * Attribution captions.
 *
 * CC BY and CC BY-SA legally require credit wherever the image is displayed,
 * and a caption is the only place a chat reply can put it. So the caption is
 * generated here from the provenance recorded at fetch time — never from
 * anything the model wrote. A model cannot hallucinate a photographer's name
 * into it, and cannot forget to include one.
 *
 * What each licence class gets:
 *
 *   - `pd` — no caption. Public domain and CC0 require no credit, and a line
 *     saying so is noise.
 *   - `cc-by*` — creator and licence, with the licence linked to the source
 *     page so a reader can check the terms.
 *   - `unknown` — every scraped `og:image`. The site's hostname, linked. That
 *     is honest about where the picture came from without claiming a licence
 *     nobody verified.
 */

import type { ImageRow } from '$lib/ipc/gen/ImageRow';

/** Human-readable licence names for the codes `image_cache::license` emits. */
const LICENSE_LABELS: Record<string, string> = {
	'cc-by': 'CC BY',
	'cc-by-sa': 'CC BY-SA',
	'cc-by-nc': 'CC BY-NC',
	'cc-by-nd': 'CC BY-ND',
	'cc-by-nc-sa': 'CC BY-NC-SA',
	'cc-by-nc-nd': 'CC BY-NC-ND'
};

export interface Caption {
	/** Plain text before the link, may be empty. */
	text: string;
	/** Link label, may be empty when there is nothing to link. */
	linkLabel: string;
	/** Link target, empty when the row recorded no source page. */
	linkHref: string;
}

/**
 * The caption for one cached image, or `null` when it needs none.
 *
 * Never returns an empty caption or the literal word "unknown": a reader
 * should see a real credit or nothing at all.
 */
export function captionFor(row: ImageRow): Caption | null {
	const code = row.license ?? 'unknown';
	if (code === 'pd') return null;

	const href = row.description_url ?? '';

	if (code === 'unknown') {
		// Scraped from a page. Name the site, claim nothing about the licence.
		const host = hostOf(row.source_url);
		if (!host) return null;
		return { text: '', linkLabel: host, linkHref: href || row.source_url };
	}

	const creator = (row.attribution ?? '').trim();
	const licenseLabel = licenseLabelFor(code);

	// Credit with no link target still belongs on screen — the obligation is
	// to name the creator, not to link anywhere.
	if (!href) {
		const parts = [creator, licenseLabel].filter(Boolean);
		return parts.length ? { text: parts.join(' · '), linkLabel: '', linkHref: '' } : null;
	}

	return {
		text: creator ? `${creator} · ` : '',
		linkLabel: licenseLabel,
		linkHref: href
	};
}

/** `cc-by-sa-4.0` → `CC BY-SA 4.0`. Unrecognised codes pass through as-is. */
function licenseLabelFor(code: string): string {
	const match = /^(cc-by(?:-[a-z]{2})*)(?:-(\d+\.\d+))?$/.exec(code);
	if (!match) return code;
	const label = LICENSE_LABELS[match[1]] ?? match[1].toUpperCase();
	return match[2] ? `${label} ${match[2]}` : label;
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return '';
	}
}
