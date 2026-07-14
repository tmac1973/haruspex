<script lang="ts">
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { Terminal, type IBufferCell } from '@xterm/xterm';
	import { FitAddon } from '@xterm/addon-fit';
	import { WebLinksAddon } from '@xterm/addon-web-links';
	import { SerializeAddon } from '@xterm/addon-serialize';
	import '@xterm/xterm/css/xterm.css';
	import { getSettings } from '$lib/stores/settings';
	import { isPtyBusy, ptyBusyCommand } from '$lib/stores/shellPtyBusy.svelte';
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
		/**
		 * Rasterize the visible terminal grid to a PNG data URL so the agent can
		 * "see" it with vision (e.g. to check a TUI/curses program is drawing
		 * correctly). Painted from xterm's cell buffer — the DOM renderer has no
		 * canvas to grab — so it's faithful to characters and colors. Null if the
		 * terminal isn't ready.
		 */
		snapshotImage: () => string | null;
	}

	const { onReady, onSelectionChange, attachSessionId }: Props = $props();

	let container: HTMLDivElement;
	let term: Terminal | null = null;
	let serializeAddon: SerializeAddon | null = null;
	// $state so the PTY-busy badge in the template reacts to session changes.
	let sessionId = $state<number | null>(null);
	let unlistenOutput: UnlistenFn | null = null;
	let unlistenExit: UnlistenFn | null = null;
	let resizeObserver: ResizeObserver | null = null;
	// xterm input/selection listeners are (re)wired on every attachSession;
	// hold their disposables so a restart disposes the old ones first. Without
	// this, each restart (e.g. a picker shell-switch) stacks another onData
	// handler and every keystroke gets written to the PTY N times.
	let onDataDisposable: { dispose(): void } | null = null;
	let onSelectionDisposable: { dispose(): void } | null = null;

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
				background: '#0c0b0a',
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
			// Ctrl/⌘ +/-/0 is app-level UI zoom (handled in +layout) — don't
			// also feed the chord to the PTY.
			if ((event.ctrlKey || event.metaKey) && ['+', '=', '-', '_', '0'].includes(event.key)) {
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
		// Open links through the Rust `open_url` command (system browser) rather
		// than the addon's default `window.open`, which is a no-op in the Tauri
		// WebKitGTK webview — same reason the layout routes <a> clicks through it.
		// Require Ctrl/Cmd (like konsole and VS Code's terminal) so a plain click
		// — e.g. clicking near a URL just to focus the pane — can't fire off a
		// browser by accident.
		t.loadAddon(
			new WebLinksAddon((event, uri) => {
				if (!event.ctrlKey && !event.metaKey) return;
				event.preventDefault();
				invoke('open_url', { url: uri }).catch((e) => console.error('open_url failed:', uri, e));
			})
		);
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
			serialize: () => serializeAddon?.serialize() ?? '',
			snapshotImage
		};
	}

	/** Standard xterm 256-colour palette: 0-15 from the active theme (with
	 *  fallbacks), 16-231 the 6×6×6 cube, 232-255 the grayscale ramp. */
	function buildPalette(theme: NonNullable<Terminal['options']['theme']>): string[] {
		const base = [
			theme.black ?? '#000000',
			theme.red ?? '#cd3131',
			theme.green ?? '#0dbc79',
			theme.yellow ?? '#e5e510',
			theme.blue ?? '#2472c8',
			theme.magenta ?? '#bc3fbc',
			theme.cyan ?? '#11a8cd',
			theme.white ?? '#e5e5e5',
			theme.brightBlack ?? '#666666',
			theme.brightRed ?? '#f14c4c',
			theme.brightGreen ?? '#23d18b',
			theme.brightYellow ?? '#f5f543',
			theme.brightBlue ?? '#3b8eea',
			theme.brightMagenta ?? '#d670d6',
			theme.brightCyan ?? '#29b8db',
			theme.brightWhite ?? '#ffffff'
		];
		const palette = [...base];
		const levels = [0, 95, 135, 175, 215, 255];
		for (let i = 0; i < 216; i++) {
			const r = levels[Math.floor(i / 36) % 6];
			const g = levels[Math.floor(i / 6) % 6];
			const b = levels[i % 6];
			palette.push(`rgb(${r},${g},${b})`);
		}
		for (let i = 0; i < 24; i++) {
			const v = 8 + i * 10;
			palette.push(`rgb(${v},${v},${v})`);
		}
		return palette;
	}

	const rgbHex = (n: number) => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;

	function snapshotImage(): string | null {
		if (!term) return null;
		const cols = term.cols;
		const rows = term.rows;
		const buf = term.buffer.active;
		const theme = term.options.theme ?? {};
		const defaultFg = theme.foreground ?? '#d4d4d4';
		const defaultBg = theme.background ?? '#1e1e1e';
		const palette = buildPalette(theme);
		const fontSize = term.options.fontSize ?? 13;
		const fontFamily = term.options.fontFamily ?? 'monospace';
		const scale = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));

		const measure = document.createElement('canvas').getContext('2d');
		if (!measure) return null;
		measure.font = `${fontSize}px ${fontFamily}`;
		const cellW = Math.max(1, Math.ceil(measure.measureText('M').width || fontSize * 0.6));
		const cellH = Math.ceil(fontSize * 1.3);

		const canvas = document.createElement('canvas');
		canvas.width = cols * cellW * scale;
		canvas.height = rows * cellH * scale;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.scale(scale, scale);
		ctx.textBaseline = 'top';
		ctx.fillStyle = defaultBg;
		ctx.fillRect(0, 0, cols * cellW, rows * cellH);

		const fgOf = (cell: IBufferCell): string =>
			cell.isFgDefault()
				? defaultFg
				: cell.isFgRGB()
					? rgbHex(cell.getFgColor())
					: (palette[cell.getFgColor()] ?? defaultFg);
		const bgOf = (cell: IBufferCell): string =>
			cell.isBgDefault()
				? defaultBg
				: cell.isBgRGB()
					? rgbHex(cell.getBgColor())
					: (palette[cell.getBgColor()] ?? defaultBg);

		for (let row = 0; row < rows; row++) {
			const line = buf.getLine(buf.viewportY + row);
			if (!line) continue;
			for (let col = 0; col < cols; col++) {
				const cell = line.getCell(col);
				if (!cell) continue;
				const width = cell.getWidth();
				if (width === 0) continue; // second half of a wide glyph
				let fg = fgOf(cell);
				let bg = bgOf(cell);
				if (cell.isInverse()) [fg, bg] = [bg, fg];
				const x = col * cellW;
				const y = row * cellH;
				if (bg !== defaultBg) {
					ctx.fillStyle = bg;
					ctx.fillRect(x, y, cellW * width, cellH);
				}
				const chars = cell.getChars();
				if (chars && chars !== ' ') {
					ctx.fillStyle = fg;
					ctx.font = `${cell.isBold() ? 'bold ' : ''}${fontSize}px ${fontFamily}`;
					ctx.fillText(chars, x, y + (cellH - fontSize) / 2);
				}
			}
		}
		try {
			return canvas.toDataURL('image/png');
		} catch {
			return null;
		}
	}

	async function attachSession(
		t: Terminal,
		fit: FitAddon,
		newSessionId: number,
		context: SessionContext
	) {
		sessionId = newSessionId;
		[unlistenOutput, unlistenExit] = await wirePtyEvents(t, newSessionId);
		// Dispose any listeners from a prior attach (restart re-enters here) so
		// they don't accumulate — a stacked onData would write each keystroke to
		// the PTY once per past attach.
		onDataDisposable?.dispose();
		onSelectionDisposable?.dispose();
		// Closures reference the outer `sessionId` variable, not a
		// captured copy — so after restart() bumps it, keystrokes and
		// resizes flow to the new PTY.
		onDataDisposable = t.onData((data) => {
			if (sessionId == null) return;
			// NOTE: we deliberately do NOT block input while the agent is driving
			// the PTY. The agent's command is the foreground process, so the user's
			// keystrokes reach *its* stdin — which is exactly what's needed to
			// answer an interactive prompt (a sudo password, a [y/N], git creds).
			// They can't start a competing shell command (the shell isn't reading
			// input while a command runs), and output capture is marker-based, so
			// it isn't corrupted. The "agent running" badge signals the takeover.
			invoke('shell_write', { sessionId, data }).catch((e) =>
				console.error('shell_write failed', e)
			);
		});
		onSelectionDisposable = t.onSelectionChange(() => onSelectionChange?.(t.hasSelection()));
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
		const selection = getSettings().shellSelection ?? null;
		const fit = new FitAddon();
		// Reuse the existing terminal; xterm holds onto its own resize
		// addon from createTerminal. We only need a fresh observer.
		const spawn = await invoke<ShellSpawnResult>('shell_restart', {
			sessionId: oldId,
			cols: term.cols,
			rows: term.rows,
			shellOverride,
			selection
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
			const selection = getSettings().shellSelection ?? null;
			const spawn = await invoke<ShellSpawnResult>('shell_spawn', {
				cols: t.cols,
				rows: t.rows,
				shellOverride,
				selection
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

<div class="terminal-host" bind:this={container}>
	{#if isPtyBusy(sessionId)}
		<div class="agent-running-badge" title={ptyBusyCommand(sessionId) ?? ''}>
			⏳ agent running: <span class="cmd">{ptyBusyCommand(sessionId)}</span>
		</div>
	{/if}
</div>

<style>
	.terminal-host {
		position: absolute;
		inset: 0;
		/* Matches the xterm theme background above — an always-dark surface
		   in both app themes. */
		background: #0c0b0a;
		padding: 4px 0 0 4px;
	}

	.agent-running-badge {
		position: absolute;
		top: 8px;
		right: 12px;
		z-index: 5;
		display: flex;
		gap: 4px;
		align-items: center;
		max-width: 70%;
		padding: 4px 10px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--accent) 85%, black);
		color: white;
		font-size: 0.75rem;
		font-weight: 500;
		pointer-events: none;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
	}

	.agent-running-badge .cmd {
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.terminal-host :global(.xterm) {
		height: 100%;
		width: 100%;
	}

	.terminal-host :global(.xterm-viewport) {
		background-color: transparent !important;
	}
</style>
