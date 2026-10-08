#!/usr/bin/env node
// Does this PR need a user guide update? Run by .github/workflows/guide.yml.
//
// The guide in docs/guide/ is what the app's model reads to answer questions
// about Haruspex (haruspex_docs), so a change users can see that skips it
// leaves the model describing the old app. A PR that touches one of the
// paths below without touching docs/guide/ fails, unless it is labelled
// `no-docs` (a refactor, a test, an internal change).
//
// Usage: git diff --name-only BASE...HEAD | node scripts/guide-check.mjs [label ...]

/** Paths whose changes users can see, and what to call them. */
export const TRIGGERS = [
	{ re: /^src\/lib\/components\/settings\//, what: 'a Settings section' },
	// The registry and the tool plumbing are internal; the tools aren't.
	{
		re: /^src\/lib\/agent\/tools\/(?!(registry|types|index|coerce|_helpers|mcp-names)\.ts$)/,
		what: 'an agent tool'
	},
	{ re: /^src\/lib\/agent\/jobs\/types\//, what: 'a job type' },
	{ re: /^src\/lib\/slash\//, what: 'slash commands' },
	{ re: /^src\/lib\/shortcuts\.ts$/, what: 'keyboard shortcuts' },
	{ re: /^src-tauri\/resources\/skills\//, what: 'a shipped skill' }
];

export const SKIP_LABEL = 'no-docs';

/** @param {string} f */
const isTest = (f) => /\.test\.ts$/.test(f) || /\.test\.svelte\.ts$/.test(f);

/**
 * `files` are the PR's changed paths, `labels` its label names. Returns
 * whether it passes, and the changed paths that asked for a guide update.
 * @param {string[]} files
 * @param {string[]} [labels]
 */
export function guideCheck(files, labels = []) {
	const triggered = files.filter((f) => !isTest(f) && TRIGGERS.some((t) => t.re.test(f)));
	const touched = files.some((f) => f.startsWith('docs/guide/'));
	const skipped = labels.includes(SKIP_LABEL);
	return { ok: triggered.length === 0 || touched || skipped, triggered, touched, skipped };
}

/** @param {ReturnType<typeof guideCheck>} result */
function report({ triggered, touched, skipped }) {
	if (triggered.length === 0) return 'Nothing here needs the user guide.';
	if (touched) return 'The user guide was updated alongside these changes.';
	if (skipped) return `Skipped by the ${SKIP_LABEL} label.`;
	const lines = triggered.map((f) => {
		const what = TRIGGERS.find((t) => t.re.test(f))?.what;
		return `  ${f} (${what})`;
	});
	return [
		'These changes are ones users can see, but docs/guide/ was not touched:',
		...lines,
		'',
		'Update the page that describes them (the app reads the guide to answer',
		`questions about itself), or add the ${SKIP_LABEL} label if nothing a user`,
		'sees has changed.'
	].join('\n');
}

// Run as a command, not imported by the test.
const runAsScript = import.meta.url.endsWith(`/${process.argv[1]?.split('/').pop() ?? ''}`);
if (runAsScript) {
	let input = '';
	process.stdin.setEncoding('utf8');
	for await (const chunk of process.stdin) input += chunk;
	const files = input.split('\n').map((l) => l.trim()).filter(Boolean);
	const result = guideCheck(files, process.argv.slice(2));
	console.log(report(result));
	process.exit(result.ok ? 0 : 1);
}
