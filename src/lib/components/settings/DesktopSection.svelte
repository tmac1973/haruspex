<script lang="ts">
	/**
	 * Settings → Screen. One toggle.
	 *
	 * The button in the chat composer captures whether or not this is on — a
	 * person pressing a button is not a permission question. What this decides
	 * is whether the *assistant* may ask for the screen on its own, which is a
	 * different thing and the one worth a switch.
	 */
	import { getSettings, updateSettings } from '$lib/stores/settings';

	let enabled = $state(getSettings().screenCaptureEnabled);

	function toggle() {
		updateSettings({ screenCaptureEnabled: enabled });
	}
</script>

<section class="settings-section">
	<h2>Screen capture</h2>
	<label class="toggle-row">
		<input type="checkbox" bind:checked={enabled} onchange={toggle} />
		<span>Let the assistant take a screenshot when you ask it to</span>
	</label>
	<p
		class="section-help"
		title="Each capture happens at the moment it is asked for. The screen is never watched, sampled on a timer, or captured in the background."
	>
		Captures once per request, never on a timer.
	</p>
	<p class="section-help">
		You can always attach a screenshot yourself with the camera button in the chat composer.
	</p>
</section>

<style>
	.section-help {
		color: var(--text-secondary);
		font-size: 0.85rem;
		margin: 12px 0 0 0;
		line-height: 1.5;
	}
</style>
