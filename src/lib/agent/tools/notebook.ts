/**
 * Notebook tools: list, read, search, make and change the user's notebooks
 * (the Notebooks tab). A deferred family in Chat and the Code tab, always
 * there in Shell, never in lean mode or with the Notebooks tab off.
 *
 * Built for small models: flat arguments, tables in and out as CSV with a
 * `row_id` column, short ids to quote back, and row-level edits so changing
 * one price never means rewriting the table. Every change is stamped with
 * where it came from (`#lib/notebooks/source.ts`), so the card's badge links
 * back and its History can undo it.
 */
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { runCardForAgent } from '#lib/agent/tools/_notebookPython.ts';
import * as api from '#lib/notebooks/api.ts';
import { getSettings } from '#lib/stores/settings.ts';
import {
	PAGE_ROWS,
	cardFull,
	cardOutline,
	checklistRows,
	tableFromCsv
} from '#lib/agent/tools/_notebookFormat.ts';
import {
	CARD_ARG,
	NOTEBOOK_ARG,
	done,
	guard,
	resolveNotebook,
	sourceOf,
	str,
	writeCard
} from '#lib/agent/tools/_notebookShared.ts';

/** Every notebook tool, in the order they are registered. */
export const NOTEBOOK_TOOLS = [
	'notebook_list',
	'notebook_read',
	'notebook_search',
	'notebook_create',
	'notebook_add_card',
	'notebook_edit_card',
	'notebook_table_rows',
	'notebook_table_columns',
	'notebook_move_card',
	'notebook_delete_card'
];

registerTool({
	category: 'notebooks',
	schema: {
		type: 'function',
		function: {
			name: 'notebook_list',
			description:
				"List the user's notebooks (the Notebooks tab): id, title, tags, card count, last edited.",
			parameters: {
				type: 'object',
				properties: { tag: { type: 'string', description: 'Only notebooks with this tag.' } }
			}
		}
	},
	displayLabel: () => 'Notebooks',
	execute: (args) =>
		guard(async () => {
			const tag = str(args.tag).trim();
			const list = (await api.listNotebooks())
				.filter((n) => !tag || n.tags.includes(tag))
				.slice(0, 50);
			if (list.length === 0)
				return toolResult(tag ? `No notebooks tagged "${tag}".` : 'No notebooks yet.');
			return toolResult(
				list
					.map(
						(n) =>
							`${n.id} · ${n.title}${n.pinned ? ' (pinned)' : ''}${n.tags.length ? ` · tags: ${n.tags.join(', ')}` : ''} · ${n.card_count} cards · edited ${new Date(n.updated_at).toLocaleString()}`
					)
					.join('\n')
			);
		})
});

registerTool({
	category: 'notebooks',
	schema: {
		type: 'function',
		function: {
			name: 'notebook_read',
			description:
				'Read a notebook. Without card: an outline of every card (text starts, the first rows of tables as CSV). With card: that card in full; tables come as CSV with a row_id column, 100 rows at a time.',
			parameters: {
				type: 'object',
				properties: {
					notebook: NOTEBOOK_ARG,
					card: CARD_ARG,
					offset: { type: 'number', description: 'Table rows: start here (0 first).' },
					limit: { type: 'number', description: 'Table rows: how many (at most 100).' }
				},
				required: ['notebook']
			}
		}
	},
	displayLabel: (args) => `Read notebook ${str(args.notebook)}`,
	execute: (args) =>
		guard(async () => {
			const nb = await resolveNotebook(str(args.notebook));
			const detail = await api.getNotebook(nb.id);
			const cardId = str(args.card).trim();
			if (cardId) {
				const card = detail.cards.find((c) => c.id === cardId);
				if (!card) throw new Error(`No card ${cardId} in "${nb.title}".`);
				const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
				const limit = Math.min(PAGE_ROWS, Math.max(1, Math.floor(Number(args.limit) || PAGE_ROWS)));
				return toolResult(await cardFull(card, offset, limit));
			}
			const head = `Notebook "${nb.title}" (id ${nb.id})${nb.tags.length ? ` · tags: ${nb.tags.join(', ')}` : ''} · link: [${nb.title}](notebook:${nb.id})`;
			const cards = detail.cards.map(cardOutline);
			return toolResult([head, cards.length ? cards.join('\n\n') : '(no cards yet)'].join('\n\n'));
		})
});

registerTool({
	category: 'notebooks',
	schema: {
		type: 'function',
		function: {
			name: 'notebook_search',
			description:
				"Search every notebook's titles, text, table cells and file names. Returns where each match is.",
			parameters: {
				type: 'object',
				properties: { query: { type: 'string', description: 'Words to look for.' } },
				required: ['query']
			}
		}
	},
	displayLabel: (args) => `Search notebooks: ${str(args.query)}`,
	execute: (args) =>
		guard(async () => {
			const hits = await api.search(
				str(args.query),
				getSettings().notebooks?.semanticSearch ?? false,
				20
			);
			if (hits.length === 0) return toolResult('No matches.');
			return toolResult(
				hits
					.map((h) => {
						const where = h.card_id
							? `card ${h.card_id}${h.card_title ? ` "${h.card_title}"` : ''}${h.row_id ? `, row ${h.row_id}` : ''}`
							: 'title';
						return `${h.notebook_title} (${h.notebook_id}) · ${where} · ${h.snippet.replace(/\[\[|\]\]/g, '')}`;
					})
					.join('\n')
			);
		})
});

registerTool({
	category: 'notebooks',
	schema: {
		type: 'function',
		function: {
			name: 'notebook_create',
			description:
				'Make a new notebook. Then add cards with notebook_add_card. Link it in your reply as [title](notebook:<id>).',
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string', description: 'Its title.' },
					tags: { type: 'string', description: 'Tags, separated by commas.' }
				},
				required: ['title']
			}
		}
	},
	displayLabel: (args) => `New notebook: ${str(args.title)}`,
	execute: (args) =>
		guard(async () => {
			const tags = str(args.tags)
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean);
			const nb = await api.createNotebook(str(args.title), tags);
			return done(
				nb.id,
				[],
				`Made notebook "${nb.title}", id ${nb.id}. Link: [${nb.title}](notebook:${nb.id})`
			);
		})
});

registerTool({
	category: 'notebooks',
	schema: {
		type: 'function',
		function: {
			name: 'notebook_add_card',
			description:
				'Add a card to a notebook. kind text: give text (Markdown, links allowed). kind table: give csv with a header row; a header may name its type as Name:type (text, number, currency, url, date, checkbox, status). kind checklist: give items, one per line, "[x] " in front of done ones. kind python: give code; it runs once (the notebook tables are pandas DataFrames in tables["Title"]; leave a DataFrame in result to offer it as a table). kind attachment or image: give path to a file.',
			parameters: {
				type: 'object',
				properties: {
					notebook: NOTEBOOK_ARG,
					kind: {
						type: 'string',
						enum: ['text', 'table', 'checklist', 'python', 'attachment', 'image']
					},
					title: { type: 'string', description: "The card's title." },
					text: { type: 'string', description: 'kind text: the Markdown.' },
					csv: { type: 'string', description: 'kind table: CSV with a header row.' },
					items: { type: 'string', description: 'kind checklist: one item per line.' },
					code: { type: 'string', description: 'kind python: the Python code.' },
					path: {
						type: 'string',
						description:
							'kind attachment or image: a file in the working folder (a full path in the Shell tab).'
					},
					image: {
						type: 'string',
						description: 'kind image: a haruspex-img:// URL from an image tool, instead of path.'
					},
					file: {
						type: 'string',
						description:
							'kind attachment or image: the hash of a document the user dropped in this chat, instead of path.'
					},
					after: { type: 'string', description: 'Put it after this card id; omit for the end.' }
				},
				required: ['notebook', 'kind']
			}
		}
	},
	displayLabel: (args) => `Add ${str(args.kind)} card to ${str(args.notebook)}`,
	execute: (args, ctx) =>
		guard(async () => {
			const nb = await resolveNotebook(str(args.notebook));
			const kind = str(args.kind) as api.CardKind;
			const card: api.NewCard = { kind, title: str(args.title), body: '', meta: '{}', rows: null };
			if (kind === 'text') {
				card.body = str(args.text);
			} else if (kind === 'table') {
				const t = tableFromCsv(str(args.csv));
				card.meta = t.meta;
				card.rows = t.rows;
			} else if (kind === 'checklist') {
				card.rows = checklistRows(str(args.items));
			} else if (kind === 'python') {
				card.body = str(args.code);
				if (!card.body.trim()) throw new Error('Give code for a python card.');
			} else if (kind === 'attachment' || kind === 'image') {
				const file = await fileForCard(args, ctx);
				card.meta = JSON.stringify(file);
				if (!card.title) card.title = file.name.replace(/\.[^.]+$/, '');
			} else {
				throw new Error(`Unknown kind "${kind}".`);
			}
			const source = await sourceOf(ctx);
			const added = await api.addCard(nb.id, card, source, str(args.after) || null);
			const what = kind === 'table' || kind === 'checklist' ? ` with ${added.row_count} rows` : '';
			// The rows with their ids, so a later change names real ones.
			const rows = kind === 'table' || kind === 'checklist' ? `\n${cardOutline(added)}` : '';
			const ran = kind === 'python' ? `\n${await runCardForAgent(added, ctx, source)}` : '';
			return done(
				nb.id,
				[added.id],
				`Added ${kind} card ${added.id}${what} to "${nb.title}". Link: [${nb.title}](notebook:${nb.id}#${added.id})${rows}${ran}`
			);
		})
});

/** The file an attachment or image card keeps: a path, a dropped document's hash, or a picture. */
async function fileForCard(
	args: Record<string, unknown>,
	ctx: ToolContext
): Promise<api.NotebookFile> {
	const hash = str(args.file).trim();
	if (hash) {
		const { droppedFile } = await import('#lib/notebooks/droppedFiles.ts');
		const file = droppedFile(hash);
		if (!file) throw new Error('No dropped file with that hash in this session.');
		return file;
	}
	const image = str(args.image).trim();
	if (image) {
		const m = /([0-9a-f]{64})/.exec(image);
		if (!m) throw new Error('image must be a haruspex-img:// URL.');
		return api.fileFromImage(m[1]);
	}
	const path = str(args.path).trim();
	if (!path) throw new Error('Give path, file or image for an attachment or image card.');
	return api.storeFileForAgent(ctx.shellMode ? null : (ctx.workingDir ?? null), path);
}

registerTool({
	category: 'notebooks',
	schema: {
		type: 'function',
		function: {
			name: 'notebook_edit_card',
			description:
				"Change a card: its title, a text card's Markdown (text replaces it, append_text adds to the end), or a python card's code (it runs again). For table rows use notebook_table_rows.",
			parameters: {
				type: 'object',
				properties: {
					card: CARD_ARG,
					title: { type: 'string' },
					text: { type: 'string', description: 'Text cards: the new Markdown, whole.' },
					append_text: { type: 'string', description: 'Text cards: Markdown to add at the end.' },
					code: { type: 'string', description: 'Python cards: the new code, whole.' }
				},
				required: ['card']
			}
		}
	},
	displayLabel: (args) => `Edit card ${str(args.card)}`,
	execute: (args, ctx) =>
		guard(async () => {
			const source = await sourceOf(ctx);
			const saved = await writeCard(str(args.card).trim(), (card) => {
				const patch: { title?: string; body?: string } = {};
				if (args.title !== undefined) patch.title = str(args.title);
				const text = args.text !== undefined ? str(args.text) : null;
				const append = args.append_text !== undefined ? str(args.append_text) : null;
				if ((text !== null || append !== null) && card.kind !== 'text') {
					throw new Error(`Card ${card.id} is a ${card.kind} card; only text cards take text.`);
				}
				if (text !== null) patch.body = text;
				if (args.code !== undefined) {
					if (card.kind !== 'python') {
						throw new Error(`Card ${card.id} is a ${card.kind} card; only python cards take code.`);
					}
					patch.body = str(args.code);
				}
				if (append !== null) patch.body = `${(patch.body ?? card.body).trimEnd()}\n\n${append}`;
				if (patch.title === undefined && patch.body === undefined) {
					throw new Error('Nothing to change: give title, text, append_text or code.');
				}
				return api.updateCard(card.id, card.version, patch, source);
			});
			const ran =
				saved.kind === 'python' && args.code !== undefined
					? `\n${await runCardForAgent(saved, ctx, source)}`
					: '';
			return done(saved.notebook_id, [saved.id], `Changed card ${saved.id}.${ran}`);
		})
});

registerTool({
	category: 'notebooks',
	schema: {
		type: 'function',
		function: {
			name: 'notebook_move_card',
			description: 'Move a card: after another card, or to the start when after is omitted.',
			parameters: {
				type: 'object',
				properties: { card: CARD_ARG, after: { type: 'string', description: 'A card id.' } },
				required: ['card']
			}
		}
	},
	displayLabel: (args) => `Move card ${str(args.card)}`,
	execute: (args) =>
		guard(async () => {
			const card = await api.getCard(str(args.card).trim());
			await api.moveCard(card.id, str(args.after).trim() || null);
			return done(card.notebook_id, [card.id], `Moved card ${card.id}.`);
		})
});

registerTool({
	category: 'notebooks',
	schema: {
		type: 'function',
		function: {
			name: 'notebook_delete_card',
			description: 'Delete a card. It goes to the Notebooks Trash, where the user can restore it.',
			parameters: { type: 'object', properties: { card: CARD_ARG }, required: ['card'] }
		}
	},
	displayLabel: (args) => `Delete card ${str(args.card)}`,
	execute: (args) =>
		guard(async () => {
			const card = await api.getCard(str(args.card).trim());
			await api.deleteCard(card.id);
			return done(card.notebook_id, [card.id], `Moved card ${card.id} to Trash.`);
		})
});
