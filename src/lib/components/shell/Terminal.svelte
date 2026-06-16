<script lang="ts">
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { Terminal } from '@xterm/xterm';
	import { FitAddon } from '@xterm/addon-fit';
	import { WebLinksAddon } from '@xterm/addon-web-links';
	import { SerializeAddon } from '@xterm/addon-serialize';
	import '@xterm/xterm/css/xterm.css';
	import { getSettings } from '$lib/stores/settings';
	import type { SessionContext } from '$lib/ipc/gen/SessionContext';
	import type { ShellContextResponse } from '$lib/ipc/gen/ShellContextResponse';
	import type { ShellSpawnResult } from '$lib/ipc/gen/ShellSpawnResult';

	interface Props {
		onReady?: (handle: TerminalHandle) => void;
		onSelectionChange?: (hasSelection: boolean) => void;
		// When set, attach to this existing PTY (detach/re-attach) instead of
		// spawning a new one: fetch its context, replay scrollback, go live.
		attachSessionId?: number;
	}

	export interface TerminalHandle {
		sessionId: number;
		context: SessionContext;
		getSelection: () => string;
		focus: () => void;
		/**
		 * Paste text into the terminal via xterm, which wraps it in
		 * bracketed-paste guards when the foreground app has enabled that mode
		 * (just like a native terminal paste) and routes it through onData to
		 * the PTY.
		 */
		paste: (data: string) => void;
		restart: () => Promise<void>;
		/** Serialized grid snapshot (for clean cross-window scrollback handoff). */
		serialize: () => string;
	}

	const { onReady, onSelectionChange, attachSessionId }: Props = $props();

	let container: HTMLDivElement;
	let term: Terminal | null = null;
	let serializeAddon: SerializeAddon | null = null;
	let sessionId: number | null = null;
	let unlistenOutput: UnlistenFn | null = null;
	let unlistenExit: UnlistenFn | null = null;
	let resizeObserver: ResizeObserver | null = null;

	interface OutputEvent {
		session_id: number;
		base64: string;
	}
	interface ExitEvent {
		session_id: number;
	}

	function base64ToBytes(b64: string): Uint8Array {
		const bin = atob(b64);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}

	function createTerminal(): { t: Terminal; fit: FitAddon } {
		const t = new Terminal({
			fontFamily: 'ui-monospace, Menlo, Monaco, "Cascadia Mono", "Courier New", monospace',
			fontSize: 13,
			cursorBlink: true,
			scrollback: 5000,
			theme: {
				background: '#1e1e1e',
				foreground: '#d4d4d4',
				cursor: '#ffffff',
				selectionBackground: '#264f78'
			}
		});
		// Reserve F1/F2/F3/F4 for app-level handlers (shortcuts help,
		// push-to-talk, read-aloud, submit recent commands). Also release
		// Ctrl+Shift+C / V (copy / paste) and Ctrl+Shift+A (toggle assistant
		// sidebar) so the app can handle them — xterm would otherwise consume
		// them. Plain Ctrl+C and Ctrl+V still reach the PTY (SIGINT and literal
		// Ctrl+V).
		t.attachCustomKeyEventHandler((event) => {
			if (event.key === 'F1' || event.key === 'F2' || event.key === 'F3' || event.key === 'F4') {
				return false;
			}
			if (
				event.type === 'keydown' &&
				event.ctrlKey &&
				event.shiftKey &&
				['C', 'c', 'V', 'v', 'A', 'a'].includes(event.key)
			) {
				return false;
			}
			return true;
		});
		const fit = new FitAddon();
		t.loadAddon(fit);
		t.loadAddon(new WebLinksAddon());
		serializeAddon = new SerializeAddon();
		t.loadAddon(serializeAddon);
		return { t, fit };
	}

	async function wirePtyEvents(t: Terminal, id: number) {
		const off1 = await listen<OutputEvent>('shell://output', (event) => {
			if (event.payload.session_id !== id) return;
			t.write(base64ToBytes(event.payload.base64));
		});
		const off2 = await listen<ExitEvent>('shell://exit', (event) => {
			if (event.payload.session_id !== id) return;
			t.write('\r\n\x1b[33m[shell exited]\x1b[0m\r\n');
		});
		return [off1, off2] as const;
	}

	function observeResize(t: Terminal, fit: FitAddon, id: number, el: HTMLElement) {
		const ro = new ResizeObserver(() => {
			// When ShellTab is hidden via display:none (user switched to
			// another tab) the host collapses to 0×0 and ResizeObserver
			// fires. Resizing the PTY to 0×0 would clobber the terminal's
			// dimensions — bail and let the next visible-state resize
			// (triggered by becoming the active tab) restore the layout.
			if (el.offsetWidth === 0 || el.offsetHeight === 0) return;
			fit.fit();
			if (t.cols === 0 || t.rows === 0) return;
			invoke('shell_resize', { sessionId: id, cols: t.cols, rows: t.rows }).catch((e) =>
				console.error('shell_resize failed', e)
			);
		});
		ro.observe(el);
		return ro;
	}

	function buildHandle(context: SessionContext): TerminalHandle {
		return {
			get sessionId() {
				return sessionId ?? -1;
			},
			context,
			getSelection: () => term?.getSelection() ?? '',
			focus: () => term?.focus(),
			paste: (data: string) => term?.paste(data),
			restart: () => restart(),
			serialize: () => serializeAddon?.serialize() ?? ''
		};
	}

	async function attachSession(
		t: Terminal,
		fit: FitAddon,
		newSessionId: number,
		context: SessionContext
	) {
		sessionId = newSessionId;
		[unlistenOutput, unlistenExit] = await wirePtyEvents(t, newSessionId);
		// Closures reference the outer `sessionId` variable, not a
		// captured copy — so after restart() bumps it, keystrokes and
		// resizes flow to the new PTY.
		t.onData((data) => {
			if (sessionId == null) return;
			invoke('shell_write', { sessionId, data }).catch((e) =>
				console.error('shell_write failed', e)
			);
		});
		t.onSelectionChange(() => onSelectionChange?.(t.hasSelection()));
		resizeObserver = observeResize(t, fit, newSessionId, container);
		t.focus();
		// Now that the output listener and the onData reply path are both
		// wired, tell the backend to flush any output buffered during the
		// spawn→attach gap. Until this fires, startup terminal queries (e.g.
		// fish's Primary Device Attributes probe) would be dropped and go
		// unanswered, stalling the shell on a compatibility check.
		await invoke('shell_mark_ready', { sessionId: newSessionId }).catch((e) =>
			console.error('shell_mark_ready failed', e)
		);
		onReady?.(buildHandle(context));
	}

	// Detach/re-attach: bind to an already-running PTY in a new webview.
	// Repaint recent scrollback BEFORE wiring the live listener so history
	// and new output don't interleave. The PTY never restarted, so cwd / env
	// / running processes are already intact — only the painted history was
	// lost with the old webview.
	async function attachExisting(t: Terminal, fit: FitAddon, id: number) {
		const ctxRes = await invoke<ShellContextResponse>('shell_get_context', { sessionId: id });
		// Prefer the serialized grid snapshot the source window stashed — it
		// repaints cleanly at any width. Fall back to the raw output ring only
		// if no snapshot is present (e.g. source terminal wasn't ready).
		try {
			const snapshot = await invoke<string | null>('shell_take_scrollback', { sessionId: id });
			if (snapshot) {
				t.write(snapshot);
			} else {
				const b64 = await invoke<string>('shell_get_scrollback', { sessionId: id });
				if (b64) t.write(base64ToBytes(b64));
			}
		} catch (e) {
			console.error('scrollback restore failed', e);
		}
		await attachSession(t, fit, id, ctxRes.context);
	}

	async function restart() {
		if (!term || sessionId == null) return;
		const oldId = sessionId;
		// Tear down listeners + observer; we'll re-attach below.
		unlistenOutput?.();
		unlistenOutput = null;
		unlistenExit?.();
		unlistenExit = null;
		resizeObserver?.disconnect();
		resizeObserver = null;
		// Clear the visible state so the user sees a fresh prompt.
		term.reset();

		const shellOverride = getSettings().shellBinary.trim() || null;
		const fit = new FitAddon();
		// Reuse the existing terminal; xterm holds onto its own resize
		// addon from createTerminal. We only need a fresh observer.
		const spawn = await invoke<ShellSpawnResult>('shell_restart', {
			sessionId: oldId,
			cols: term.cols,
			rows: term.rows,
			shellOverride
		});
		await attachSession(term, fit, spawn.session_id, spawn.context);
	}

	onMount(() => {
		let cancelled = false;

		(async () => {
			const { t, fit } = createTerminal();
			term = t;
			t.open(container);
			fit.fit();

			if (cancelled) {
				t.dispose();
				term = null;
				return;
			}

			if (attachSessionId != null) {
				// Attach to an existing PTY (detach/re-attach). Don't kill it on
				// cancel — another window may still own it.
				await attachExisting(t, fit, attachSessionId);
				return;
			}

			const shellOverride = getSettings().shellBinary.trim() || null;
			const spawn = await invoke<ShellSpawnResult>('shell_spawn', {
				cols: t.cols,
				rows: t.rows,
				shellOverride
			});

			if (cancelled) {
				await invoke('shell_kill', { sessionId: spawn.session_id }).catch(() => {});
				t.dispose();
				term = null;
				return;
			}

			await attachSession(t, fit, spawn.session_id, spawn.context);
		})().catch((e) => console.error('terminal init failed', e));

		return () => {
			// Note: the PTY is intentionally NOT killed here. Its lifecycle is
			// owned explicitly by the shell registry (closeShellSession kills;
			// app exit kills all) so a pane can unmount during detach without
			// dropping the live shell. The cancelled-spawn path above still
			// kills a PTY that was spawned but never adopted.
			cancelled = true;
			resizeObserver?.disconnect();
			unlistenOutput?.();
			unlistenExit?.();
			term?.dispose();
			term = null;
		};
	});
</script>

<div class="terminal-host" bind:this={container}></div>

<style>
	.terminal-host {
		position: absolute;
		inset: 0;
		background: #1e1e1e;
		padding: 4px 0 0 4px;
	}

	.terminal-host :global(.xterm) {
		height: 100%;
		width: 100%;
	}

	.terminal-host :global(.xterm-viewport) {
		background-color: transparent !important;
	}
</style>
