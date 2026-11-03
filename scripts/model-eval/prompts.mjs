/**
 * The model eval's prompts, each with the tool group it needs (null: none)
 * and a check of the run's record. A check reads only what the run left: the
 * answer, the steps, the tools that ran and the files in the folders.
 *
 * Chat prompts run in the test folder (an episode `ep012` with two clips, of
 * 12 s and 20 s); Code prompts in the test project (a README).
 */

const has = (text, ...needles) => needles.every((n) => text.includes(n));
const lengths = (a) =>
	(has(a, '0:12') || has(a, '12 s') || has(a, '12s')) &&
	(has(a, '0:20') || has(a, '20 s') || has(a, '20s'));

/** b.mp4 2–10 s, then a.mp4, with the 1 s crossfade on the join. */
function cutIsRight(args) {
	const items = args?.items;
	if (!Array.isArray(items) || items.length !== 2) return false;
	const [first, second] = items;
	const fade = args.crossfade_secs ?? second.crossfade_secs ?? second.transition_secs;
	return (
		String(first.path ?? '').endsWith('b.mp4') &&
		first.in_secs === 2 &&
		first.out_secs === 10 &&
		String(second.path ?? '').endsWith('a.mp4') &&
		fade === 1
	);
}

export const PROMPTS = {
	'video-implicit': {
		tab: 'chat',
		family: 'video',
		text: 'What clips are in ep012? List them with their lengths.',
		check: (r) => lengths(r.answer)
	},
	'video-cut': {
		tab: 'chat',
		family: 'video',
		text: 'In ep012, make a cut of clips/b.mp4 from 2 s to 10 s followed by clips/a.mp4 whole, with a 1 s crossfade at the join.',
		check: (r) => r.steps.some((s) => s.tool === 'video_cut' && cutIsRight(s.args))
	},
	'docs-pdf': {
		tab: 'chat',
		family: 'documents',
		text: 'Write a short PDF called heat-pumps.pdf that explains how a heat pump works, in about 200 words. Do not search.',
		check: (r) => r.files.includes('heat-pumps.pdf')
	},
	'mixed-research-pdf': {
		tab: 'chat',
		family: 'documents',
		text: 'Research how heat pumps work and make a one-page PDF of it called hp-research.pdf.',
		check: (r) => r.files.some((f) => /^hp-research.*\.pdf$/.test(f))
	},
	github: {
		tab: 'chat',
		family: 'mcp',
		needs: 'a GitHub MCP server in Settings → Integrations',
		text: 'List the three most recent open issues in the tmac1973/haruspex repository on GitHub.',
		check: (r) => r.ran.some((t) => /__list_issues$/.test(t)) && /#\d+/.test(r.answer)
	},
	music: {
		tab: 'chat',
		family: 'music',
		slow: true,
		needs: 'a music backend in Settings → Music',
		text: 'Write a short song about rain.',
		check: (r) => r.ran.includes('generate_music') && has(r.answer, 'haruspex-audio:')
	},
	image: {
		tab: 'chat',
		family: 'images',
		slow: true,
		needs: 'an image model in Settings → Image',
		text: 'Draw a small picture of a red fox in the snow.',
		check: (r) => r.ran.includes('generate_image') && has(r.answer, 'haruspex-img:')
	},
	'none-explain': {
		tab: 'chat',
		family: null,
		text: 'Explain how a heat pump works in three sentences.',
		check: (r) => r.answer.length > 80 && /heat/i.test(r.answer)
	},
	'none-math': {
		tab: 'chat',
		family: null,
		text: 'What is 17% of 2,340?',
		check: (r) => has(r.answer, '397.8')
	},
	'code-texture': {
		tab: 'code',
		family: 'assets',
		text: 'Make a 32px tiling stone texture at assets/stone.png.',
		check: (r) => r.files.includes('assets/stone.png')
	},
	'code-speech': {
		tab: 'code',
		family: 'speech',
		text: 'Read this aloud into hello.wav: Hello from Haruspex.',
		check: (r) => r.files.includes('hello.wav')
	},
	'code-none': {
		tab: 'code',
		family: null,
		text: 'What does the README in this project say?',
		check: (r) => has(r.answer, 'tiny game')
	}
};

/**
 * The Search helper's live rerun (plan/search-code/phase-06-live-rerun.md):
 * the #951 spike's ten "where is X" tasks, run in a Code session on Haruspex
 * itself at the commit the answers were taken from (`SEARCH_COMMIT`). A run
 * passes when a path on the answer's `FILES:` line is one of the accepted
 * files. Not part of `--prompts all`; run them with `--prompts search`.
 */
export const SEARCH_COMMIT = '92e53127';

const SEARCH_ASK =
	' Reply with a short answer whose last line is FILES: followed by the relevant paths, most relevant first.';

/**
 * The paths named after the answer's last `FILES:`, relative to the project.
 * Models put them on that line, comma-separated, or as a list below it, often
 * with line numbers or a note after each; the first path in each item counts.
 */
export function filesLine(answer, root) {
	const at = answer.lastIndexOf('FILES:');
	if (at < 0) return [];
	return answer
		.slice(at + 6)
		.split(/[,\n]/)
		.map((item) => /[\w@.~/-]+\.[A-Za-z0-9]+/.exec(item)?.[0])
		.filter(Boolean)
		.map((p) => (root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p))
		.map((p) => p.replace(/^\.\//, ''));
}

const SEARCH_TASKS = {
	proxy: [
		"When the app starts a child process with the user's proxy set, where does it make sure localhost traffic still goes direct?",
		['src-tauri/src/proxy/child_env.rs']
	],
	memory: [
		'Where are recalled memories ranked, including the penalty for older memories?',
		['src-tauri/src/db/memories.rs', 'src/lib/agent/memory/recall.ts']
	],
	mcp: [
		'Where is a very large result from an MCP server tool trimmed before the model sees it?',
		['src/lib/agent/tools/mcp.ts']
	],
	grepcap: [
		'I want to change how many matches the code search tool returns by default. Which file holds that number?',
		['src-tauri/src/code_tools/search.rs']
	],
	anim: [
		'Where does the 3D model viewer let the user pick which animation plays?',
		['src/lib/components/GlbViewer.svelte', 'src/lib/editor/glbViewer.ts']
	],
	subtasks: [
		'Where is the wording of the Subtasks card in the Code settings?',
		['src/lib/components/settings/CodeSection.svelte']
	],
	node: [
		'npm install scripts call plain `node`. Where does the app make that command available to them?',
		['src-tauri/src/runtimes.rs']
	],
	github: [
		"Where does the Home screen's GitHub card fetch and shape the issues it shows?",
		['src/lib/home/github.ts']
	],
	addcard: [
		'In the Add card menu, which code decides that a card is greyed out and what the user must set up first?',
		['src/lib/home/cardTypes.ts', 'src/lib/components/home/AddCardMenu.svelte']
	],
	autosize: [
		'Where is the code that makes the message box grow taller as the user types?',
		['src/lib/utils/autosize.ts']
	]
};

for (const [id, [question, accepted]] of Object.entries(SEARCH_TASKS)) {
	PROMPTS[`search-${id}`] = {
		tab: 'code',
		family: null,
		group: 'search',
		text: question + SEARCH_ASK,
		accepted,
		check: (r) => filesLine(r.answerTail, r.root).some((p) => accepted.includes(p))
	};
}

/** One Chat conversation, a turn at a time, for how a small window holds up. */
export const CONVERSATION = [
	'What clips are in ep012? List them with their lengths.',
	'Explain how a heat pump works in three sentences.',
	'Research how well air-source heat pumps work in very cold climates.',
	'Write a short PDF called cold.pdf summarising that research.',
	'List the three most recent open issues in the tmac1973/haruspex repository on GitHub.',
	'Which of those three was opened first?',
	'In ep012, make a cut of clips/b.mp4 from 2 s to 10 s followed by clips/a.mp4 whole, with a 1 s crossfade at the join.',
	'What did you put in cold.pdf?',
	'What is 17% of 2,340?',
	'Draw a small picture of a red fox in the snow.',
	'What were the lengths of the two clips in ep012 again?',
	'Sum up everything we did in this conversation, as a short list.'
];
