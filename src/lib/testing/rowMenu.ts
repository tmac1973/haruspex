import { fireEvent, render, screen } from '@testing-library/svelte';
import RowMenuHost from '#lib/components/RowMenuHost.svelte';

/** Draws the shared row menu, as the root layout does. Call before rendering a list. */
export function renderRowMenuHost(): void {
	render(RowMenuHost);
}

/** Right-clicks `row` and picks `label` from the row menu that opens. */
export async function pickFromRowMenu(row: Element, label: string): Promise<void> {
	await fireEvent.contextMenu(row);
	await fireEvent.click(screen.getByRole('menuitem', { name: label }));
}
