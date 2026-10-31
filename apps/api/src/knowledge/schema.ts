import { z } from 'zod';
import { goalSchema, incomeSourceSchema, schoolPreferenceSchema } from '@nomad/shared';

export const knowledgeStepSchema = z.object({
  id: z.string().min(1), goal: z.union([goalSchema, z.literal('general')]), phase: z.enum(['before', 'arrival', 'ongoing']),
  priority: z.number().int().nonnegative(), title: z.string().min(1), why: z.string().min(1), materials: z.array(z.string().min(1)),
  dependsOn: z.array(z.string().min(1)),
  when: z.object({ applicantGroup: z.enum(['eu', 'non_eu']).optional(), partnerGroup: z.enum(['eu', 'non_eu', 'portugal']).optional(),
    hasPartner: z.boolean().optional(), hasChildren: z.boolean().optional(), incomeSourceIn: z.array(incomeSourceSchema).min(1).optional(),
    schoolPreferenceIn: z.array(schoolPreferenceSchema).min(1).optional(), hasHealthInsurance: z.boolean().optional() }).optional(),
  needsProfessional: z.boolean(), professionalNote: z.string().optional(), sources: z.array(z.object({ label: z.string().min(1), url: z.string().url().optional() })).min(1),
});
export type KnowledgeStep = z.infer<typeof knowledgeStepSchema>;
const phaseOrder = { before: 0, arrival: 1, ongoing: 2 };
export const knowledgeFileSchema = z.object({
  country: z.string().min(1), coverage: z.enum(['full', 'generic']), version: z.string().min(1), steps: z.array(knowledgeStepSchema).min(1),
}).superRefine((file, context) => {
  const byId = new Map<string, KnowledgeStep>();
  for (const [index, step] of file.steps.entries()) {
    if (byId.has(step.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index, 'id'], message: `Duplicate step id: ${step.id}` });
    byId.set(step.id, step);
  }
  for (const [index, step] of file.steps.entries()) {
    for (const dependencyId of step.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (!dependency) context.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index, 'dependsOn'], message: `Unknown dependency: ${dependencyId}` });
      else if (phaseOrder[dependency.phase] > phaseOrder[step.phase]) context.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index, 'dependsOn'], message: 'A step cannot depend on a later phase' });
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { context.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: `Dependency cycle at: ${id}` }); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) if (byId.has(dependency)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
});
export type KnowledgeFile = z.infer<typeof knowledgeFileSchema>;
export interface KnowledgeCatalog { portugal: KnowledgeFile; generic: KnowledgeFile }
