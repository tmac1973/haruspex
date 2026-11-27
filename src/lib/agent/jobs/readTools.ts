import { RECALL_TOOL } from '#lib/agent/recallArchive.ts';

/**
 * The tools a job stage gets when it should look at the project but never
 * change it: an audit sample or verdict, the asset spec's derivation, the
 * plan verifier. Each stage adds its own submit tool (and the verifier PDFs).
 *
 * With `recall_result`, so a long read-through can get back a file the
 * context fit trimmed instead of reading it again (#1022). A job stage that
 * reads files, runs commands or fetches pages lists it; one that only
 * submits a judgement doesn't need it.
 */
export const PROJECT_READ_TOOLS: readonly string[] = [
	'fs_read_text',
	'fs_list_dir',
	'code_grep',
	'code_glob',
	RECALL_TOOL
];
