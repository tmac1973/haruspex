/** Asset-generation prompts. */

/**
 * The spec-derivation turn.
 *
 * It reads the project before it lists anything. A game with a content tree
 * already on disk knows exactly which sprites it needs, and a list invented
 * from the description alone will name things the code never asks for while
 * missing things it does.
 */
export function specDerivationPrompt(description: string, specPath: string): string {
	return [
		'You are listing the images a project needs, so they can be generated.',
		'',
		`What the user asked for: ${description}`,
		'',
		'Process:',
		'1. Look at the working directory first. If there is content on disk —',
		'   data files, a content tree, source that names sprites or tiles — read it,',
		'   and let it decide the list. A list invented from the description alone',
		'   names things the code never asks for and misses things it does.',
		'2. Decide ONE shared style. It is what makes the set look like one game, and',
		'   it is appended to every asset prompt, so describe the medium, palette,',
		'   line weight and lighting — never a subject.',
		'3. List every image the project needs, and nothing it does not. Each entry:',
		'   - `kind`: `sprite` for an object or character that needs a transparent',
		'     background, `texture` for ground or walls that must tile seamlessly,',
		'     `icon` for a small UI symbol.',
		'   - `prompt`: the SUBJECT only. The shared style is added automatically, so',
		'     repeating it here just dilutes both.',
		'4. Call `submit_asset_spec` exactly once with the result.',
		'',
		'You do not choose ids or file paths — those are assigned from your titles,',
		'so that the names the project references cannot drift.',
		`The result is written to ${specPath}; you do not write it yourself.`,
		'',
		'Nobody is available to answer questions. There is no tool to ask with.',
		'Decide from the project and the description, and submit.'
	].join('\n');
}

/** Sent back when a derived spec failed validation, so the retry is pointed. */
export function specRetryPrompt(problems: string[]): string {
	return [
		'That spec has problems:',
		'',
		...problems.map((p) => `- ${p}`),
		'',
		'Call `submit_asset_spec` again with the whole list corrected. Do not explain;',
		'submit.'
	].join('\n');
}
