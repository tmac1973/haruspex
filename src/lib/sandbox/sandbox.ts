import { WorkerManager, type RunOptions } from './worker-manager';
import type { ToolResult } from './protocol';

let manager: WorkerManager | null = null;

function getManager(): WorkerManager {
	if (!manager) manager = new WorkerManager();
	return manager;
}

export function runPython(code: string, opts?: RunOptions): Promise<ToolResult> {
	return getManager().runPython(code, opts);
}

export function installPackage(packageName: string, opts?: RunOptions): Promise<ToolResult> {
	return getManager().installPackage(packageName, opts);
}

export function resetSandbox(): Promise<void> {
	return getManager().reset();
}

// Test seam: replace the singleton manager so tests can inject a mocked
// worker factory. Production code should never call this.
export function __setManagerForTesting(next: WorkerManager | null): void {
	manager = next;
}

export type { Artifact, ToolResult } from './protocol';
export type { RunOptions };
