<script lang="ts">
	/**
	 * Settings → General → Background. Both switches live in Rust, not in
	 * the settings blob: the tray one in `background.json` (Rust needs it
	 * before any page loads), and start at login in the OS's own entry. See
	 * `src-tauri/src/background.rs`.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import type { BackgroundState } from '#lib/ipc/gen/BackgroundState.ts';
	import type { IpcCommand } from '#lib/ipc/commands.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let bg = $state<BackgroundState | null>(null);
	let error = $state('');

	$effect(() => {
		void invoke<BackgroundState>('background_get')
			.then((s) => (bg = s))
			.catch((e: unknown) => console.warn('background_get failed:', e));
	});

	async function set(
		command: Extract<IpcCommand, 'background_set_tray' | 'background_set_start_at_login'>,
		on: boolean
	) {
		error = '';
		try {
			bg = await invoke<BackgroundState>(command, { on });
		} catch (e) {
			error = errMessage(e);
			// Put the box back as it was.
			bg = await invoke<BackgroundState>('background_get').catch(() => bg);
		}
	}
</script>

{#if bg}
	<section class="settings-section">
		<h2>Background</h2>
		<label
			class="toggle-row"
			title="Closing the window hides it, so jobs and Home cards keep running. Show or quit Haruspex from the tray icon."
		>
			<input
				type="checkbox"
				checked={bg.tray}
				onchange={(e) => set('background_set_tray', e.currentTarget.checked)}
			/>
			<div>
				<strong>Keep running in the tray</strong>
				<span>Closing the window leaves Haruspex running.</span>
			</div>
		</label>
		<label
			class="toggle-row"
			title="With Keep running in the tray on, it starts in the tray; otherwise the window opens."
		>
			<input
				type="checkbox"
				checked={bg.startAtLogin}
				onchange={(e) => set('background_set_start_at_login', e.currentTarget.checked)}
			/>
			<div>
				<strong>Start at login</strong>
				<span>Haruspex starts when you log in.</span>
			</div>
		</label>
		{#if error}
			<p class="error">{error}</p>
		{/if}
	</section>
{/if}

<style>
	.toggle-row + .toggle-row {
		margin-top: 12px;
	}

	.error {
		color: var(--error-text, #c97);
		font-size: 0.85rem;
		margin: 8px 0 0;
	}
</style>
