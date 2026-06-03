import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { glob } from "astro/loaders";

const foundations = defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/foundations'}),
    schema: z.object({
        title: z.string(),
        status: z.enum(['live', 'built', 'building']),
        summary: z.string(),
        couldBecome: z.array(z.string()),
        order: z.number(),
    })
});

const projects = defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/projects'}),
    schema: z.object({
        title: z.string(),
        domain: z.string(),
        description: z.string(),
        stack: z.array(z.string()),
        order: z.number(),
    }),
});

export const collections = { foundations, projects };