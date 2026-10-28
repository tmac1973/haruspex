/**
 * The Code tab's session controls beyond sending (#744): close, delete,
 * fork and rename a session, its effort and model, and stopping one of its
 * background processes. Each does what the tab's own control does, in the
 * window that has the session; a saved session no window has open can be
 * renamed and deleted from the main window.
 */
import type { BackendOverride } from '#lib/api.ts';
import { updateCodeSessionMeta } from '#lib/code/db.ts';
import { KNOWN_EFFORT_LEVELS } from '#lib/inference/descriptor.ts';
import {
	closeSession,
	deleteSession,
	forkSession,
	getOpenSessions,
	type CodeSession
} from '#lib/stores/code.svelte.ts';
import type { SessionOp, SessionModel } from '#lib/engine/types.ts';

function open(id: string): CodeSession | undefined {
	return getOpenSessions().find((s) => s.id === id);
}

function mustBeOpen(id: string): CodeSession {
	const s = open(id);
	if (!s) throw new Error(`session ${id} is not open: open it first (session.open)`);
	return s;
}

/**
 * A model as `session.model` takes it: a server and model, with its key
 * from Settings → Inference → API Keys by id. Null follows Settings.
 */
function backendOf(model: SessionModel | null): BackendOverride | null {
	if (model === null) return null;
	if ('apiKey' in (model as object)) {
		throw new Error(
			'a session takes its API key from Settings → Inference → API Keys: send apiKeyId'
		);
	}
	const baseUrl = typeof model.baseUrl === 'string' ? model.baseUrl.trim().replace(/\/+$/, '') : '';
	if (!/^https?:\/\//i.test(baseUrl))
		throw new Error('model.baseUrl is a server address (http://…)');
	return {
		baseUrl,
		...(model.apiKeyId && { apiKeyId: model.apiKeyId }),
		...(model.modelId?.trim() && { modelId: model.modelId.trim() }),
		...(typeof model.contextSize === 'number' && { contextSize: model.contextSize }),
		...(typeof model.visionSupported === 'boolean' && { visionSupported: model.visionSupported })
	};
}

export async function dispatchSession(op: SessionOp): Promise<unknown> {
	switch (op.type) {
		case 'session.close': {
			if (!open(op.id)) return { closed: false };
			await closeSession(op.id);
			return { closed: true };
		}
		case 'session.delete': {
			// Its worktree, if it has one, stays: remove it in the Code tab's sidebar.
			const done = await deleteSession(op.id);
			if (!done) throw new Error('that session is open in its own window: close it there first');
			return { deleted: op.id };
		}
		case 'session.fork': {
			const fork = await forkSession(op.id, op.index, op.mode ?? 'readOnly');
			return { id: fork.id, prefill: fork.prefill.text };
		}
		case 'session.rename': {
			const title = op.title.trim();
			if (!title) throw new Error('a session needs a title');
			const s = open(op.id);
			if (s) await s.rename(title);
			else await updateCodeSessionMeta(op.id, { title });
			return { renamed: op.id };
		}
		case 'session.effort': {
			const s = mustBeOpen(op.id);
			if (op.effort !== null && !KNOWN_EFFORT_LEVELS.includes(op.effort)) {
				throw new Error(
					`effort is one of ${KNOWN_EFFORT_LEVELS.join(', ')}, or null for Settings'`
				);
			}
			await s.setEffort(op.effort);
			return { effort: op.effort };
		}
		case 'session.model': {
			const s = mustBeOpen(op.id);
			await s.setBackend(backendOf(op.model));
			return { model: s.backend };
		}
		case 'session.stopBackground': {
			const s = mustBeOpen(op.id);
			if (!s.background.some((p) => p.id === op.processId)) {
				throw new Error(`session ${op.id} has no background process ${op.processId}`);
			}
			await s.stopBackground(op.processId);
			return { stopped: op.processId };
		}
		default:
			throw new Error(`unknown operation ${(op as { type?: string }).type}`);
	}
}
