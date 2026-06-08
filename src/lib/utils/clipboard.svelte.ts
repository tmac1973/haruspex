import { errMessage } from '$lib/utils/error';

/**
 * Clipboard copy with transient "copied / failed" feedback. Replaces the
 * copy-then-setTimeout-reset pattern duplicated across ChatMessage,
 * ChatView, LogViewer and SearchStep.
 *
 * Usage in a `.svelte` component:
 *   const copy = createCopyAction();
 *   <button onclick={() => copy.copy(text)}>{copy.state === 'copied' ? 'Copied!' : 'Copy'}</button>
 */
export type CopyState = 'idle' | 'copied' | 'failed';

export function createCopyAction(resetMs = 1500) {
	let state = $state<CopyState>('idle');
	return {
		get state() {
			return state;
		},
		async copy(text: string): Promise<void> {
			try {
				await navigator.clipboard.writeText(text);
				state = 'copied';
			} catch (e) {
				console.error('Failed to copy to clipboard:', errMessage(e));
				state = 'failed';
			}
			setTimeout(() => (state = 'idle'), resetMs);
		}
	};
}
