/**
 * A Code session's model. Null follows Settings → Inference; anything else is
 * a remote `BackendOverride`. Overrides are remote-only: the local model is
 * reached only through Settings, because only Settings starts llama-server.
 *
 * The session picks its model with the Jobs model picker, so the form here is
 * the Jobs form (`JobModelForm`), converted to and from the override.
 */
import type { BackendOverride } from '#lib/api.ts';
import type { AppSettings } from '#lib/stores/settings.ts';
import {
	emptyModelForm,
	isOpenRouterUrl,
	type JobModelForm
} from '#lib/agent/jobs/jobModelForm.ts';
import { folderName } from '#lib/code/sessionList.ts';

/** A URL's host, or the last path segment of something that isn't a URL. */
export function host(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return folderName(url);
	}
}

/** "Qwen3.5-9B-Q4_K_M.gguf" → "qwen3.5-9b". */
export function localModelName(filename: string): string {
	const name = filename
		.trim()
		.replace(/\.gguf$/i, '')
		.replace(/-(i?q\d[\w.]*|bf16|f16|f32)$/i, '')
		.toLowerCase();
	return name || 'local model';
}

/** The model Settings → Inference has active, in a few words. */
export function settingsModelName(settings: AppSettings): string {
	const inf = settings.inferenceBackend;
	if (inf.mode === 'remote' && inf.remoteBaseUrl.trim()) {
		return inf.remoteModelId.trim() || host(inf.remoteBaseUrl);
	}
	return localModelName(settings.activeLocalModelFilename);
}

/** An override's model and where it runs: "gpt-5 · OpenRouter", "qwen3 · box:8080". */
export function overrideModelLabel(backend: BackendOverride): { model: string; label: string } {
	const model = backend.modelId?.trim() || 'default';
	const kind = isOpenRouterUrl(backend.baseUrl) ? 'OpenRouter' : host(backend.baseUrl);
	return { model, label: `${model} · ${kind}` };
}

/** The header button's label and tooltip for a session's model. */
export function sessionModelLabel(
	backend: BackendOverride | null,
	settings: AppSettings
): { label: string; title: string } {
	if (!backend) {
		const inf = settings.inferenceBackend;
		const where =
			inf.mode === 'remote' && inf.remoteBaseUrl.trim()
				? inf.remoteBaseUrl.trim()
				: 'the local model';
		return {
			label: `Settings · ${settingsModelName(settings)}`,
			title: `Follows Settings → Inference (now ${where}). Click to change.`
		};
	}
	const { model, label } = overrideModelLabel(backend);
	return {
		label,
		title: `This session's model: ${model} on ${backend.baseUrl}. Click to change.`
	};
}

/** The picker's form for a session's backend. */
export function modelFormFromBackend(backend: BackendOverride | null): JobModelForm {
	const form = emptyModelForm();
	const url = backend?.baseUrl.trim();
	if (!backend || !url) return form;
	const d = backend.discovered;
	return {
		...form,
		source: isOpenRouterUrl(url) ? 'openrouter' : 'remote',
		baseUrl: url,
		apiKey: backend.apiKey ?? '',
		apiKeyId: backend.apiKeyId ?? null,
		modelId: backend.modelId ?? '',
		contextSize: backend.contextSize ?? '',
		vision: backend.visionSupported == null ? 'auto' : backend.visionSupported ? 'yes' : 'no',
		discovered: d ? { reasoning: d.reasoning ?? null, sampling: d.sampling ?? null } : null
	};
}

/**
 * The picker's form as the session's backend: null for the Settings model (or
 * a remote source with no server picked), an override otherwise. Holds the
 * same fields a job's override does.
 */
export function backendFromModelForm(form: JobModelForm): BackendOverride | null {
	const url = form.source === 'settings' ? '' : form.baseUrl.trim();
	if (!url) return null;
	return {
		baseUrl: url,
		apiKey: form.apiKey.trim() || undefined,
		apiKeyId: form.apiKeyId ?? undefined,
		modelId: form.modelId.trim() || undefined,
		contextSize: typeof form.contextSize === 'number' ? form.contextSize : undefined,
		visionSupported: form.vision === 'auto' ? undefined : form.vision === 'yes',
		discovered: form.discovered ?? undefined
	};
}
