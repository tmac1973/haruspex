import { loadImages } from '#lib/slides/images.ts';
import type { DocumentOptions } from '#lib/documents/looks.ts';
import { documentModel, modelImages } from '#lib/documents/model.ts';
import { buildDocx } from '#lib/documents/docx.ts';
import { buildOdt } from '#lib/documents/odt.ts';

/**
 * The Word or LibreOffice file of `markdown`, its pictures read from
 * `workdir`. Throws a message the model can act on when a picture can't be
 * read: nothing is written.
 */
export async function officeFromMarkdown(
	workdir: string,
	markdown: string,
	format: 'docx' | 'odt',
	options: DocumentOptions
): Promise<Uint8Array> {
	const tree = documentModel(markdown);
	const images = await loadImages(workdir, modelImages(tree));
	return format === 'docx' ? buildDocx(tree, images, options) : buildOdt(tree, images, options);
}
