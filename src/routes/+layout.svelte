<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import ServerStatusBadge from '$lib/components/ServerStatusBadge.svelte';
	import ContextIndicator from '$lib/components/ContextIndicator.svelte';
	import FileConflictModal from '$lib/components/FileConflictModal.svelte';
	import SandboxApprovalModal from '$lib/components/SandboxApprovalModal.svelte';
	import LogViewer from '$lib/components/LogViewer.svelte';
	import HelpModal from '$lib/components/HelpModal.svelte';
	import SettingsPanel from '$lib/components/settings/SettingsPanel.svelte';
	import StartupNoticeDialog from '$lib/components/StartupNoticeDialog.svelte';
	import { initChatStore } from '$lib/stores/chat.svelte';
	import { recoverOrphanRuns } from '$lib/stores/jobRuns.svelte';
	import { startScheduler } from '$lib/agent/jobs/scheduler.svelte';
	import { enterRemoteMode, initServerStore, startServer } from '$lib/stores/server.svelte';
	import {
		applyTheme,
		getActiveLocalModelFilename,
		getSettings,
		setActiveLocalModel
	} from '$lib/stores/settings';
	import { checkForUpdate, type UpdateInfo } from '$lib/updates';
	import { invoke } from '@tauri-apps/api/core';
	import { getVersion } from '@tauri-apps/api/app';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { messageText, type ChatMessage } from '$lib/api';
	import { installMarkdownActions } from '$lib/markdown-actions';
	import {
		isVoiceCaptureActive,
		startVoiceCapture,
		stopAndTranscribe
	} from '$lib/audio/voiceCapture.svelte';
	import { toggleTts } from '$lib/audio/ttsControl.svelte';
	import { getActiveTab } from '$lib/stores/activeTab.svelte';
	import { getActiveConversation, sendMessage } from '$lib/stores/chat.svelte';
	import { getActiveShellSession } from '$lib/stores/shell.svelte';

	let { children } = $props();
	let showLogs = $state(false);
	let showHelp = $state(false);
	// Settings renders as an in-page overlay rather than a route navigation, so
	// the Shell tab's PTY (and scrollback) survives opening/closing settings.
	let showSettings = $state(false);
	let showStartupNotice = $state(false);
	let version = $state('');
	let update = $state<UpdateInfo | null>(null);

	// A detached shell window loads this same root layout. It must NOT re-run
	// app bootstrap (sidecars, job scheduler, setup redirect) or render the
	// main chrome — it shows only its shell pane (routes/shell/[id]).
	const detached = $derived(page.route.id === '/shell/[id]');

	// Delegated handler for the copy/paste/run buttons inside rendered
	// markdown (sanitization strips inline onclick). Installed in every
	// window — the detached shell window renders markdown too.
	onMount(() => installMarkdownActions());

	onMount(async () => {
		applyTheme();
		if (page.route.id === '/shell/[id]') return;
		initServerStore();
		initChatStore();
		// Sweep any job runs left at 'queued' / 'running' by a previous
		// session (hard close, crash). Fire-and-forget — the JobsTab loads
		// run history on demand and will pick up the recovered statuses.
		// Start the job scheduler ticker after recovery has had a chance
		// to clean up — we don't want the scheduler enqueuing while the
		// runner thinks the DB has a stale 'running' row.
		void recoverOrphanRuns().then(() => startScheduler());

		try {
			version = await getVersion();
			await getCurrentWindow().setTitle(`Haruspex ${version}`);
		} catch {
			// Tauri commands not available (e.g., in browser dev mode)
		}

		if (version) {
			checkForUpdate(version).then((info) => {
				update = info;
			});
		}

		// Intercept clicks on external links and open in the system browser
		// rather than letting the webview navigate to them (which would replace
		// the Haruspex UI). Routed through our own `open_url` command rather
		// than tauri-plugin-shell so the spawn happens in Rust where we can
		// strip AppImage-bundled paths out of LD_LIBRARY_PATH for the child
		// — without that, AppImage builds inherited the bundled lib path
		// into the spawned browser and links did nothing.
		document.addEventListener('click', (e) => {
			const anchor = (e.target as HTMLElement).closest('a');
			if (!anchor) return;
			const href = anchor.getAttribute('href');
			if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
				e.preventDefault();
				invoke('open_url', { url: href }).catch((err) =>
					console.error('open_url failed:', href, err)
				);
			}
		});

		// Suppress the webview's right-click context menu on links. WebKitGTK's
		// default "Open Link" item navigates the current frame, which replaces
		// the Haruspex UI with the linked page. Killing the menu on anchors
		// removes the footgun; non-link right-clicks still get the default menu.
		document.addEventListener('contextmenu', (e) => {
			const anchor = (e.target as HTMLElement).closest('a');
			if (anchor) e.preventDefault();
		});

		// First-run detection + initial backend setup. Three paths:
		//   1. Remote-inference mode active → skip the local sidecar
		//      entirely, show a "remote" status label in the UI, and
		//      skip the setup-redirect too (the user already has a
		//      working backend, no model download needed).
		//   2. Local mode + model present → normal startup: spawn the
		//      llama-server sidecar with the configured context size.
		//   3. Local mode + no model → first-run setup wizard.
		try {
			const backend = getSettings().inferenceBackend;
			if (backend.mode === 'remote' && backend.remoteBaseUrl) {
				enterRemoteMode(backend.remoteBaseUrl, backend.remoteModelId);
				// TTS is still local (not affected by the inference backend).
				invoke('tts_initialize').catch((e) => console.warn('TTS init failed:', e));
			} else {
				const hasModel = await invoke<boolean>('has_any_model');
				if (!hasModel && !page.url.pathname.startsWith('/setup')) {
					goto('/setup');
				} else if (hasModel && !page.url.pathname.startsWith('/setup')) {
					// Auto-start server with available model. Prefer the
					// model the user last activated (persisted in settings);
					// the Rust side falls back to find_any_model when the
					// preference is empty or no longer on disk.
					const modelPath = await invoke<string | null>('get_active_model_path', {
						preferredFilename: getActiveLocalModelFilename() || null
					});
					if (modelPath) {
						setActiveLocalModel(modelPath);
						startServer(modelPath, getSettings().contextSize);
					}
					// Eagerly start TTS in the background (non-blocking)
					invoke('tts_initialize').catch((e) => console.warn('TTS init failed:', e));
				}
			}
		} catch {
			// Tauri commands not available (e.g., in browser dev mode)
		}

		if (!getSettings().dismissedStartupNotice) {
			showStartupNotice = true;
		}
	});

	// ---- Global media hotkeys (F2 push-to-talk, F3 read-aloud) ----
	// Registered at the layout level so they fire regardless of which
	// child element has focus. Restricted to the main page (no PTT
	// while editing settings).

	function isMainPage(): boolean {
		// Pages where the F2/F3 media hotkeys (push-to-talk, read-aloud) apply:
		// the main window's root route and a detached shell window. Packaged
		// builds load the webview from `tauri://localhost`, where
		// `page.url.pathname` is '' (empty) rather than '/'; matching on the
		// SvelteKit route id is stable across dev and packaged builds.
		return page.route.id === '/' || page.route.id === '/shell/[id]';
	}

	function pickTranscriptionTarget(text: string) {
		const tab = getActiveTab();
		if (tab === 'shell') {
			void getActiveShellSession()?.submitChatMessage(text);
		} else if (tab === 'chat') {
			sendMessage(text);
		}
		// 'jobs' has no chat input — silently drop.
	}

	function getLastAssistantText(): string {
		const tab = getActiveTab();
		const messages =
			tab === 'shell'
				? (getActiveShellSession()?.messages ?? [])
				: (getActiveConversation()?.messages ?? []);
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i] as ChatMessage;
			if (m.role === 'assistant') {
				const text = messageText(m.content).trim();
				if (text) return text;
			}
		}
		return '';
	}

	function hasNoModifiers(event: KeyboardEvent): boolean {
		return !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
	}

	// F2: push-to-talk. On the Shell tab, open the assistant sidebar the
	// moment recording starts so the user sees they're aiming at the
	// assistant — without this the panel only opens once the transcription
	// pipeline completes a couple seconds later.
	function handleVoiceCaptureKey(event: KeyboardEvent) {
		event.preventDefault();
		if (event.repeat) return;
		if (getActiveTab() === 'shell') getActiveShellSession()?.setSidebarOpen(true);
		if (!isVoiceCaptureActive()) startVoiceCapture();
	}

	// F3: read the last assistant message aloud.
	function handleReadAloudKey(event: KeyboardEvent) {
		event.preventDefault();
		if (event.repeat) return;
		const text = getLastAssistantText();
		if (text) toggleTts(text);
	}

	// F4 (Shell tab only): dump the last N captured commands + output to the
	// assistant with no prompt. Open the sidebar so the user sees it land.
	function handleDumpCommandsKey(event: KeyboardEvent) {
		event.preventDefault();
		if (event.repeat) return;
		if (getActiveTab() !== 'shell') return;
		const session = getActiveShellSession();
		if (!session) return;
		session.setSidebarOpen(true);
		void session.submitRecentCommands();
	}

	function onGlobalKeydown(event: KeyboardEvent) {
		// F1 toggles the shortcuts help — available on every page (incl.
		// settings), so it's handled before the main-page guard below.
		if (event.key === 'F1' && hasNoModifiers(event)) {
			event.preventDefault();
			if (!event.repeat) showHelp = !showHelp;
			return;
		}
		// Settings opens as an overlay on the main route, so isMainPage() is
		// still true while it's up — suppress push-to-talk / read-aloud there.
		if (!isMainPage() || showSettings) return;
		if (!hasNoModifiers(event)) return;
		if (event.key === 'F2') handleVoiceCaptureKey(event);
		else if (event.key === 'F3') handleReadAloudKey(event);
		else if (event.key === 'F4') handleDumpCommandsKey(event);
	}

	async function onGlobalKeyup(event: KeyboardEvent) {
		if (!isMainPage() || showSettings) return;
		if (event.key === 'F2') {
			event.preventDefault();
			const text = await stopAndTranscribe();
			if (text) pickTranscriptionTarget(text);
		}
	}
</script>

<svelte:window onkeydown={onGlobalKeydown} onkeyup={onGlobalKeyup} />

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{#if detached}
	{@render children()}
{:else}
	<header>
		<h1>
			Haruspex{#if version}<span class="version">{version}</span>{/if}
			{#if update}
				<a
					class="update-link"
					href={update.url}
					title="Version {update.version} is available on GitHub"
				>
					New version available
				</a>
			{/if}
		</h1>
		<div class="header-right">
			<ServerStatusBadge />
			<ContextIndicator />
			<button class="header-icon-btn" title="Sidecar Logs" onclick={() => (showLogs = !showLogs)}>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<polyline points="4 17 10 11 4 5"></polyline>
					<line x1="12" y1="19" x2="20" y2="19"></line>
				</svg>
			</button>
			<button
				class="header-icon-btn"
				title="Keyboard shortcuts (F1)"
				onclick={() => (showHelp = !showHelp)}
			>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<circle cx="12" cy="12" r="10"></circle>
					<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
					<line x1="12" y1="17" x2="12.01" y2="17"></line>
				</svg>
			</button>
			<button
				class="header-icon-btn"
				title={showSettings ? 'Close Settings' : 'Settings'}
				aria-pressed={showSettings}
				onclick={() => (showSettings = !showSettings)}
			>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<circle cx="12" cy="12" r="3"></circle>
					<path
						d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
					></path>
				</svg>
			</button>
		</div>
	</header>

	<main>
		{@render children()}
		{#if showSettings}
			<div class="settings-overlay">
				<SettingsPanel onclose={() => (showSettings = false)} />
			</div>
		{/if}
	</main>

	<LogViewer open={showLogs} onclose={() => (showLogs = false)} />
	<HelpModal open={showHelp} onclose={() => (showHelp = false)} />

	{#if showStartupNotice}
		<StartupNoticeDialog onclose={() => (showStartupNotice = false)} />
	{/if}

	<FileConflictModal />
	<SandboxApprovalModal />
{/if}

<style>
	:global(:root) {
		--bg-primary: #ffffff;
		--bg-secondary: #f9fafb;
		--bg-chat: #ffffff;
		--text-primary: #1a1a1a;
		--text-secondary: #6b7280;
		--accent: #3b82f6;
		--border: #e5e7eb;
		--code-bg: #1e1e1e;
		--user-bubble: #eff6ff;
		--error-bg: #fef2f2;
		--error-text: #dc2626;
		--error-border: #fecaca;
		--success: #16a34a;
	}

	@media (prefers-color-scheme: dark) {
		:global(:root:not([data-theme='light'])) {
			--bg-primary: #111111;
			--bg-secondary: #1a1a1a;
			--bg-chat: #111111;
			--text-primary: #e5e5e5;
			--text-secondary: #9ca3af;
			--accent: #60a5fa;
			--border: #2e2e2e;
			--code-bg: #0d0d0d;
			--user-bubble: #1e293b;
			--error-bg: #1c1111;
			--error-text: #f87171;
			--error-border: #3b1111;
			--success: #16a34a;
		}
	}

	:global(:root[data-theme='dark']) {
		--bg-primary: #111111;
		--bg-secondary: #1a1a1a;
		--bg-chat: #111111;
		--text-primary: #e5e5e5;
		--text-secondary: #9ca3af;
		--accent: #60a5fa;
		--border: #2e2e2e;
		--code-bg: #0d0d0d;
		--user-bubble: #1e293b;
		--error-bg: #1c1111;
		--error-text: #f87171;
		--error-border: #3b1111;
		--success: #16a34a;
	}

	:global(html),
	:global(body) {
		height: 100%;
		overflow: hidden;
		margin: 0;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		background: var(--bg-primary);
		color: var(--text-primary);
	}

	/* Settings-section scaffolding — add `class="settings-section"` to a
	   <section> in any settings panel for the shared divider + heading
	   chrome. Only one section panel mounts at a time, so :last-child
	   correctly drops the trailing divider per panel. */
	:global(.settings-section) {
		padding-bottom: 24px;
		margin-bottom: 24px;
		border-bottom: 1px solid var(--border);
	}
	:global(.settings-section:last-child) {
		border-bottom: none;
		margin-bottom: 0;
		padding-bottom: 0;
	}
	:global(.settings-section h2) {
		font-size: 1rem;
		margin: 0 0 8px 0;
		color: var(--text-primary);
	}

	/* Thin custom scrollbar — add `class="thin-scroll"` to any scroll
	   container. Shared by the conversation list, job-run history, etc. */
	:global(.thin-scroll::-webkit-scrollbar) {
		width: 10px;
	}
	:global(.thin-scroll::-webkit-scrollbar-track) {
		background: transparent;
	}
	:global(.thin-scroll::-webkit-scrollbar-thumb) {
		background: var(--border);
		border-radius: 5px;
	}
	:global(.thin-scroll::-webkit-scrollbar-thumb:hover) {
		background: var(--text-secondary);
	}

	/* Status pill — a colored capsule for run / step state. Add
	   `class="status-pill status-{state}"` (state ∈ running, succeeded,
	   failed, cancelled, interrupted; anything else gets the neutral base).
	   Shared by the job-run views. */
	:global(.status-pill) {
		font-size: 0.7rem;
		padding: 2px 8px;
		border-radius: 999px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		border: 1px solid var(--border);
		color: var(--text-secondary);
	}
	:global(.status-pill.status-running) {
		background: color-mix(in srgb, var(--accent) 15%, transparent);
		border-color: var(--accent);
		color: var(--accent);
	}
	:global(.status-pill.status-succeeded) {
		background: color-mix(in srgb, var(--success) 15%, transparent);
		border-color: var(--success);
		color: var(--success);
	}
	:global(.status-pill.status-failed),
	:global(.status-pill.status-cancelled),
	:global(.status-pill.status-interrupted) {
		background: var(--error-bg);
		border-color: var(--error-border);
		color: var(--error-text);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 16px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-primary);
	}

	header h1 {
		font-size: 1.1rem;
		margin: 0;
		font-weight: 600;
	}

	.version {
		margin-left: 0.4em;
		font-size: 0.8rem;
		font-weight: 400;
		color: var(--text-secondary);
	}

	.update-link {
		margin-left: 0.6em;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--accent);
		text-decoration: none;
		padding: 2px 8px;
		border: 1px solid var(--accent);
		border-radius: 10px;
		cursor: pointer;
	}

	.update-link:hover {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.header-icon-btn {
		background: none;
		border: none;
		color: var(--text-secondary);
		display: flex;
		align-items: center;
		padding: 4px;
		border-radius: 4px;
		cursor: pointer;
		transition: color 0.15s;
	}

	.header-icon-btn:hover {
		color: var(--text-primary);
	}

	main {
		flex: 1;
		overflow: hidden;
		position: relative;
	}

	/* Settings overlay covers the main content area (the Shell tab stays
	   mounted underneath so its PTY survives). Anchored to <main> via
	   position: relative above; sits below the header. */
	.settings-overlay {
		position: absolute;
		inset: 0;
		z-index: 20;
		overflow-y: auto;
		background: var(--bg-primary);
	}

	/* Right-side controls (chips + Paste + Copy) inside the rendered
	   markdown code-block header. The header itself is flex with
	   space-between (set in ChatMessage.svelte), so this container
	   collects everything on the right. */
	:global(.code-actions) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	/* A multi-command shell suggestion renders as a stack of individual
	   code-blocks (one per command, each with its own Run button) wrapped
	   in .cmd-list. Tighten the spacing so the group still reads as one
	   suggestion rather than several unrelated blocks. */
	:global(.cmd-list) {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	:global(.cmd-list .code-block) {
		margin: 0;
	}

	:global(.risky-chip) {
		display: inline-flex;
		align-items: center;
		padding: 1px 6px;
		border-radius: 999px;
		font-size: 0.66rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #c44;
		border: 1px solid #c44;
		background: color-mix(in srgb, #c44 12%, transparent);
	}

	:global(.code-block .paste-btn),
	:global(.code-block .run-btn) {
		background: none;
		border: 1px solid var(--accent);
		color: var(--accent);
		border-radius: 4px;
		padding: 2px 8px;
		font-size: 0.7rem;
		cursor: pointer;
	}

	:global(.code-block .paste-btn:hover),
	:global(.code-block .run-btn:hover) {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
	}

	:global(.code-block .run-btn) {
		background: var(--accent);
		color: white;
	}

	:global(.code-block .run-btn:hover) {
		background: color-mix(in srgb, var(--accent) 80%, black);
	}

	/* Paste-into-shell and Run-in-shell are meaningless outside the
	   Shell tab. Hide them so a stray bash code block in chat or jobs
	   doesn't promise something it can't deliver. ShellTab toggles
	   the body class. Scoped to .code-block so this only ever targets
	   the markdown shell buttons — not any other component that happens
	   to reuse a .run-btn class (e.g. the Jobs list run arrow). */
	:global(body:not(.shell-tab-active) .code-block .paste-btn),
	:global(body:not(.shell-tab-active) .code-block .run-btn) {
		display: none;
	}

	/* Minimal highlight.js theme — applies to both the chat-message
	   markdown code blocks and the new sandbox tool-step code preview.
	   Inherits the surrounding text color for unmatched tokens, so it
	   degrades cleanly on either light or dark theme. */
	:global(.hljs-comment),
	:global(.hljs-quote) {
		color: #6a737d;
		font-style: italic;
	}
	:global(.hljs-keyword),
	:global(.hljs-selector-tag),
	:global(.hljs-literal),
	:global(.hljs-built_in) {
		color: #d73a49;
	}
	:global(.hljs-string),
	:global(.hljs-meta-string),
	:global(.hljs-doctag) {
		color: #032f62;
	}
	:global(.hljs-number),
	:global(.hljs-symbol),
	:global(.hljs-bullet) {
		color: #005cc5;
	}
	:global(.hljs-function),
	:global(.hljs-title),
	:global(.hljs-section) {
		color: #6f42c1;
	}
	:global(.hljs-name),
	:global(.hljs-attribute),
	:global(.hljs-attr) {
		color: #22863a;
	}
	:global(.hljs-variable),
	:global(.hljs-template-variable),
	:global(.hljs-type),
	:global(.hljs-class .hljs-title) {
		color: #e36209;
	}
	:global(.hljs-meta) {
		color: #6a737d;
	}

	@media (prefers-color-scheme: dark) {
		:global(:root:not([data-theme='light']) .hljs-comment),
		:global(:root:not([data-theme='light']) .hljs-quote) {
			color: #8b949e;
		}
		:global(:root:not([data-theme='light']) .hljs-keyword),
		:global(:root:not([data-theme='light']) .hljs-selector-tag),
		:global(:root:not([data-theme='light']) .hljs-literal),
		:global(:root:not([data-theme='light']) .hljs-built_in) {
			color: #ff7b72;
		}
		:global(:root:not([data-theme='light']) .hljs-string),
		:global(:root:not([data-theme='light']) .hljs-meta-string),
		:global(:root:not([data-theme='light']) .hljs-doctag) {
			color: #a5d6ff;
		}
		:global(:root:not([data-theme='light']) .hljs-number),
		:global(:root:not([data-theme='light']) .hljs-symbol),
		:global(:root:not([data-theme='light']) .hljs-bullet) {
			color: #79c0ff;
		}
		:global(:root:not([data-theme='light']) .hljs-function),
		:global(:root:not([data-theme='light']) .hljs-title),
		:global(:root:not([data-theme='light']) .hljs-section) {
			color: #d2a8ff;
		}
		:global(:root:not([data-theme='light']) .hljs-name),
		:global(:root:not([data-theme='light']) .hljs-attribute),
		:global(:root:not([data-theme='light']) .hljs-attr) {
			color: #7ee787;
		}
		:global(:root:not([data-theme='light']) .hljs-variable),
		:global(:root:not([data-theme='light']) .hljs-template-variable),
		:global(:root:not([data-theme='light']) .hljs-type),
		:global(:root:not([data-theme='light']) .hljs-class .hljs-title) {
			color: #ffa657;
		}
	}

	:global(:root[data-theme='dark'] .hljs-comment),
	:global(:root[data-theme='dark'] .hljs-quote) {
		color: #8b949e;
	}
	:global(:root[data-theme='dark'] .hljs-keyword),
	:global(:root[data-theme='dark'] .hljs-selector-tag),
	:global(:root[data-theme='dark'] .hljs-literal),
	:global(:root[data-theme='dark'] .hljs-built_in) {
		color: #ff7b72;
	}
	:global(:root[data-theme='dark'] .hljs-string),
	:global(:root[data-theme='dark'] .hljs-meta-string),
	:global(:root[data-theme='dark'] .hljs-doctag) {
		color: #a5d6ff;
	}
	:global(:root[data-theme='dark'] .hljs-number),
	:global(:root[data-theme='dark'] .hljs-symbol),
	:global(:root[data-theme='dark'] .hljs-bullet) {
		color: #79c0ff;
	}
	:global(:root[data-theme='dark'] .hljs-function),
	:global(:root[data-theme='dark'] .hljs-title),
	:global(:root[data-theme='dark'] .hljs-section) {
		color: #d2a8ff;
	}
	:global(:root[data-theme='dark'] .hljs-name),
	:global(:root[data-theme='dark'] .hljs-attribute),
	:global(:root[data-theme='dark'] .hljs-attr) {
		color: #7ee787;
	}
	:global(:root[data-theme='dark'] .hljs-variable),
	:global(:root[data-theme='dark'] .hljs-template-variable),
	:global(:root[data-theme='dark'] .hljs-type),
	:global(:root[data-theme='dark'] .hljs-class .hljs-title) {
		color: #ffa657;
	}
</style>
