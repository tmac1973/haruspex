<script lang="ts">
	import favicon from '#lib/assets/favicon.svg';
	import ServerStatusBadge from '#lib/components/ServerStatusBadge.svelte';
	import ContextIndicator from '#lib/components/ContextIndicator.svelte';
	import FileConflictModal from '#lib/components/FileConflictModal.svelte';
	import SandboxApprovalModal from '#lib/components/SandboxApprovalModal.svelte';
	import CommandApprovalModal from '#lib/components/CommandApprovalModal.svelte';
	import McpApprovalModal from '#lib/components/McpApprovalModal.svelte';
	import MemoryApprovalModal from '#lib/components/MemoryApprovalModal.svelte';
	import RepoTrustModal from '#lib/components/RepoTrustModal.svelte';
	import SkillApprovalModal from '#lib/components/SkillApprovalModal.svelte';
	import EmailReviewModal from '#lib/components/EmailReviewModal.svelte';
	import UserQuestionModal from '#lib/components/UserQuestionModal.svelte';
	import FileEditorModal from '#lib/components/FileEditorModal.svelte';
	import LogViewer from '#lib/components/LogViewer.svelte';
	import HelpModal from '#lib/components/HelpModal.svelte';
	import SettingsPanel from '#lib/components/settings/SettingsPanel.svelte';
	import StartupNoticeDialog from '#lib/components/StartupNoticeDialog.svelte';
	import Toasts from '#lib/components/Toasts.svelte';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import {
		isLogViewerOpen,
		openLogViewer,
		closeLogViewer,
		toggleLogViewer
	} from '#lib/stores/logViewer.svelte.ts';
	import { initChatStore } from '#lib/stores/chat.svelte.ts';
	import { migrateEmailSecrets } from '#lib/stores/emailSecrets.ts';
	import { migrateDavSecrets } from '#lib/stores/davSecrets.ts';
	import { migrateBraveApiKey } from '#lib/stores/searchSecrets.ts';
	import { comfyApiKey } from '#lib/stores/imageSecrets.ts';
	import { migrateProxyPasswords } from '#lib/stores/proxySecrets.ts';
	import { migrateMcpSecrets } from '#lib/stores/mcpSecrets.ts';
	import { apiKeysReady, migrateApiKeys, migrateJobApiKeys } from '#lib/stores/apiKeySecrets.ts';
	import { remoteToken } from '#lib/stores/remoteSecrets.ts';
	import { reclaimOwnWindowSlots } from '#lib/agent/inferenceQueue.svelte.ts';
	import { recoverOrphanRuns } from '#lib/stores/jobRuns.svelte.ts';
	import { startScheduler } from '#lib/agent/jobs/scheduler.svelte.ts';
	import { releaseStaleInhibit } from '#lib/agent/jobs/keepAwake.ts';
	import {
		enterRemoteMode,
		initServerStore,
		maybeFlushPendingRestart,
		startServer
	} from '#lib/stores/llamaServer.svelte.ts';
	import {
		applyAccent,
		applyTheme,
		applyUiScale,
		getActiveLocalModelFilename,
		getSettings,
		resetUiScale,
		setActiveLocalModel,
		stepUiScale,
		updateSettings
	} from '#lib/stores/settings.ts';
	import { checkForUpdate, type UpdateInfo } from '#lib/updates.ts';
	import { invoke } from '@tauri-apps/api/core';
	import { getVersion } from '@tauri-apps/api/app';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { syncRemoteServer } from '#lib/remote/service.ts';
	import '#lib/styles/app.css';
	import { startEngine } from '#lib/engine/index.ts';
	import { syncOwnerApi } from '#lib/owner/service.ts';
	import { messageText, type ChatMessage } from '#lib/api.ts';
	import { installMarkdownActions } from '#lib/markdown-actions.ts';
	import {
		isVoiceCaptureActive,
		startVoiceCapture,
		stopAndTranscribe
	} from '#lib/audio/voiceCapture.svelte.ts';
	import { toggleTts } from '#lib/audio/ttsControl.svelte.ts';
	import {
		getActiveTab,
		mainTabs,
		probeCodeTab,
		setActiveTab
	} from '#lib/stores/activeTab.svelte.ts';
	import { getActiveSession as getActiveCodeSession } from '#lib/stores/code.svelte.ts';
	import { listenInMainWindow as listenForCodeWindows } from '#lib/code/windows.ts';
	import { getActiveConversation, sendMessage } from '#lib/stores/chat.svelte.ts';
	import { getActiveShellSession } from '#lib/stores/shell.svelte.ts';
	import { isDetachedRoute, rendersAgentModals } from '#lib/windowRoutes.ts';
	import {
		listenForMcpToolChanges,
		startConfiguredMcpServers
	} from '#lib/stores/mcpServers.svelte.ts';

	let { children } = $props();
	// Log Viewer visibility lives in the logViewer store (not local state)
	// so error toasts anywhere in the app can offer a "View logs" action.
	const showLogs = $derived(isLogViewerOpen());
	let showHelp = $state(false);
	// Settings renders as an in-page overlay rather than a route navigation, so
	// the Shell tab's PTY (and scrollback) survives opening/closing settings.
	let showSettings = $state(false);

	// Settings is an overlay rendered *above* `children()` in <main>, not a
	// route. So navigating away from inside it — Inference → Run Setup Wizard
	// calls `goto('/setup')` — swaps the page underneath while the overlay
	// stays put, and the click looks like it did nothing. Close it whenever we
	// land on the wizard.
	$effect(() => {
		if (page.url.pathname.startsWith('/setup')) {
			showSettings = false;
		}
	});
	let showStartupNotice = $state(false);
	let version = $state('');
	let update = $state<UpdateInfo | null>(null);

	// A detached shell window, a detached Code window and an editor window
	// load this same root layout. They must NOT re-run app bootstrap
	// (sidecars, job scheduler, setup redirect) or render the main chrome —
	// each shows only its own page (routes/shell/[id], routes/code/[id],
	// routes/editor).
	const codeWindow = $derived(page.route.id === '/code/[id]');
	const detached = $derived(isDetachedRoute(page.route.id));

	// Delegated handler for the copy/paste/run buttons inside rendered
	// markdown (sanitization strips inline onclick). Installed in every
	// window — the detached shell window renders markdown too.
	onMount(() => installMarkdownActions());

	// On Windows the Code tab shows only once a WSL2 distro is found.
	onMount(() => void probeCodeTab());

	// Other clients' way into this window's Code sessions (plan/remote-api/).
	// Does nothing outside the main and Code windows, or while Rust has it off.
	onMount(() => void startEngine());

	// Bring up the user's MCP servers in the background. Their tools only exist
	// in the registry while a server is running, so nothing starting them meant
	// the model never saw them; not awaited, so the window is not held closed
	// while several child processes negotiate.
	onMount(() => {
		// An editor window has no agent, so no use for the servers, and a Code
		// session's tools don't include them.
		if (page.route.id === '/editor' || page.route.id === '/code/[id]') return;
		void startConfiguredMcpServers();
		// A running server can change what it publishes — Godot reveals a whole
		// toolset when the model enables one — and the registry has to hear
		// about it or the new tools stay invisible until a restart.
		const mcpToolsChanged = listenForMcpToolChanges();
		// The root layout lives as long as the app, but a dev-server reload
		// remounts it, and a listener per reload means one refresh per reload.
		return () => void mcpToolsChanged.then((unlisten) => unlisten());
	});

	/**
	 * Intercept clicks on external links and open them in the system browser
	 * rather than letting the webview navigate to them (which would replace the
	 * Haruspex UI). Routed through our own `open_url` command rather than
	 * tauri-plugin-shell so the spawn happens in Rust where we can strip
	 * AppImage-bundled paths out of LD_LIBRARY_PATH for the child — without
	 * that, AppImage builds inherited the bundled lib path into the spawned
	 * browser and links did nothing.
	 */
	function openExternalLinks(e: MouseEvent): void {
		const anchor = (e.target as HTMLElement).closest('a');
		if (!anchor) return;
		const href = anchor.getAttribute('href');
		if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
			e.preventDefault();
			invoke('open_url', { url: href }).catch((err) => {
				console.error('open_url failed:', href, err);
				showToast("Couldn't open link in your browser", { kind: 'error' });
			});
		}
	}

	/**
	 * Suppress the webview's right-click context menu on links. WebKitGTK's
	 * default "Open Link" item navigates the current frame, which replaces the
	 * Haruspex UI with the linked page. Killing the menu on anchors removes the
	 * footgun; non-link right-clicks still get the default menu.
	 */
	function suppressLinkContextMenu(e: MouseEvent): void {
		const anchor = (e.target as HTMLElement).closest('a');
		if (anchor) e.preventDefault();
	}

	/**
	 * Both link handlers, in their OWN synchronous onMount.
	 *
	 * They used to live in the async bootstrap onMount below, which was wrong
	 * twice over. Svelte only honours a teardown returned SYNCHRONOUSLY, so an
	 * async callback cannot clean up after itself at all — the listeners were
	 * never removed, and every remount (Vite HMR during development) stacked
	 * another copy. With N copies attached, one click on a reference link
	 * fired `open_url` N times and opened N identical browser tabs.
	 *
	 * Installing them here also reaches every window. The bootstrap onMount
	 * early-returns for detached shell windows, so those never got the
	 * interceptor: a link click there navigated the webview and replaced the
	 * shell UI with the page. Detached windows render markdown (and so links)
	 * exactly like the main one, which is why `installMarkdownActions` above is
	 * already installed unconditionally.
	 */
	// The main window opens what detached Code windows hand back (re-attach,
	// a fork made there) and their open_in_shell requests: the Shell tabs live
	// here.
	onMount(() => {
		if (detached) return;
		const stop = listenForCodeWindows(() => setActiveTab('code'));
		return () => void stop.then((f) => f()).catch(() => {});
	});

	onMount(() => {
		document.addEventListener('click', openExternalLinks);
		document.addEventListener('contextmenu', suppressLinkContextMenu);
		return () => {
			document.removeEventListener('click', openExternalLinks);
			document.removeEventListener('contextmenu', suppressLinkContextMenu);
		};
	});

	// Effective theme for the header sun/moon toggle. The settings store
	// isn't reactive, but applyTheme() is the only writer of `data-theme`,
	// so observing that attribute + the OS preference covers every way the
	// theme can change (header toggle, Settings → General, OS switch).
	let effectiveDark = $state(false);

	function computeEffectiveDark(): boolean {
		const attr = document.documentElement.getAttribute('data-theme');
		if (attr === 'dark') return true;
		if (attr === 'light') return false;
		return window.matchMedia('(prefers-color-scheme: dark)').matches;
	}

	onMount(() => {
		effectiveDark = computeEffectiveDark();
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		const refresh = () => (effectiveDark = computeEffectiveDark());
		mq.addEventListener('change', refresh);
		const observer = new MutationObserver(refresh);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme']
		});
		return () => {
			mq.removeEventListener('change', refresh);
			observer.disconnect();
		};
	});

	// The header toggle pins an explicit light/dark choice (overriding
	// 'system'); Settings → General still offers the three-way picker.
	function toggleTheme() {
		const next = effectiveDark ? 'light' : 'dark';
		updateSettings({ theme: next });
		applyTheme(next);
	}

	// A model switch or context-size change made while a turn is running is
	// deferred rather than aborting the turn (see restartServerWhenIdle). This
	// flushes the queued restart the moment the process-wide inference queue
	// goes idle. It lives in the root layout — which never unmounts — so the
	// pending restart survives the user navigating away from Settings.
	// maybeFlushPendingRestart reads the queue count + pending state
	// synchronously, so this effect tracks both as dependencies.
	$effect(() => {
		void maybeFlushPendingRestart();
	});

	onMount(async () => {
		applyTheme();
		applyAccent();
		// Every window applies its own zoom — including detached shells,
		// which return early below.
		applyUiScale();
		// Self-heal a stuck inference slot left by a previous renderer lifetime
		// (a webview crash/reload doesn't fire the OS window-destroyed cleanup,
		// so the Rust queue can hold a phantom "running" ticket). Runs for every
		// window — including detached shells — before the bootstrap early-return.
		void reclaimOwnWindowSlots();
		if (detached) return;
		initServerStore();
		initChatStore();
		// Inline email passwords move to the system keychain where there is
		// one. Idempotent, so it runs at every start.
		void migrateEmailSecrets();
		void migrateDavSecrets();
		void migrateBraveApiKey();
		void comfyApiKey.migrate();
		void migrateProxyPasswords();
		void migrateMcpSecrets();
		void migrateApiKeys().then(apiKeysReady).then(migrateJobApiKeys);
		void remoteToken.migrate();
		// Sweep any job runs left at 'queued' / 'running' by a previous
		// session (hard close, crash). Fire-and-forget — the JobsTab loads
		// run history on demand and will pick up the recovered statuses.
		// releaseStaleInhibit clears a sleep inhibit stranded by a previous
		// renderer lifetime, for the same reason as reclaimOwnWindowSlots
		// above — a webview reload would otherwise hold the machine awake
		// until the app exits. Both must settle before the scheduler starts:
		// it fires a tick immediately, and a due job acquiring the inhibit
		// mid-sweep would have that acquire undone by the late release, just
		// as it would enqueue while the runner thinks the DB has a stale
		// 'running' row.
		void Promise.all([recoverOrphanRuns(), releaseStaleInhibit()]).then(() => startScheduler());
		// Remote web chat, if Settings has it on. Only the main window does
		// this: the driver answers a process-wide event, so a second listener
		// in a detached shell would race it for every guest prompt.
		void syncRemoteServer();
		// Settings → Remote control, if it is on. Main window only, like
		// remote chat: one server for the app.
		void syncOwnerApi();

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
		// the main window's root route and a detached shell or Code window.
		// Packaged builds load the webview from `tauri://localhost`, where
		// `page.url.pathname` is '' (empty) rather than '/'; matching on the
		// SvelteKit route id is stable across dev and packaged builds.
		return (
			page.route.id === '/' || page.route.id === '/shell/[id]' || page.route.id === '/code/[id]'
		);
	}

	/** The tab the hotkeys act on. A detached Code window is all Code tab. */
	function hotkeyTab() {
		return codeWindow ? 'code' : getActiveTab();
	}

	function pickTranscriptionTarget(text: string) {
		const tab = hotkeyTab();
		if (tab === 'shell') {
			void getActiveShellSession()?.submitChatMessage(text);
		} else if (tab === 'code') {
			void getActiveCodeSession()?.send(text);
		} else if (tab === 'chat') {
			sendMessage(text);
		}
		// 'jobs' has no chat input — silently drop.
	}

	function getLastAssistantText(): string {
		const tab = hotkeyTab();
		const messages =
			tab === 'shell'
				? (getActiveShellSession()?.messages ?? [])
				: tab === 'code'
					? (getActiveCodeSession()?.messages ?? [])
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
		if (hotkeyTab() === 'shell') getActiveShellSession()?.setSidebarOpen(true);
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
		if (hotkeyTab() !== 'shell') return;
		const session = getActiveShellSession();
		if (!session) return;
		session.setSidebarOpen(true);
		void session.submitRecentCommands();
	}

	// Browser-style UI zoom: Cmd on macOS, Ctrl elsewhere — same convention
	// as every browser. The webview engines expose the zoom API but don't
	// ship the browser's keybindings, so we wire them here.
	const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

	function handleZoomKey(event: KeyboardEvent): boolean {
		const modifier = isMac ? event.metaKey : event.ctrlKey;
		if (!modifier || event.altKey) return false;
		// '=' is the unshifted '+' key; '_' the shifted '-'. NumpadAdd /
		// NumpadSubtract also report '+' / '-' in event.key.
		if (event.key === '+' || event.key === '=') {
			event.preventDefault();
			if (!event.repeat) stepUiScale(1);
			return true;
		}
		if (event.key === '-' || event.key === '_') {
			event.preventDefault();
			if (!event.repeat) stepUiScale(-1);
			return true;
		}
		if (event.key === '0') {
			event.preventDefault();
			if (!event.repeat) resetUiScale();
			return true;
		}
		return false;
	}

	/**
	 * Ctrl / ⌘ + 1–4 picks a main tab. In the capture phase, so it works while
	 * a terminal has focus: xterm takes Ctrl+3 and Ctrl+4 as control codes.
	 */
	function onTabSwitchKeydown(event: KeyboardEvent) {
		const modifier = isMac ? event.metaKey : event.ctrlKey;
		if (!modifier || event.altKey || event.shiftKey || (isMac && event.ctrlKey)) return;
		if (!/^[1-4]$/.test(event.key) || detached || !isMainPage() || showSettings) return;
		const tab = mainTabs()[Number(event.key) - 1];
		if (!tab) return;
		event.preventDefault();
		event.stopPropagation();
		setActiveTab(tab);
	}

	function onGlobalKeydown(event: KeyboardEvent) {
		// UI zoom works everywhere — every page, every window, before any
		// page guard.
		if (handleZoomKey(event)) return;
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

	// Guard against the webview navigating to a dropped file. With the native
	// OS file-drop handler disabled (so the chat composers get DOM drop events),
	// any file drop that ISN'T preventDefault'd makes the webview load the
	// file:// URL — which blanks the SPA and looks like the app hung. The
	// composer dropzones handle drops that land on them; this window-level guard
	// neutralizes the navigation default for every other file drop. Gated to
	// file drags so in-app text/element dragging is unaffected. Mirrors the
	// existing link-click / context-menu navigation guards above.
	function isFileDrag(event: DragEvent): boolean {
		return Array.from(event.dataTransfer?.types ?? []).includes('Files');
	}

	function onWindowDragOver(event: DragEvent) {
		if (isFileDrag(event)) event.preventDefault();
	}

	function onWindowDrop(event: DragEvent) {
		if (isFileDrag(event)) event.preventDefault();
	}
</script>

<svelte:window
	onkeydown={onGlobalKeydown}
	onkeydowncapture={onTabSwitchKeydown}
	onkeyup={onGlobalKeyup}
	ondragover={onWindowDragOver}
	ondrop={onWindowDrop}
/>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{#snippet agentModals()}
	<FileConflictModal />
	<SandboxApprovalModal />
	<CommandApprovalModal />
	<McpApprovalModal />
	<MemoryApprovalModal />
	<RepoTrustModal />
	<SkillApprovalModal />
	<UserQuestionModal />
{/snippet}

{#if detached}
	{@render children()}
	<!-- Detached Code and Shell windows run turns, so they ask their own
	     approvals: each window has its own approval stores. -->
	{#if rendersAgentModals(page.route.id)}
		{@render agentModals()}
	{/if}
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
			<ServerStatusBadge onOpenLogs={openLogViewer} />
			<ContextIndicator jobsActive={getActiveTab() === 'jobs'} />
			<button
				class="header-icon-btn"
				title="Toggle light / dark"
				aria-label="Toggle light / dark theme"
				onclick={toggleTheme}
			>
				{#if effectiveDark}
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
						<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
					</svg>
				{:else}
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
						<circle cx="12" cy="12" r="5"></circle>
						<line x1="12" y1="1" x2="12" y2="3"></line>
						<line x1="12" y1="21" x2="12" y2="23"></line>
						<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
						<line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
						<line x1="1" y1="12" x2="3" y2="12"></line>
						<line x1="21" y1="12" x2="23" y2="12"></line>
						<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
						<line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
					</svg>
				{/if}
			</button>
			<button
				class="header-icon-btn"
				title="Sidecar Logs"
				aria-label="View logs"
				onclick={toggleLogViewer}
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
					<polyline points="4 17 10 11 4 5"></polyline>
					<line x1="12" y1="19" x2="20" y2="19"></line>
				</svg>
			</button>
			<button
				class="header-icon-btn"
				title="Keyboard shortcuts (F1)"
				aria-label="Keyboard shortcuts (F1)"
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
				aria-label="Settings"
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

	<LogViewer open={showLogs} onclose={closeLogViewer} />
	<HelpModal open={showHelp} onclose={() => (showHelp = false)} />

	{#if showStartupNotice}
		<StartupNoticeDialog onclose={() => (showStartupNotice = false)} />
	{/if}

	{@render agentModals()}
	<EmailReviewModal />
	<FileEditorModal />
{/if}

<!-- Toast host lives outside the detached-shell branch: each webview
     window has its own store instance, and errors surface in detached
     shell windows too. -->
<Toasts />

<style>
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 9px 16px;
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
		min-width: 0;
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
</style>
