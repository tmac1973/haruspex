/**
 * Resolving a reply's images into displayable cache entries.
 *
 * Runs **after** the message commits, not before. The text is already on
 * screen and the turn is already marked done; images arrive a moment later and
 * fade in. Blocking the commit on a handful of network fetches would let one
 * slow host hold up the whole answer, and `finalizeStreamedTurn` is
 * synchronous besides.
 *
 * A URL that resolves to nothing stays absent from the map forever. That is
 * what "drop silently" means in practice — the renderer shows nothing for an
 * unknown URL, so a failed fetch, a still-in-flight fetch and an ineligible
 * URL are indistinguishable, and none of them needs an error state.
 */

import { invoke } from '@tauri-apps/api/core';
import type { SearchStep } from '$lib/agent/loop';
import type { ImageRequest } from '$lib/ipc/gen/ImageRequest';
import type { ImageRow } from '$lib/ipc/gen/ImageRow';
import { getSettings } from '$lib/stores/settings';
import { logDebug } from '$lib/debug-log';
import { SvelteMap } from 'svelte/reactivity';
import {
	eligibleImages,
	imageUrlsInText,
	rehydrationUrls,
	resolvableFromReply,
	stripCandidates
} from './eligible';

/** Ceiling per message. The prompt asks for 1–3; this makes it true. */
export const MAX_IMAGES_PER_MESSAGE = 3;

/**
 * Resolved images, keyed by the URL the model wrote. Global rather than
 * per-conversation because the renderer only ever draws the conversation on
 * screen, and content-addressed entries from another chat are still correct
 * for this one.
 *
 * A `SvelteMap` and not a `$state(new Map())`: `$state` does not make a Map's
 * contents reactive, so images would land in the map and never reach the
 * screen until some unrelated change forced a re-render.
 */
const resolved = new SvelteMap<string, ImageRow>();

/** Lookup for the renderer. */
export function getResolvedImages(): ReadonlyMap<string, ImageRow> {
	return resolved;
}

export function resolvedImage(url: string): ImageRow | undefined {
	return resolved.get(url);
}

/** Test seam. */
export function clearResolvedImages(): void {
	resolved.clear();
}

/**
 * Fetch and cache the eligible images a freshly committed reply asks for.
 *
 * Fire-and-forget: callers do not await it, and any failure is logged rather
 * than surfaced. `conversationId` is captured so a result arriving after the
 * user has switched chats can be discarded instead of populating the map for
 * a conversation that never asked.
 */
export async function resolveReplyImages(
	conversationId: string,
	replyText: string,
	steps: readonly SearchStep[],
	isStillActive: () => boolean
): Promise<void> {
	const eligible = eligibleImages(steps);
	const asked = imageUrlsInText([replyText]);
	const requests = resolvableFromReply(replyText, eligible, MAX_IMAGES_PER_MESSAGE);

	// Logged even when there is nothing to do, and deliberately so. These two
	// counts are the only way to tell apart the three ways an answer ends up
	// with no pictures — the model wrote none, the model wrote URLs no tool
	// produced, or the fetch failed — and all three look identical on screen.
	logDebug(
		'images',
		`reply: ${eligible.size} eligible, ${asked.length} requested, ${requests.length} resolvable`
	);
	if (requests.length === 0) {
		if (asked.length > 0) {
			// The model invented URLs, or copied ones from page text rather than
			// from a tool result. Worth naming: it is a prompt problem, not a
			// transport one.
			logDebug('images', `reply: none of the requested URLs were eligible: ${asked.join(', ')}`);
		}
		// Nothing embedded, but the model may still have searched for pictures.
		// Running image_search is the intent; forgetting the final markdown is
		// the failure this covers. See stripCandidates.
		await resolveStrip(conversationId, steps, isStillActive);
		return;
	}

	await runResolve(conversationId, requests, isStillActive, 'reply');
}

/**
 * Fetch the images for the fallback strip.
 *
 * These URLs come from our own `image_search` results, never from anything the
 * model wrote, so the eligibility allowlist that guards the inline path has
 * nothing to check here — there is no attacker-controlled text in this route
 * at all.
 */
async function resolveStrip(
	conversationId: string,
	steps: readonly SearchStep[],
	isStillActive: () => boolean
): Promise<void> {
	const candidates = stripCandidates(steps);
	if (candidates.length === 0) return;
	logDebug('images', `strip: ${candidates.length} candidates from image_search`);
	await runResolve(conversationId, candidates, isStillActive, 'strip');
}

/**
 * Repopulate the map for a conversation being opened.
 *
 * **Lookup only — this never fetches.** The steps that established eligibility
 * are long gone, so there is nothing left to prove a stored URL was ever
 * approved. A cached row carries that permission forward; a miss proves
 * nothing. An image the cache has evicted therefore stops rendering rather
 * than being re-fetched from a URL nothing can now vouch for.
 */
export async function rehydrateImages(
	conversationId: string,
	messageTexts: readonly string[],
	stepsByMessage: readonly (readonly SearchStep[])[],
	isStillActive: () => boolean
): Promise<void> {
	// Inline images are addressed by the URLs in the message text; strip images
	// are not in the text at all, so their URLs come back from the archived
	// steps. Both are lookups — see below.
	const urls = rehydrationUrls(messageTexts, stepsByMessage).filter((url) => !resolved.has(url));
	if (urls.length === 0) return;

	const requests: ImageRequest[] = urls.map((url) => ({
		url,
		// Ignored on the lookup path: a cache hit returns its stored
		// provenance, and a miss is not fetched, so nothing here is ever
		// used to classify an image.
		source: 'cached',
		license: null,
		license_version: null,
		attribution: null,
		description_url: null
	}));

	await runResolve(conversationId, requests, isStillActive, 'rehydrate', true);
}

/**
 * Reclaim cached bytes no conversation references any more.
 *
 * Called after a conversation is deleted. The delete cascades the
 * `conversation_images` links away, but the bytes on disk outlive that — this
 * is what actually frees them, and running it now rather than waiting for the
 * startup sweep is what makes deletion feel like deletion.
 */
export async function sweepImages(): Promise<void> {
	try {
		await invoke('image_sweep');
	} catch (e) {
		logDebug('images', `sweep failed: ${e}`);
	}
}

async function runResolve(
	conversationId: string,
	requests: ImageRequest[],
	isStillActive: () => boolean,
	reason: string,
	lookupOnly = false
): Promise<void> {
	try {
		const rows = await invoke<ImageRow[]>('image_resolve', {
			conversationId,
			requests,
			proxy: getSettings().proxy,
			lookupOnly
		});
		// The conversation changed while we were away. Dropping the results is
		// the whole point of the check — writing them would attach one chat's
		// images to whatever is on screen now.
		if (!isStillActive()) {
			logDebug('images', `${reason} resolve discarded; conversation changed`);
			return;
		}
		for (const row of rows) {
			resolved.set(row.source_url, row);
		}
		logDebug('images', `${reason} resolve: ${rows.length}/${requests.length} available`);
	} catch (e) {
		// An image that cannot be resolved is one the reply does not show.
		// There is nothing the user could do about it, so it stays in the log.
		logDebug('images', `${reason} resolve failed: ${e}`);
	}
}
