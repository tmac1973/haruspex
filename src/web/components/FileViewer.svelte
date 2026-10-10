<script lang="ts">
	/**
	 * A file from the session's folder, read-only: what a file link or a
	 * diff's name opens on the web page, where there is no editor window.
	 * Highlighted like a code block in an answer, up to a size where that
	 * would be slow; plain text beyond it.
	 */
	import Modal from '#lib/components/Modal.svelte';
	import type { FileContent } from '#lib/engine/types.ts';
	import { renderMarkdown } from '#lib/markdown.ts';

	let {
		file,
		error = null,
		line = null,
		onclose
	}: {
		file: FileContent | null;
		error?: string | null;
		/** Scroll to this line once shown. */
		line?: number | null;
		onclose: () => void;
	} = $props();

	/** Past this, highlighting takes long enough to notice. */
	const HIGHLIGHT_MAX = 200_000;

	const LANGS: Record<string, string> = {
		ts: 'typescript',
		tsx: 'typescript',
		js: 'javascript',
		mjs: 'javascript',
		cjs: 'javascript',
		jsx: 'javascript',
		svelte: 'html',
		vue: 'html',
		html: 'html',
		css: 'css',
		scss: 'scss',
		rs: 'rust',
		py: 'python',
		go: 'go',
		java: 'java',
		kt: 'kotlin',
		c: 'c',
		h: 'c',
		cpp: 'cpp',
		hpp: 'cpp',
		cs: 'csharp',
		rb: 'ruby',
		php: 'php',
		sh: 'bash',
		bash: 'bash',
		zsh: 'bash',
		fish: 'bash',
		json: 'json',
		toml: 'ini',
		ini: 'ini',
		yaml: 'yaml',
		yml: 'yaml',
		md: 'markdown',
		sql: 'sql',
		xml: 'xml',
		gd: 'gdscript',
		lua: 'lua'
	};

	function language(path: string): string {
		const ext = path.split('.').pop()?.toLowerCase() ?? '';
		return LANGS[ext] ?? '';
	}

	/** A fence longer than any run of backticks in the file, so nothing closes it early. */
	function fenced(content: string, lang: string): string {
		const longest = Math.max(2, ...(content.match(/`+/g) ?? []).map((r) => r.length));
		const fence = '`'.repeat(longest + 1);
		return `${fence}${lang}\n${content}\n${fence}`;
	}

	const html = $derived(
		file && file.content.length <= HIGHLIGHT_MAX
			? renderMarkdown(fenced(file.content, language(file.path)))
			: null
	);

	let body = $state<HTMLDivElement | null>(null);
	$effect(() => {
		void html;
		if (!body || !line || line < 2) return;
		const code = body.querySelector('code');
		if (!code) return;
		const lh = parseFloat(getComputedStyle(code).lineHeight) || 18;
		queueMicrotask(() => body && (body.scrollTop = Math.max(0, (line - 4) * lh)));
	});
</script>

<Modal open title={file?.path ?? 'Opening…'} maxWidth={1100} dismissable {onclose}>
	{#if error}
		<p class="error-text">{error}</p>
	{:else if !file}
		<p class="hint">Opening…</p>
	{:else}
		<div class="body markdown" bind:this={body}>
			{#if html}
				<!-- renderMarkdown sanitises its output. -->
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				{@html html}
			{:else}
				<pre><code>{file.content}</code></pre>
			{/if}
		</div>
		{#if file.truncated}
			<p class="hint" title="The viewer shows the first million characters.">
				Only the start of this file is shown.
			</p>
		{/if}
	{/if}
</Modal>

<style>
	.body {
		max-height: 75vh;
		overflow: auto;
	}

	.body :global(pre) {
		margin: 0;
	}

	.body :global(.code-block) {
		margin: 0;
	}
</style>
