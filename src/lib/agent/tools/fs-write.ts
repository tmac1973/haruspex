import { invoke } from '@tauri-apps/api/core';
import { labelArg, toolInvokeError } from './_helpers';
import { registerTool } from './registry';
import { toolError, toolResult } from './types';
import type { ToolContext, ToolExecOutput } from './types';
import { IMAGE_EXT_RE } from './fs-read';
import { lintPythonIfApplicable } from './python-lint';
import { isAutoApproveActive } from '$lib/stores/approvalOverride';

/**
 * Outcome of pre-write conflict resolution. `null` means the user
 * canceled and the caller should return an error to the model.
 */
interface ResolvedWritePath {
	finalPath: string;
	overwrite: boolean;
}

/**
 * Check whether a write to `relPath` would clobber an existing file,
 * and if so, show the file-conflict modal to let the user pick.
 */
async function resolveWritePathInteractive(
	workdir: string,
	relPath: string,
	filesWrittenThisTurn: Set<string>
): Promise<ResolvedWritePath | null> {
	if (filesWrittenThisTurn.has(relPath)) {
		return { finalPath: relPath, overwrite: true };
	}

	let exists = false;
	try {
		exists = await invoke<boolean>('fs_path_exists', { workdir, relPath });
	} catch {
		exists = false;
	}
	if (!exists) {
		return { finalPath: relPath, overwrite: false };
	}

	// Unattended runs (jobs) can't show a modal, so we treat existing-file
	// conflicts as "overwrite". The job authoring UI surfaces this so the
	// user knows what they're opting into.
	if (isAutoApproveActive()) {
		return { finalPath: relPath, overwrite: true };
	}

	const { askFileConflict } = await import('$lib/stores/fileConflict.svelte');
	const choice = await askFileConflict(relPath);
	if (choice === 'cancel') {
		return null;
	}
	if (choice === 'overwrite') {
		return { finalPath: relPath, overwrite: true };
	}
	try {
		const newPath = await invoke<string>('fs_find_available_path', { workdir, relPath });
		return { finalPath: newPath, overwrite: false };
	} catch (e) {
		console.error('fs_find_available_path failed:', e);
		return { finalPath: relPath, overwrite: true };
	}
}

function userCanceledWriteError(relPath: string, command: string): ToolExecOutput {
	return toolResult(
		toolError(
			`User canceled the ${command} write. The file "${relPath}" already exists in the working directory and the user chose to stop instead of overwriting or renaming. Do NOT retry automatically — stop what you were doing, briefly explain to the user that the file already exists, and ask them how they'd like to proceed (pick a different filename, overwrite the existing file, or skip the write entirely).`
		)
	);
}

/**
 * Generic write wrapper — deduplicates the resolve/invoke/track pattern
 * shared by all fs_write_* tools.
 */
async function fsWriteWithConflictCheck(
	command: string,
	workdir: string,
	relPath: string,
	payload: Record<string, unknown>,
	filesWrittenThisTurn: Set<string>
): Promise<ToolExecOutput> {
	const resolved = await resolveWritePathInteractive(workdir, relPath, filesWrittenThisTurn);
	if (!resolved) return userCanceledWriteError(relPath, command);
	try {
		await invoke(command, {
			workdir,
			relPath: resolved.finalPath,
			...payload,
			overwrite: resolved.overwrite
		});
		filesWrittenThisTurn.add(resolved.finalPath);
		const diag = await lintPythonIfApplicable(workdir, resolved.finalPath);
		return toolResult(`Wrote: ${resolved.finalPath}${diag}`);
	} catch (e) {
		return toolResult(toolInvokeError(command, e));
	}
}

/**
 * Factory for the `execute` handler shared by every `fs_write_*` tool:
 * resolves any file-conflict, forwards `{ workdir, relPath, ...payload,
 * overwrite }` to the named Rust command, and tracks the resulting
 * file in `ctx.filesWrittenThisTurn`. Each tool registration boils
 * down to one line.
 */
function writeExecutor(
	command: string,
	payload: (args: Record<string, unknown>) => Record<string, unknown>
) {
	return async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecOutput> =>
		fsWriteWithConflictCheck(
			command,
			ctx.workingDir!,
			args.path as string,
			payload(args),
			ctx.filesWrittenThisTurn
		);
}

// Shared sheet schema used by both xlsx and ods.
const SHEETS_SCHEMA = {
	type: 'array' as const,
	description:
		'Array of sheet objects. Each sheet has a name and rows. rows is a 2D array of LITERAL cell values — there is no templating, no variable substitution, no server-side expansion. Pass the actual data you want written. Numeric strings (e.g. "42", "3.14") auto-convert to numbers; strings starting with "=" become spreadsheet formulas (e.g. "=SUM(B2:B10)"); everything else is plain text. Row 1 is typically your header row.',
	items: {
		type: 'object' as const,
		properties: {
			name: { type: 'string' as const, description: 'Sheet name (tab label)' },
			rows: {
				type: 'array' as const,
				description:
					'2D array: array of rows, each row is an array of cell values as strings. Example: [["Name","Score"],["Alice","95"],["Bob","87"]]. The first inner array is the header row; subsequent arrays are data rows. Pass every row you want in the file — the tool does not generate rows for you.',
				items: { type: 'array' as const, items: { type: 'string' as const } }
			}
		},
		required: ['name', 'rows']
	}
};

/**
 * Reject obviously stub spreadsheet input — empty sheets, placeholder
 * rows like ["/formula"], etc. Small local models sometimes write a
 * "scaffold" call expecting the tool to fill in real data; without this
 * guard the tool silently writes nonsense and reports success.
 */
function validateSheets(args: Record<string, unknown>): string | null {
	const sheets = args.sheets;
	if (!Array.isArray(sheets) || sheets.length === 0) {
		return 'sheets must be a non-empty array.';
	}
	for (let i = 0; i < sheets.length; i++) {
		const sheet = sheets[i] as { name?: unknown; rows?: unknown };
		const rows = sheet.rows;
		if (!Array.isArray(rows) || rows.length === 0) {
			return `Sheet ${i + 1} has no rows. Pass the actual data — header row plus one row per record.`;
		}
		const dataRows = rows.slice(1);
		const hasRealData = dataRows.some(
			(r) =>
				Array.isArray(r) && r.some((cell) => typeof cell === 'string' && cell.trim().length > 0)
		);
		if (!hasRealData) {
			return (
				`Sheet ${i + 1} contains only a header row (or rows with no real cell data). ` +
				`Pass every data row you want written — the tool does not expand placeholders or templates.`
			);
		}
		const looksLikePlaceholder = rows.some(
			(r) =>
				Array.isArray(r) &&
				r.length === 1 &&
				typeof r[0] === 'string' &&
				/^\/[a-z_]+$/i.test(r[0].trim())
		);
		if (looksLikePlaceholder) {
			return (
				`Sheet ${i + 1} contains a placeholder-style row like ["/formula"] or ["/data"]. ` +
				`This tool does not expand directives — pass the literal cell values you want written.`
			);
		}
	}
	return null;
}

function spreadsheetWriteExecutor(command: string) {
	return async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecOutput> => {
		const validationError = validateSheets(args);
		if (validationError) {
			return toolResult(toolError(validationError));
		}
		return fsWriteWithConflictCheck(
			command,
			ctx.workingDir!,
			args.path as string,
			{ sheets: args.sheets },
			ctx.filesWrittenThisTurn
		);
	};
}

// Shared slide schema used by both pptx and odp
const SLIDE_SCHEMA = {
	type: 'array' as const,
	description: 'Array of slide objects.',
	items: {
		type: 'object' as const,
		properties: {
			title: {
				type: 'string' as const,
				description: 'Short slide title (~8 words max).'
			},
			layout: {
				type: 'string' as const,
				enum: ['content', 'section'],
				description:
					'"content" (default): title + bullets (+ optional image). "section": big centered title used as a divider; put the section headline in `title` and an optional short tagline in `subtitle`.'
			},
			subtitle: {
				type: 'string' as const,
				description: 'Optional short tagline shown below the main title on section slides.'
			},
			bullets: {
				type: 'array' as const,
				description:
					'Bullet points for content slides. Each entry is either a plain string (level 0) or an object { "text": "...", "level": 0|1|2 } for nested bullets.',
				items: {
					oneOf: [
						{ type: 'string' as const },
						{
							type: 'object' as const,
							properties: {
								text: { type: 'string' as const },
								level: {
									type: 'integer' as const,
									minimum: 0,
									maximum: 2,
									description: 'Indent depth. 0 = top level, 1 = sub-bullet, 2 = sub-sub-bullet.'
								}
							},
							required: ['text']
						}
					]
				}
			},
			image: {
				type: 'string' as const,
				description:
					'Optional relative path to an image file inside the working directory (png/jpg/jpeg/gif).'
			}
		},
		required: ['title']
	}
};

// --- Registration ---

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_text',
			description:
				'Create a new text file or overwrite an existing one in the working directory. Use this for txt, md, csv, json, bash scripts, and other plain text formats. The content parameter is written verbatim to the file.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Relative path for the new/overwritten file within the working directory.'
					},
					content: {
						type: 'string',
						description: 'The full text content to write to the file.'
					},
					overwrite: {
						type: 'boolean',
						description: 'Whether to overwrite if the file exists. Defaults to true.'
					}
				},
				required: ['path', 'content']
			}
		}
	},
	displayLabel: labelArg('path'),
	execute: writeExecutor('fs_write_text', (args) => ({ content: args.content }))
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_docx',
			description:
				'Create a Microsoft Word (.docx) file in the working directory from text content. The content is split into paragraphs on newlines. Lines starting with # become Heading 1, ## become Heading 2, ### become Heading 3. Embed images with `![alt](path)` on a line by itself; add an optional title to control alignment and width, e.g. `![alt](path "center 50%")`. Everything else is regular body text.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path for the new .docx file.' },
					content: {
						type: 'string',
						description:
							'Text content for the document. Use newlines between paragraphs. Prefix lines with # / ## / ### for headings. Embed an image with `![alt](path)` on a line by itself — the path is workdir-relative and must end in .png / .jpg / .jpeg / .gif. Optional layout: `![alt](path "center 50%")` accepts `left|center|right` and/or a width percentage 5–100% in the title; unknown tokens are ignored.'
					}
				},
				required: ['path', 'content']
			}
		}
	},
	displayLabel: labelArg('path'),
	execute: writeExecutor('fs_write_docx', (args) => ({ content: args.content }))
});

// Markdown→PDF tool. Always exposed (the Python toggle no longer hides
// it). Better choice than fpdf2-via-run_python for documents — see the
// system prompt's Python sandbox section.
registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_pdf',
			description:
				'Create a PDF report from markdown content. Use # / ## / ### for headings. Supports bold, italic, code, bullet lists, markdown tables, and embedded images via `![alt](path)` on a line by itself; add an optional title to control alignment and width, e.g. `![alt](path "center 50%")`. Write flowing prose organized by sections — prefer paragraphs over bullet lists.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path for the new .pdf file.' },
					content: {
						type: 'string',
						description:
							'Report content as markdown-style text. Headings use `#`/`##`/`###` (never `**Bold**` alone). Body is flowing paragraphs separated by blank lines. `- item` bullets ONLY for lists of 3+ related items. Markdown tables render as real tables — use them for genuinely tabular data with short cell contents. Embed images with `![alt](path)` on a line by itself; the path is workdir-relative and must end in .png / .jpg / .jpeg / .gif. Optional layout: `![alt](path "center 50%")` accepts `left|center|right` and/or a width percentage 5–100% in the title; unknown tokens are ignored. Do not use `---` for page breaks; page flow is automatic.'
					}
				},
				required: ['path', 'content']
			}
		}
	},
	displayLabel: labelArg('path'),
	execute: writeExecutor('fs_write_pdf', (args) => ({ content: args.content }))
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_xlsx',
			description:
				'Create an Excel spreadsheet (.xlsx) file in the working directory. ' +
				'Compute your data FIRST (e.g. via run_python), then pass the actual row arrays here. ' +
				'There is no templating or server-side expansion — every row you want in the file must be in the `rows` argument. ' +
				'Numeric strings auto-convert to numbers, strings starting with "=" become formulas, everything else is text. ' +
				'Example: sheets=[{name:"Data",rows:[["N","F(N)"],["1","0"],["2","1"],["3","1"]]}].',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path for the new .xlsx file.' },
					sheets: SHEETS_SCHEMA
				},
				required: ['path', 'sheets']
			}
		}
	},
	displayLabel: labelArg('path'),
	execute: spreadsheetWriteExecutor('fs_write_xlsx')
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_odt',
			description:
				'Create an OpenDocument Text (.odt) file for LibreOffice Writer. Same API as fs_write_docx, including `![alt](path)` image embedding with optional `"center 50%"` title for alignment/width. Only use when the user asks for ODT specifically.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path for the new .odt file.' },
					content: {
						type: 'string',
						description:
							'Text content. Use newlines between paragraphs. Prefix lines with # / ## / ### for headings. Embed an image with `![alt](path)` on a line by itself — the path is workdir-relative and must end in .png / .jpg / .jpeg / .gif. Optional layout: `![alt](path "center 50%")` accepts `left|center|right` and/or a width percentage 5–100% in the title; unknown tokens are ignored.'
					}
				},
				required: ['path', 'content']
			}
		}
	},
	displayLabel: labelArg('path'),
	execute: writeExecutor('fs_write_odt', (args) => ({ content: args.content }))
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_ods',
			description:
				'Create an OpenDocument Spreadsheet (.ods) for LibreOffice Calc. Same API as fs_write_xlsx. Only use when the user asks for ODS specifically.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path for the new .ods file.' },
					sheets: SHEETS_SCHEMA
				},
				required: ['path', 'sheets']
			}
		}
	},
	displayLabel: labelArg('path'),
	execute: spreadsheetWriteExecutor('fs_write_ods')
});

// Legacy hand-rolled OOXML PPTX path. Same arrangement as fs_write_pdf:
// filtered out when the Python sandbox is on (model uses python-pptx via
// run_python instead, which can embed matplotlib charts), available as
// the only PPTX path when sandbox is off.
registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_pptx',
			description:
				'Create a PowerPoint presentation. Each slide has a title and optional bullets (strings or {text, level} for nesting). Use layout "section" for divider slides. Optional per-slide image path from the working directory.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path for the new .pptx file.' },
					slides: SLIDE_SCHEMA
				},
				required: ['path', 'slides']
			}
		}
	},
	displayLabel: labelArg('path'),
	execute: writeExecutor('fs_write_pptx', (args) => ({ slides: args.slides }))
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_odp',
			description:
				'Create an OpenDocument Presentation (.odp) for LibreOffice Impress. Same API as fs_write_pptx. Only use when the user asks for ODP specifically.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path for the new .odp file.' },
					slides: SLIDE_SCHEMA
				},
				required: ['path', 'slides']
			}
		}
	},
	displayLabel: labelArg('path'),
	execute: writeExecutor('fs_write_odp', (args) => ({ slides: args.slides }))
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_download_url',
			description:
				'Download a file from a URL into the working directory. 50 MB limit. Executable formats are blocked.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'The HTTP(S) URL to download.' },
					path: {
						type: 'string',
						description:
							'Relative path (inside the working directory) where the downloaded file should be written. Include the file extension — it determines whether the download is allowed (e.g. images/hero.png is fine, installer.exe is blocked).'
					}
				},
				required: ['url', 'path']
			}
		}
	},
	displayLabel: (args) => {
		const path = (args.path as string) || '';
		const url = (args.url as string) || '';
		return path ? `${path} (${url})` : url;
	},
	async execute(args, ctx) {
		const url = args.url as string;
		const relPath = args.path as string;
		const resolved = await resolveWritePathInteractive(
			ctx.workingDir!,
			relPath,
			ctx.filesWrittenThisTurn
		);
		if (!resolved) return userCanceledWriteError(relPath, 'fs_download_url');
		try {
			const message = await invoke<string>('fs_download_url', {
				workdir: ctx.workingDir,
				url,
				relPath: resolved.finalPath,
				overwrite: resolved.overwrite
			});
			ctx.filesWrittenThisTurn.add(resolved.finalPath);
			let thumbDataUrl: string | undefined;
			if (IMAGE_EXT_RE.test(resolved.finalPath)) {
				try {
					thumbDataUrl = await invoke<string>('fs_read_image', {
						workdir: ctx.workingDir,
						relPath: resolved.finalPath
					});
				} catch {
					// Thumbnail is best-effort
				}
			}
			return { result: message, thumbDataUrl };
		} catch (e) {
			return toolResult(toolInvokeError('fs_download_url', e));
		}
	}
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_edit_text',
			description:
				'Edit a text file by replacing exactly one occurrence of old_str with new_str. The old_str must appear exactly once in the file — include enough surrounding context to make it unique. Use this for small targeted changes; for large rewrites use fs_write_text with overwrite.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Relative path to the file within the working directory.'
					},
					old_str: {
						type: 'string',
						description: 'The exact text to find and replace. Must be unique in the file.'
					},
					new_str: {
						type: 'string',
						description: 'The replacement text.'
					}
				},
				required: ['path', 'old_str', 'new_str']
			}
		}
	},
	displayLabel: labelArg('path'),
	async execute(args, ctx) {
		try {
			await invoke('fs_edit_text', {
				workdir: ctx.workingDir,
				relPath: args.path as string,
				oldStr: args.old_str as string,
				newStr: args.new_str as string
			});
			const diag = await lintPythonIfApplicable(ctx.workingDir, args.path as string);
			return toolResult(`Edited ${args.path}${diag}`);
		} catch (e) {
			return toolResult(toolInvokeError('fs_edit_text', e));
		}
	}
});
