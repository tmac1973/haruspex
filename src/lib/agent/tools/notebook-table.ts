/**
 * The notebook table tools: change a table or checklist card's rows and
 * columns a few at a time, never by rewriting the table. See `notebook.ts`.
 */
import { registerTool } from '#lib/agent/tools/registry.ts';
import type { RowOp } from '#lib/notebooks/api.ts';
import * as api from '#lib/notebooks/api.ts';
import { parseCell } from '#lib/notebooks/columns.ts';
import { columnId, parseCsv, splitHeader } from '#lib/notebooks/csv.ts';
import {
	cellsOf,
	checkCsvWidths,
	columnsFor,
	findColumn,
	parseUpdates,
	unknownColumn
} from '#lib/agent/tools/_notebookFormat.ts';
import {
	CARD_ARG,
	done,
	guard,
	sourceOf,
	str,
	writeCard
} from '#lib/agent/tools/_notebookShared.ts';

registerTool({
	category: 'notebooks',
	schema: {
		type: 'function',
		function: {
			name: 'notebook_table_rows',
			description:
				'Change rows of a table or checklist card without rewriting it. add_csv: rows to add at the end, as CSV with the header row; quote a value that has a comma. update: one line per row, "row_id: Column=value; Column=value", or JSON {"row_id": {"Column": "value"}} when a value has ";". delete: row ids, separated by commas. Checklists have the columns text and done.',
			parameters: {
				type: 'object',
				properties: {
					card: CARD_ARG,
					add_csv: { type: 'string' },
					update: { type: 'string' },
					delete: { type: 'string' }
				},
				required: ['card']
			}
		}
	},
	displayLabel: (args) => `Edit rows of ${str(args.card)}`,
	execute: (args, ctx) =>
		guard(async () => {
			const source = await sourceOf(ctx);
			let summary = '';
			const saved = await writeCard(str(args.card).trim(), async (card) => {
				if (card.kind !== 'table' && card.kind !== 'checklist') {
					throw new Error(`Card ${card.id} is a ${card.kind} card, not a table.`);
				}
				const cols = columnsFor(card);
				const ops: RowOp[] = [];
				const del = str(args.delete)
					.split(/[\s,]+/)
					.filter(Boolean);
				const updates = args.update;
				const hasUpdates =
					typeof updates === 'string'
						? updates.trim() !== ''
						: !!updates && typeof updates === 'object';
				if (hasUpdates) {
					const all = await api.getRows(card.id, 0, 5000);
					const current = new Map(all.map((r) => [r.id, cellsOf(r)]));
					ops.push(...parseUpdates(updates, cols, current));
				}
				for (const id of del) ops.push({ op: 'delete', row_id: id });
				const csv = str(args.add_csv);
				let added = 0;
				if (csv.trim()) {
					const [header, ...body] = parseCsv(csv);
					checkCsvWidths(header ?? [], body);
					const map = (header ?? []).map((h) => {
						const name = splitHeader(h).name;
						if (name.toLowerCase() === 'row_id') return null;
						const col = findColumn(cols, name);
						if (!col) throw unknownColumn(name, cols);
						return col;
					});
					for (const fields of body) {
						const cells: Record<string, unknown> = {};
						fields.forEach((f, i) => {
							const col = map[i];
							if (col && f.trim() !== '') cells[col.id] = parseCell(col, f);
						});
						ops.push({ op: 'add', after: null, cells: JSON.stringify(cells) });
						added++;
					}
				}
				if (ops.length === 0) throw new Error('Nothing to change: give add_csv, update or delete.');
				const updated = ops.filter((o) => o.op === 'update').length;
				summary = [
					added && `added ${added}`,
					updated && `updated ${updated}`,
					del.length && `deleted ${del.length}`
				]
					.filter(Boolean)
					.join(', ');
				return api.applyRows(card.id, card.version, ops, source);
			});
			return done(
				saved.notebook_id,
				[saved.id],
				`Card ${saved.id}: ${summary} rows; ${saved.row_count} rows now.`
			);
		})
});

registerTool({
	category: 'notebooks',
	schema: {
		type: 'function',
		function: {
			name: 'notebook_table_columns',
			description:
				'Change a table\'s columns. add: "Name:type" lines (types: text, number, currency, url, date, checkbox, status). rename: "Old=New" lines. retype: "Name:type" lines. remove: column names, one per line (their values go too).',
			parameters: {
				type: 'object',
				properties: {
					card: CARD_ARG,
					add: { type: 'string' },
					rename: { type: 'string' },
					retype: { type: 'string' },
					remove: { type: 'string' }
				},
				required: ['card']
			}
		}
	},
	displayLabel: (args) => `Edit columns of ${str(args.card)}`,
	execute: (args, ctx) =>
		guard(async () => {
			const source = await sourceOf(ctx);
			const saved = await writeCard(str(args.card).trim(), (card) => {
				if (card.kind !== 'table') throw new Error(`Card ${card.id} is not a table.`);
				const cols = columnsFor(card).map((c) => ({ ...c }));
				const lines = (v: unknown) =>
					str(v)
						.split(/\r?\n/)
						.map((l) => l.trim())
						.filter(Boolean);
				const taken = new Set(cols.map((c) => c.id));
				for (const l of lines(args.add)) {
					const { name, type } = splitHeader(l);
					if (findColumn(cols, name)) throw new Error(`There's already a column "${name}".`);
					cols.push({ id: columnId(name, taken), name, type: type ?? 'text' });
				}
				for (const l of lines(args.rename)) {
					const [from, to] = l.split('=').map((x) => x?.trim());
					const col = findColumn(cols, from ?? '');
					if (!col || !to) throw unknownColumn(from ?? l, cols);
					col.name = to;
				}
				for (const l of lines(args.retype)) {
					const { name, type } = splitHeader(l);
					const col = findColumn(cols, name);
					if (!col) throw unknownColumn(name, cols);
					if (!type) throw new Error(`"${l}" needs a type: Name:type.`);
					col.type = type;
				}
				const removed = new Set<string>();
				for (const l of lines(args.remove)) {
					const col = findColumn(cols, l);
					if (!col) throw unknownColumn(l, cols);
					removed.add(col.id);
				}
				return api.setColumns(
					card.id,
					card.version,
					cols.filter((c) => !removed.has(c.id)),
					source
				);
			});
			const cols = columnsFor(saved).map((c) => `${c.name}:${c.type}`);
			return done(saved.notebook_id, [saved.id], `Card ${saved.id} columns: ${cols.join(', ')}.`);
		})
});
