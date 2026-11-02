import { describe, expect, it, vi } from 'vitest';
import {
	keepKnownIds,
	parseModelJson,
	pickWithRetry,
	validate,
	type ResultSchema
} from './cardResult';

const schema: ResultSchema = { idField: 'id', fields: { why: 'string' }, max: 2 };

describe('parseModelJson', () => {
	it('reads JSON in a code fence, with prose around it', () => {
		const text = 'Here you go:\n```json\n{"items":[{"id":"a","why":"from {boss}"}]}\n```\nDone.';
		expect(parseModelJson(text)).toEqual({ items: [{ id: 'a', why: 'from {boss}' }] });
	});

	it('says what is wrong with a reply that has no usable JSON', () => {
		expect(() => parseModelJson('Nothing important today.')).toThrow(/no JSON object/);
		expect(() => parseModelJson('{"items": [')).toThrow(/not closed/);
		expect(() => parseModelJson('{"items": [,]}')).toThrow(/doesn't parse/);
	});
});

describe('validate', () => {
	it('removes extra fields and cuts to max', () => {
		const out = validate(
			{
				items: [
					{ id: 'a', why: 'boss', subject: 'made up' },
					{ id: 'b', why: 'invoice' },
					{ id: 'c', why: 'third' }
				]
			},
			schema
		);
		expect(out).toEqual({
			items: [
				{ id: 'a', why: 'boss' },
				{ id: 'b', why: 'invoice' }
			]
		});
	});

	it('refuses a missing id, a wrong field type, or no items array', () => {
		expect(() => validate({ items: [{ why: 'x' }] }, schema)).toThrow(/has no "id"/);
		expect(() => validate({ items: [{ id: 'a', why: 3 }] }, schema)).toThrow(/must be a string/);
		expect(() => validate([], schema)).toThrow(/"items" array/);
	});
});

describe('keepKnownIds', () => {
	it('drops ids that are not candidates', () => {
		const out = keepKnownIds([{ id: 'a' }, { id: 'zz' }], 'id', new Set(['a', 'b']));
		expect(out).toEqual({ items: [{ id: 'a' }], dropped: 1 });
	});
});

describe('pickWithRetry', () => {
	const known = new Set(['a', 'b']);
	const reply = (finalText: string) => ({ finalText, rawText: finalText });

	it('keeps a good first reply, minus invented ids', async () => {
		const runJobTurn = vi.fn(async () =>
			reply('{"items":[{"id":"a","why":"boss"},{"id":"x","why":"?"}]}')
		);
		const out = await pickWithRetry(
			{ runJobTurn },
			{ userMessage: 'pick', contextSize: 8192 },
			schema,
			known
		);
		expect(out).toEqual({ items: [{ id: 'a', why: 'boss' }], dropped: 1 });
		expect(runJobTurn).toHaveBeenCalledTimes(1);
	});

	it('tries once more, quoting the error, then gives up', async () => {
		const runJobTurn = vi
			.fn()
			.mockResolvedValueOnce(reply('not json'))
			.mockResolvedValueOnce(reply('{"items":[{"id":"b","why":"invoice"}]}'));
		const out = await pickWithRetry(
			{ runJobTurn },
			{ userMessage: 'pick', contextSize: 8192 },
			schema,
			known
		);
		expect(out.items).toEqual([{ id: 'b', why: 'invoice' }]);
		expect(runJobTurn.mock.calls[1][0].userMessage).toMatch(/^pick\n\nYour last reply .*no JSON/);

		const failing = vi.fn(async () => reply('{"items":[{"id":"a"}]}'));
		await expect(
			pickWithRetry(
				{ runJobTurn: failing },
				{ userMessage: 'pick', contextSize: 8192 },
				schema,
				known
			)
		).rejects.toThrow(/"why" must be a string/);
		expect(failing).toHaveBeenCalledTimes(2);
	});
});
