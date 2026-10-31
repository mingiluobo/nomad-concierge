import { z } from 'zod';
import { slotKeySchema } from './profile.js';
import { goalSchema } from './slots.js';
import { countryCodeSchema } from './countries.js';

export const planPhaseSchema = z.enum(['before', 'arrival', 'ongoing']);
export const planStepSchema = z.object({
  id: z.string(), goal: z.union([goalSchema, z.literal('general')]), title: z.string(), why: z.string(),
  materials: z.array(z.string()), dependsOn: z.array(z.string()), needsProfessional: z.boolean(),
  professionalNote: z.string().optional(), conditional: z.string().optional(),
});
export type PlanStep = z.infer<typeof planStepSchema>;
export const planContentSchema = z.object({
  schemaVersion: z.literal(1), title: z.string(), destination: countryCodeSchema,
  coverage: z.enum(['full', 'generic']), generatedAt: z.string(), generatedEarly: z.boolean(),
  profileSummary: z.object({
    known: z.array(z.object({ slot: slotKeySchema, label: z.string(), display: z.string() })),
    unknown: z.array(z.object({ slot: slotKeySchema, label: z.string() })),
    toConfirm: z.array(z.object({ slot: slotKeySchema.optional(), label: z.string(), reason: z.string() })),
  }),
  firstStepId: z.string(), phases: z.array(z.object({ phase: planPhaseSchema, label: z.string(), steps: z.array(planStepSchema) })),
  professionalBoundary: z.array(z.object({ topic: z.string(), conditions: z.array(z.string()), note: z.string() })),
  sources: z.array(z.object({ label: z.string(), url: z.string().url().optional(), note: z.string() })),
  disclaimer: z.string(),
});
export type PlanContent = z.infer<typeof planContentSchema>;
