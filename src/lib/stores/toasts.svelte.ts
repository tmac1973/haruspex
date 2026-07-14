/**
 * Toast notification store. The Toasts.svelte host (mounted once in the
 * root layout) renders whatever `getToasts()` returns; everything else
 * calls `showToast` and forgets.
 *
 * Rules:
 *  - At most MAX_VISIBLE toasts on screen; overflow queues FIFO and a
 *    queued toast's auto-dismiss timer only starts once it becomes
 *    visible.
 *  - Errors linger longer than info/success by default.
 *  - Showing an identical (kind, message) while one is already visible
 *    resets that toast's timer instead of stacking a duplicate.
 */

import { SvelteMap } from 'svelte/reactivity';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
	id: number;
	kind: ToastKind;
	message: string;
	duration: number;
	actionLabel?: string;
	onAction?: () => void;
}

interface ShowToastOptions {
	kind?: ToastKind;
	duration?: number;
	actionLabel?: string;
	onAction?: () => void;
}

const MAX_VISIBLE = 4;
const DEFAULT_DURATION_MS = 5000;
const ERROR_DURATION_MS = 8000;

let visible = $state<Toast[]>([]);
const queue: Toast[] = [];
// SvelteMap only to satisfy svelte/prefer-svelte-reactivity — timers are
// pure bookkeeping and never rendered.
const timers = new SvelteMap<number, ReturnType<typeof setTimeout>>();
let nextId = 1;

function startTimer(toast: Toast): void {
	timers.set(
		toast.id,
		setTimeout(() => dismissToast(toast.id), toast.duration)
	);
}

function clearTimer(id: number): void {
	const timer = timers.get(id);
	if (timer !== undefined) {
		clearTimeout(timer);
		timers.delete(id);
	}
}

export function showToast(message: string, opts: ShowToastOptions = {}): void {
	const kind = opts.kind ?? 'info';

	const duplicate = visible.find((t) => t.kind === kind && t.message === message);
	if (duplicate) {
		clearTimer(duplicate.id);
		startTimer(duplicate);
		return;
	}

	const toast: Toast = {
		id: nextId++,
		kind,
		message,
		duration: opts.duration ?? (kind === 'error' ? ERROR_DURATION_MS : DEFAULT_DURATION_MS),
		actionLabel: opts.actionLabel,
		onAction: opts.onAction
	};

	if (visible.length < MAX_VISIBLE) {
		visible = [...visible, toast];
		startTimer(toast);
	} else {
		queue.push(toast);
	}
}

export function dismissToast(id: number): void {
	clearTimer(id);
	const remaining = visible.filter((t) => t.id !== id);
	if (remaining.length === visible.length) return;
	const promoted = queue.shift();
	if (promoted) {
		remaining.push(promoted);
		startTimer(promoted);
	}
	visible = remaining;
}

export function getToasts(): Toast[] {
	return visible;
}
