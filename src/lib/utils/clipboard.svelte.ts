import { errMessage } from '$lib/utils/error';

/**
 * Clipboard copy with transient "copied / failed" feedback. Replaces the
 * copy-then-setTimeout-reset pattern duplicated across ChatMessage,
 * ChatView, LogViewer and SearchStep.
 *
 * Usage in a `.svelte` component:
 *   const copy = createCopyAction();
 *   <button onclick={() => copy.copy(text)}>{copy.state === 'copied' ? 'Copied!' : 'Copy'}</button>
 *
 * `text` may be a thunk; throwing from it (e.g. "nothing to copy") lands in
 * the `failed` state, same as a clipboard write failure.
 */
export type CopyState = 'idle' | 'copied' | 'failed';

export function createCopyAction(resetMs = 1500) {
	let state = $state<CopyState>('idle');
	return {
		get state() {
			return state;
		},
		async copy(text: string | (() => string)): Promise<void> {
			try {
				await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
				state = 'copied';
			} catch (e) {
				console.error('Failed to copy to clipboard:', errMessage(e));
				state = 'failed';
			}
			setTimeout(() => (state = 'idle'), resetMs);
		}
	};
}

/**
 * Keyed variant of {@link createCopyAction} for lists where each row has its
 * own copy button (e.g. one per search step). `state(key)` is `idle` until
 * that key's `copy` runs.
 */
export function createKeyedCopyAction(resetMs = 1500) {
	const states = $state<Record<string, CopyState>>({});
	return {
		state(key: string): CopyState {
			return states[key] ?? 'idle';
		},
		async copy(key: string, text: string | (() => string)): Promise<void> {
			try {
				await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
				states[key] = 'copied';
			} catch (e) {
				console.error('Failed to copy to clipboard:', errMessage(e));
				states[key] = 'failed';
			}
			setTimeout(() => (states[key] = 'idle'), resetMs);
		}
	};
}
