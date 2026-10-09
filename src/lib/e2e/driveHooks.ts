/**
 * What `scripts/drive.mjs` reads from the real app through WebDriver: the
 * agent debug log, the Code tab's sessions, the pending command approval, and
 * the remote-server probe the Settings form runs. It also switches the active
 * session and settings; everything a user would press, the driver presses in
 * the UI instead.
 *
 * Installed by `src/hooks.client.ts` only when the build was made with
 * `VITE_HARUSPEX_E2E=1`, which `e2e/app/build.mjs` sets. The check is a
 * build-time constant, so a normal build drops this module entirely.
 */
import { invoke } from '@tauri-apps/api/core';

import type { SearchStep } from '#lib/agent/loop.ts';
import { editDiffFromStep, type FileDiff } from '#lib/code/diff.ts';
import { getDebugLogs, setVerbosePayloads } from '#lib/debug-log.ts';
import { pickProbedModel, probedModelCaps, type ProbeResult } from '#lib/inferenceProbe.ts';
import { getOpenSessions, setActiveSession } from '#lib/stores/code.svelte.ts';
import { getPendingCommandApproval } from '#lib/stores/codeCommandApproval.svelte.ts';
import {
	updateSettings,
	type AppSettings,
	type InferenceBackendConfig
} from '#lib/stores/settings.ts';

export interface DriveHooks {
	debugLogs: () => string[];
	setVerbosePayloads: (on: boolean) => void;
	codeSessions: () => unknown[];
	/** Show this session's pane, so its input box and Stop button exist. */
	activateSession: (id: string) => void;
	/** The command waiting for Run this command?, if any. One at a time, app-wide. */
	pendingApproval: () => { command: string; reasons: string[] } | null;
	updateSettings: (patch: Partial<AppSettings>) => void;
	probeRemote: (
		baseUrl: string,
		apiKey: string,
		modelId: string | null
	) => Promise<Partial<InferenceBackendConfig>>;
}

declare global {
	interface Window {
		__haruspexDrive?: DriveHooks;
	}
}

/**
 * The remote settings Settings → Inference → Test connection would save for
 * this server: the same probe, model pick and capabilities.
 */
async function probeRemote(
	baseUrl: string,
	apiKey: string,
	modelId: string | null
): Promise<Partial<InferenceBackendConfig>> {
	const result = await invoke<ProbeResult>('probe_inference_server', {
		baseUrl,
		apiKey: apiKey || null
	});
	const model = pickProbedModel(result.models, modelId);
	if (!model) throw new Error(`${result.base_url} lists no models`);
	if (modelId && model.id !== modelId) {
		throw new Error(
			`${result.base_url} has no model ${modelId}; it has ${result.models.map((m) => m.id).join(', ')}`
		);
	}
	const caps = probedModelCaps(model);
	return {
		mode: 'remote',
		remoteBaseUrl: result.base_url,
		remoteServerUrls: [result.base_url],
		remoteApiKey: apiKey,
		remoteApiKeyId: null,
		remoteModelId: model.id,
		remoteContextSize: caps.contextSize ?? result.default_context_size ?? null,
		remoteVisionSupported: caps.vision,
		remoteBackendKind: result.kind,
		remoteSampling: model.sampling ?? null,
		remoteReasoning: model.reasoning ?? null,
		remoteParallel: model.parallel ?? null
	};
}

/** The diff card a step shows, worked out as `CodeSteps.svelte` does. */
function stepDiff(step: SearchStep): FileDiff | null {
	if (step.status !== 'done') return null;
	if (step.toolName === 'fs_edit_text') return editDiffFromStep(step);
	if (step.toolName === 'fs_write_text') return step.fileDiff ?? null;
	return null;
}

const withDiffs = (steps: SearchStep[]) => steps.map((s) => ({ ...s, diff: stepDiff(s) }));

export function installDriveHooks(): void {
	window.__haruspexDrive = {
		debugLogs: getDebugLogs,
		setVerbosePayloads,
		// Through JSON: plain data, whatever WebDriver makes of a proxy.
		codeSessions: () =>
			JSON.parse(
				JSON.stringify(
					getOpenSessions().map((s) => {
						const thread = s.snapshot();
						return {
							id: s.id,
							root: s.root,
							title: s.title,
							status: s.status,
							lastError: s.lastError,
							saveError: s.saveError,
							streamingContent: s.streamingContent,
							usage: s.usage,
							...thread,
							searchSteps: withDiffs(s.searchSteps),
							messageSteps: Object.fromEntries(
								Object.entries(thread.messageSteps).map(([i, steps]) => [i, withDiffs(steps)])
							)
						};
					})
				)
			),
		activateSession: setActiveSession,
		pendingApproval: () => {
			const p = getPendingCommandApproval();
			return p ? { command: p.command, reasons: p.reasons.map((r) => r.label) } : null;
		},
		updateSettings,
		probeRemote
	};
}
