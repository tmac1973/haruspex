import type { Action } from 'svelte/action';

/**
 * Keep a scrolling transcript pinned to its newest line while the reader is
 * at the bottom, and leave it alone once they scroll up to read. Pass what
 * grows the transcript as the parameter, so every change re-pins:
 *
 *   <div use:followBottom={[messages.length, streamingContent]}>
 */
export const followBottom: Action<HTMLElement, unknown> = (node) => {
	// Within this many pixels of the bottom counts as at the bottom.
	const SLACK = 48;
	let follow = true;
	const onScroll = () => {
		follow = node.scrollHeight - node.scrollTop - node.clientHeight < SLACK;
	};
	// After the DOM has the new content, so scrollHeight includes it.
	const pin = () => {
		if (follow) queueMicrotask(() => (node.scrollTop = node.scrollHeight));
	};
	node.addEventListener('scroll', onScroll);
	pin();
	return {
		update: pin,
		destroy: () => node.removeEventListener('scroll', onScroll)
	};
};
