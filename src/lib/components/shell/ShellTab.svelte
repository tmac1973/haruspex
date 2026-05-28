<script lang="ts">
	import Terminal from './Terminal.svelte';
</script>

<div class="shell-tab">
	<div class="terminal-pane">
		<Terminal />
	</div>
</div>

<style>
	.shell-tab {
		display: flex;
		flex-direction: row;
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
	}

	.terminal-pane {
		position: relative;
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
	}
</style>
