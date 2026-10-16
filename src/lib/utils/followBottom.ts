import type { Action } from 'svelte/action';

// Within this many pixels of the bottom counts as at the bottom.
const SLACK = 48;

/** Whether a scroller between `target` and `outer` takes an upward wheel itself. */
function innerScrollerTakes(target: EventTarget | null, outer: HTMLElement): boolean {
	for (let el = target as HTMLElement | null; el && el !== outer; el = el.parentElement) {
		if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight) return true;
	}
	return false;
}

/**
 * Track whether a transcript should follow its newest line: it stops the
 * moment the reader wheels up (a smooth wheel step can stay inside the slack
 * until the next streamed token pins it back down) and resumes once they
 * scroll back down to the bottom.
 */
export function trackFollow(node: HTMLElement) {
	let follow = true;
	let lastTop = node.scrollTop;
	const onScroll = () => {
		const fromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
		if (fromBottom >= SLACK) follow = false;
		else if (node.scrollTop >= lastTop) follow = true;
		lastTop = node.scrollTop;
	};
	const onWheel = (e: WheelEvent) => {
		if (e.deltaY < 0 && !innerScrollerTakes(e.target, node)) follow = false;
	};
	node.addEventListener('scroll', onScroll);
	node.addEventListener('wheel', onWheel, { passive: true });
	return {
		get following() {
			return follow;
		},
		resume() {
			follow = true;
		},
		destroy() {
			node.removeEventListener('scroll', onScroll);
			node.removeEventListener('wheel', onWheel);
		}
	};
}

/**
 * Keep a scrolling transcript pinned to its newest line while the reader is
 * at the bottom, and leave it alone once they scroll up to read. Pass what
 * grows the transcript as the parameter, so every change re-pins:
 *
 *   <div use:followBottom={[messages.length, streamingContent]}>
 */
export const followBottom: Action<HTMLElement, unknown> = (node) => {
	const tracker = trackFollow(node);
	// After the DOM has the new content, so scrollHeight includes it.
	const pin = () => {
		if (tracker.following) queueMicrotask(() => (node.scrollTop = node.scrollHeight));
	};
	pin();
	return {
		update: pin,
		destroy: tracker.destroy
	};
};
