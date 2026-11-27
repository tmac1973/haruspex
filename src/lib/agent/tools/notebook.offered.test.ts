import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import '#lib/agent/tools/index.ts';
import { getToolSchemas, type ToolSchemaOpts } from '#lib/agent/tools/registry.ts';
import { getSettings, updateSettings } from '#lib/stores/settings.ts';

const before = { notebooksTab: getSettings().notebooksTab, leanMode: getSettings().leanMode };
afterEach(() => updateSettings(before));

/** The notebook tools a job turn (not interactive, nobody asking) is offered. */
function jobTurnNotebookTools(over: Partial<ToolSchemaOpts> = {}): string[] {
	return getToolSchemas({
		hasWorkingDir: false,
		deepResearch: false,
		visionSupported: true,
		interactive: false,
		...over
	} as ToolSchemaOpts)
		.map((s) => s.function.name)
		.filter((n) => n.startsWith('notebook_'));
}

describe('notebook tools in a job turn', () => {
	it('are offered while the Notebooks tab is on, with or without Deep research', () => {
		updateSettings({ notebooksTab: true, leanMode: false });
		expect(jobTurnNotebookTools()).toEqual(
			expect.arrayContaining(['notebook_create', 'notebook_add_card', 'notebook_table_rows'])
		);
		expect(jobTurnNotebookTools({ deepResearch: true })).toContain('notebook_create');
	});

	it('are not offered with the tab off, or in lean mode', () => {
		updateSettings({ notebooksTab: false, leanMode: false });
		expect(jobTurnNotebookTools()).toEqual([]);
		updateSettings({ notebooksTab: true, leanMode: true });
		expect(jobTurnNotebookTools()).toEqual([]);
	});
});
