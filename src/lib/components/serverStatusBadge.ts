/**
 * What the header status badge says: the model of the chat, session or job in
 * view, and for the Settings model, the state of its server.
 */
import type { ServerState, ServerStatusType } from '#lib/stores/llamaServer.svelte.ts';
import type { AppSettings } from '#lib/stores/settings.ts';
import type { ModelInView } from '#lib/stores/modelInView.svelte.ts';
import { localModelName, overrideModelLabel } from '#lib/code/backends.ts';

export interface StatusBadge {
	/** The `data-status` the badge styles its dot by. */
	status: ServerStatusType;
	label: string;
	title: string;
	/** What a click opens: the logs explain a local error, Settings fixes the rest. */
	opens: 'logs' | 'settings';
}

const SETTINGS = 'Click to open Settings → Inference.';
const LOGS = 'Click to open logs.';

export function statusBadge(
	view: ModelInView,
	state: ServerState,
	settings: AppSettings
): StatusBadge {
	if (view.kind === 'override') {
		const { label } = overrideModelLabel(view.backend);
		const whose = view.source === 'code' ? "This Code session's" : "This job's";
		return {
			status: 'remote',
			label,
			title: `${whose} own model, not Settings → Inference: ${label} (${view.backend.baseUrl}). ${SETTINGS}`,
			opens: 'settings'
		};
	}

	const name = localModelName(settings.activeLocalModelFilename);
	switch (state.status) {
		case 'ready':
			return {
				status: 'ready',
				label: `Ready · ${name}`,
				title: `Settings → Inference: ${name}, running locally. ${SETTINGS}`,
				opens: 'settings'
			};
		case 'starting':
			return {
				status: 'starting',
				label: `Starting · ${name}…`,
				title: `Settings → Inference: ${name}, starting. ${SETTINGS}`,
				opens: 'settings'
			};
		case 'error': {
			const label = `Error${state.errorMessage ? `: ${state.errorMessage}` : ''}`;
			return {
				status: 'error',
				label,
				title: `Settings → Inference: ${name}. ${label}. ${LOGS}`,
				opens: 'logs'
			};
		}
		case 'remote': {
			const where = state.remoteLabel ? ` · ${state.remoteLabel}` : '';
			const problem = state.remoteProblem;
			if (problem?.kind === 'missing') {
				return {
					status: 'error',
					label: `Model not found${where}`,
					title: `Settings → Inference: the server no longer lists ${problem.modelId || 'a model'}. ${SETTINGS}`,
					opens: 'settings'
				};
			}
			if (problem?.kind === 'unreachable') {
				return {
					status: 'error',
					label: `Unreachable${where}`,
					title: `Settings → Inference: the server did not answer (${problem.error}). ${SETTINGS}`,
					opens: 'settings'
				};
			}
			const label = `Remote${where}`;
			return {
				status: 'remote',
				label,
				title: `Settings → Inference: ${label}. ${SETTINGS}`,
				opens: 'settings'
			};
		}
		default:
			return {
				status: 'stopped',
				label: `Stopped · ${name}`,
				title: `Settings → Inference: ${name}, not running. ${SETTINGS}`,
				opens: 'settings'
			};
	}
}
