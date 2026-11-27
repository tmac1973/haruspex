<script lang="ts">
	import { goto } from '$app/navigation';
	import SettingsPanel from '#lib/components/settings/SettingsPanel.svelte';

	// Settings is normally shown as an in-page overlay (see +layout.svelte) so
	// the Shell tab's PTY stays alive. This standalone route remains for direct
	// navigation / deep links; closing returns to the main page.
</script>

<div class="settings-page">
	<SettingsPanel onclose={() => goto('/')} />
</div>

<style>
	/* Laid out like +layout.svelte's .settings-overlay: the panel's rail and
	   pane scroll, the page doesn't. Sized like the main page, below the
	   45px header. */
	.settings-page {
		height: calc(100vh - 45px);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--bg-primary);
	}
</style>
