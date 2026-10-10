/**
 * The sandbox step's Cancel and Run again, for `SearchStep`. The chat store
 * owns sandbox runs and fills these in as it loads; `SearchStep` calls
 * through here rather than importing the store, which would put the whole
 * agent (the PDF renderer, the Python worker) in every bundle that shows a
 * step, the web client's included. Where no chat store has loaded they do
 * nothing, and the web client hides them anyway.
 */
export interface SandboxRunControls {
	rerun: (stepId: string) => void;
	cancel: () => void;
}

let controls: SandboxRunControls | null = null;

export function setSandboxRunControls(c: SandboxRunControls | null): void {
	controls = c;
}

export function rerunSandboxStep(stepId: string): void {
	controls?.rerun(stepId);
}

export function cancelSandboxRun(): void {
	controls?.cancel();
}
