import { CHART_TYPES, SLIDE_LAYOUTS } from '#lib/slides/types.ts';

/** The `slides` parameter of `fs_write_slides` (.pptx and .odp): one object
 *  per slide. Every character here is in every Chat turn with a working
 *  folder, so descriptions stay short (see the budget in fs-write.test.ts). */
export const SLIDE_SCHEMA = {
	type: 'array' as const,
	description: 'One object per slide.',
	items: {
		type: 'object' as const,
		properties: {
			title: { type: 'string' as const, description: 'Short title (~8 words).' },
			layout: {
				type: 'string' as const,
				enum: [...SLIDE_LAYOUTS],
				description:
					'content (default): bullets, optional image. cover: the opening slide. section: a divider. two-column: bullets left, right on the right. image: the image fills the slide. quote: title is the quote, subtitle who said it. stat: title is a number, subtitle what it means.'
			},
			subtitle: {
				type: 'string' as const,
				description: 'Line under a cover, section or image title.'
			},
			bullets: {
				type: 'array' as const,
				description:
					'Phrases of a few words, not sentences. Strings, or {"text", "level": 0-2} for nested bullets.',
				items: {
					oneOf: [
						{ type: 'string' as const },
						{
							type: 'object' as const,
							properties: {
								text: { type: 'string' as const },
								level: { type: 'integer' as const, minimum: 0, maximum: 2 }
							},
							required: ['text']
						}
					]
				}
			},
			right: {
				type: 'array' as const,
				description: 'two-column: the right column.',
				items: { type: 'string' as const }
			},
			image: {
				type: 'string' as const,
				description: 'Image path in the working directory (png/jpg/gif).'
			},
			chart: {
				type: 'object' as const,
				description:
					'A chart, beside any bullets. One value per label in each series; a pie has one series.',
				properties: {
					type: { type: 'string' as const, enum: [...CHART_TYPES] },
					labels: { type: 'array' as const, items: { type: 'string' as const } },
					series: {
						type: 'array' as const,
						items: {
							type: 'object' as const,
							properties: {
								name: { type: 'string' as const },
								values: { type: 'array' as const, items: { type: 'number' as const } }
							}
						}
					}
				}
			},
			table: {
				type: 'array' as const,
				description: 'A table instead: rows of cells, header first.',
				items: { type: 'array' as const, items: { type: 'string' as const } }
			},
			notes: { type: 'string' as const, description: 'Speaker notes.' }
		},
		required: ['title']
	}
};
