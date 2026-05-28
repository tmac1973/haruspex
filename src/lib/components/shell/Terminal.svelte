<script lang="ts">
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { Terminal } from '@xterm/xterm';
	import { FitAddon } from '@xterm/addon-fit';
	import { WebLinksAddon } from '@xterm/addon-web-links';
	import '@xterm/xterm/css/xterm.css';

	let container: HTMLDivElement;
	let term: Terminal | null = null;
	let fitAddon: FitAddon | null = null;
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

	onMount(() => {
		let cancelled = false;

		(async () => {
			term = new Terminal({
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
			fitAddon = new FitAddon();
			term.loadAddon(fitAddon);
			term.loadAddon(new WebLinksAddon());
			term.open(container);
			fitAddon.fit();

			if (cancelled) {
				term.dispose();
				term = null;
				return;
			}

			sessionId = await invoke<number>('shell_spawn', {
				cols: term.cols,
				rows: term.rows
			});

			if (cancelled) {
				await invoke('shell_kill', { sessionId }).catch(() => {});
				term.dispose();
				term = null;
				return;
			}

			unlistenOutput = await listen<OutputEvent>('shell://output', (event) => {
				if (event.payload.session_id !== sessionId || !term) return;
				term.write(base64ToBytes(event.payload.base64));
			});

			unlistenExit = await listen<ExitEvent>('shell://exit', (event) => {
				if (event.payload.session_id !== sessionId || !term) return;
				term.write('\r\n\x1b[33m[shell exited]\x1b[0m\r\n');
			});

			term.onData((data) => {
				if (sessionId == null) return;
				invoke('shell_write', { sessionId, data }).catch((e) =>
					console.error('shell_write failed', e)
				);
			});

			resizeObserver = new ResizeObserver(() => {
				if (!term || !fitAddon || sessionId == null) return;
				fitAddon.fit();
				invoke('shell_resize', {
					sessionId,
					cols: term.cols,
					rows: term.rows
				}).catch((e) => console.error('shell_resize failed', e));
			});
			resizeObserver.observe(container);

			term.focus();
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
