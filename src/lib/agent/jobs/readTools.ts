/**
 * The tools a job stage gets when it should look at the project but never
 * change it: an audit sample or verdict, the asset spec's derivation, the
 * plan verifier. Each stage adds its own submit tool (and the verifier PDFs).
 */
export const PROJECT_READ_TOOLS: readonly string[] = [
	'fs_read_text',
	'fs_list_dir',
	'code_grep',
	'code_glob'
];
