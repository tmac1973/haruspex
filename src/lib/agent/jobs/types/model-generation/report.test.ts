import { describe, it, expect } from 'vitest';
import type { ModelSpec } from '#lib/models3d/spec/types.ts';
import { modelsReportPath, relativePath, renderModelReport } from './report';
import { initialEntryStates, type EntryState } from './state';

function spec(): ModelSpec {
	const entry = (id: string, title: string, clips: boolean) => ({
		id,
		title,
		description: `A ${id}.`,
		height_m: 1,
		parts: clips ? ['Hip_L'] : [],
		clips: clips ? [{ name: 'Walk', seconds: 1, loop: true, action: 'walks' }] : [],
		dir: `assets/generated/model/${id}/`
	});
	return {
		version: 1,
		style: '',
		entries: [
			entry('knight', 'Knight', true),
			entry('tree', 'Tree', false),
			entry('rock', 'Rock', false)
		]
	};
}

function states(s: ModelSpec): EntryState[] {
	const [knight, tree, rock] = initialEntryStates(s);
	return [
		{
			...knight,
			status: 'done',
			glb: true,
			sheet: 'data:',
			clips: { status: 'done', problems: [], rounds: 1, sheets: ['Walk'] }
		},
		{
			...tree,
			status: 'needs_work',
			glb: true,
			sheet: 'data:',
			problems: ['Height is 1.4 m; the spec says 1 m (±10%).'],
			warnings: ['2 meshes have no name.']
		},
		{ ...rock, status: 'skipped', note: null }
	];
}

describe('renderModelReport', () => {
	const s = spec();
	const md = renderModelReport({
		spec: s,
		states: states(s),
		reportPath: modelsReportPath('assets/haruspex-models.json'),
		createLabel: 'argon-4',
		animateLabel: 'ThinkingCap-3.8-27B'
	});

	it('names both models', () => {
		expect(md).toContain('Built on argon-4; animated on ThinkingCap-3.8-27B.');
	});

	it('has a row per model: done, needs work and skipped', () => {
		expect(md).toContain('| Knight | done | 1 m | Hip_L | Walk | — |');
		expect(md).toContain(
			'| Tree | needs work | 1 m | — | — | Height is 1.4 m; the spec says 1 m (±10%). |'
		);
		expect(md).toContain('| Rock | skipped | 1 m | — | — | — |');
	});

	it('links the sheets from the report’s folder', () => {
		expect(md).toContain('![Knight](generated/model/knight/sheet.png)');
		expect(md).toContain('![Knight — Walk](generated/model/knight/clip-walk.png)');
		expect(md).toContain('Model: [knight.glb](generated/model/knight/knight.glb)');
	});

	it('lists open problems and warnings', () => {
		expect(md).toContain('Open problems:\n\n- Height is 1.4 m');
		expect(md).toContain('Warnings:\n\n- 2 meshes have no name.');
	});
});

describe('paths', () => {
	it('puts the report beside the spec', () => {
		expect(modelsReportPath('plan/arena/models.json')).toBe('plan/arena/REPORT-models.md');
		expect(modelsReportPath('models.json')).toBe('REPORT-models.md');
	});

	it('walks up out of a plan folder', () => {
		expect(relativePath('plan/arena', 'assets/generated/model/a/sheet.png')).toBe(
			'../../assets/generated/model/a/sheet.png'
		);
		expect(relativePath('', 'assets/a.png')).toBe('assets/a.png');
	});
});
