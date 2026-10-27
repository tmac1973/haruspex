/**
 * Players in answers. Markdown is HTML, so a song in an answer is a
 * placeholder (`audio/figure.ts`: a `.chat-audio` element with the song's
 * hash and title, or `.chat-video` for a generated clip), and this mounts an
 * `AudioPlayer` (or a `VideoPlayer`) into each one, in the
 * desktop and the web client alike. One observer for the document: answers
 * re-render while a reply streams, and a player whose placeholder goes is
 * unmounted with it.
 */

import { mount, unmount } from 'svelte';
import AudioPlayer from '#lib/components/AudioPlayer.svelte';
import VideoPlayer from '#lib/components/VideoPlayer.svelte';
import { LOCAL_AUDIO_URL } from '#lib/audio/url.ts';
import { LOCAL_VIDEO_URL } from '#lib/videogen/url.ts';

const SELECTOR = '.chat-audio[data-audio-hash], .chat-video[data-video-hash]';
const players = new WeakMap<Element, ReturnType<typeof mount>>();

function attach(host: HTMLElement): void {
	if (host.dataset.videoHash !== undefined) return attachVideo(host);
	const hash = host.dataset.audioHash ?? '';
	if (players.has(host) || !LOCAL_AUDIO_URL.test(`haruspex-audio://localhost/${hash}`)) return;
	players.set(
		host,
		mount(AudioPlayer, {
			target: host,
			props: { src: `haruspex-audio://localhost/${hash}`, title: host.dataset.audioTitle ?? '' }
		})
	);
}

function attachVideo(host: HTMLElement): void {
	const src = `haruspex-video://localhost/${host.dataset.videoHash ?? ''}`;
	if (players.has(host) || !LOCAL_VIDEO_URL.test(src)) return;
	players.set(
		host,
		mount(VideoPlayer, { target: host, props: { src, title: host.dataset.videoTitle ?? '' } })
	);
}

function detach(host: Element): void {
	const player = players.get(host);
	if (!player) return;
	players.delete(host);
	void unmount(player);
}

/** Every placeholder at or under `node`. */
function hosts(node: Node): HTMLElement[] {
	if (!(node instanceof HTMLElement)) return [];
	const found = [...node.querySelectorAll<HTMLElement>(SELECTOR)];
	return node.matches(SELECTOR) ? [node, ...found] : found;
}

export function installAudioPlayers(doc: Document): () => void {
	doc.querySelectorAll<HTMLElement>(SELECTOR).forEach(attach);
	const observer = new MutationObserver((records) => {
		for (const r of records) {
			r.removedNodes.forEach((n) => hosts(n).forEach(detach));
			r.addedNodes.forEach((n) => hosts(n).forEach(attach));
		}
	});
	observer.observe(doc.body, { childList: true, subtree: true });
	return () => observer.disconnect();
}
