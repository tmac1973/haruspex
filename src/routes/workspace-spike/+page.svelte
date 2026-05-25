<script lang="ts">
	// Temporary spike route for phase-13 unified python sandbox.
	// Wraps static/workspace/spike.html in an iframe so we can re-confirm
	// pygame-ce renders on this branch before committing to the larger
	// refactor. Delete once the production iframe lands.
</script>

<div class="page">
	<header>
		<h1>Workspace spike — pygame-ce in iframe</h1>
		<p>
			Reconfirms the prior branch's finding: pygame renders in a child iframe on WebKitGTK once
			<code>pyodide.canvas.setCanvas2D(canvas)</code> is bound before
			<code>pygame.init()</code>. Focus the canvas inside the iframe and use arrow keys.
		</p>
	</header>
	<iframe src="/workspace/spike.html" title="workspace-spike"></iframe>
</div>

<style>
	.page {
		padding: 1rem;
		color: #ddd;
		font-family: system-ui, sans-serif;
	}
	header {
		margin-bottom: 1rem;
	}
	h1 {
		margin: 0 0 0.5rem;
		font-size: 1.1rem;
	}
	p {
		margin: 0;
		font-size: 0.85rem;
		color: #aaa;
		max-width: 60ch;
	}
	code {
		background: #2a2a2a;
		padding: 0 0.25rem;
		border-radius: 2px;
	}
	iframe {
		width: 100%;
		height: 600px;
		border: 1px solid #444;
		background: #1a1a1a;
	}
</style>
