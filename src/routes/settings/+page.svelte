<script lang="ts">
	import { goto } from '$app/navigation';
	import SettingsPanel from '$lib/components/settings/SettingsPanel.svelte';

	// Settings is normally shown as an in-page overlay (see +layout.svelte) so
	// the Shell tab's PTY stays alive. This standalone route remains for direct
	// navigation / deep links; closing returns to the main page.
</script>

<SettingsPanel onclose={() => goto('/')} />
