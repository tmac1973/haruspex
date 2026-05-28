<script lang="ts">
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { Terminal } from '@xterm/xterm';
	import { FitAddon } from '@xterm/addon-fit';
	import { WebLinksAddon } from '@xterm/addon-web-links';
	import '@xterm/xterm/css/xterm.css';
	import { getSettings } from '$lib/stores/settings';

	interface SessionContext {
		os: string;
		kernel: string;
		distroId?: string;
		distroName?: string;
		distroVersion?: string;
		shellPath: string;
		shellName: string;
		shellVersion?: string;
		home?: string;
		hostname?: string;
	}

	interface SpawnResult {
		session_id: number;
		context: SessionContext;
	}

	interface Props {
		onReady?: (handle: TerminalHandle) => void;
		onSelectionChange?: (hasSelection: boolean) => void;
	}

	export interface TerminalHandle {
		sessionId: number;
		context: SessionContext;
		getSelection: () => string;
		focus: () => void;
	}

	const { onReady, onSelectionChange }: Props = $props();

	let container: HTMLDivElement;
	let term: Terminal | null = null;
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
		const fit = new FitAddon();
		t.loadAddon(fit);
		t.loadAddon(new WebLinksAddon());
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
			fit.fit();
			invoke('shell_resize', { sessionId: id, cols: t.cols, rows: t.rows }).catch((e) =>
				console.error('shell_resize failed', e)
			);
		});
		ro.observe(el);
		return ro;
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

			const shellOverride = getSettings().shellBinary.trim() || null;
			const spawn = await invoke<SpawnResult>('shell_spawn', {
				cols: t.cols,
				rows: t.rows,
				shellOverride
			});
			sessionId = spawn.session_id;

			if (cancelled) {
				await invoke('shell_kill', { sessionId }).catch(() => {});
				t.dispose();
				term = null;
				return;
			}

			[unlistenOutput, unlistenExit] = await wirePtyEvents(t, spawn.session_id);

			t.onData((data) =>
				invoke('shell_write', { sessionId: spawn.session_id, data }).catch((e) =>
					console.error('shell_write failed', e)
				)
			);
			t.onSelectionChange(() => onSelectionChange?.(t.hasSelection()));

			resizeObserver = observeResize(t, fit, spawn.session_id, container);
			t.focus();

			onReady?.({
				sessionId: spawn.session_id,
				context: spawn.context,
				getSelection: () => term?.getSelection() ?? '',
				focus: () => term?.focus()
			});
		})().catch((e) => console.error('terminal init failed', e));

		return () => {
			cancelled = true;
			resizeObserver?.disconnect();
			unlistenOutput?.();
			unlistenExit?.();
			if (sessionId != null) {
				invoke('shell_kill', { sessionId }).catch(() => {});
			}
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
