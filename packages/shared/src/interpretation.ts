import { z } from 'zod';
import { slotKeySchema } from './profile.js';

export const intentSchema = z.enum(['provide_info', 'ask_professional', 'off_topic']);
export const professionalTopicSchema = z.enum(['visa_eligibility', 'tax_amount', 'company_setup', 'other']);
export type Intent = z.infer<typeof intentSchema>;
export type ProfessionalTopic = z.infer<typeof professionalTopicSchema>;
export const slotUpdateSchema = z.object({ slot: slotKeySchema, value: z.unknown(), op: z.enum(['set', 'add', 'remove']).optional() })
  .refine(update => Object.hasOwn(update, 'value'), { message: 'value is required', path: ['value'] });
export interface SlotUpdate { slot: z.infer<typeof slotKeySchema>; value: unknown; op?: 'set' | 'add' | 'remove' }
export interface Interpretation { intent: Intent; updates: SlotUpdate[]; unsure: z.infer<typeof slotKeySchema>[]; professionalTopic?: ProfessionalTopic }
export const interpretationSchema: z.ZodType<Interpretation> = z.object({
  intent: intentSchema, updates: z.array(slotUpdateSchema), unsure: z.array(slotKeySchema), professionalTopic: professionalTopicSchema.optional(),
}).superRefine((value, context) => {
  if (value.intent === 'off_topic' && (value.updates.length || value.unsure.length)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'off_topic cannot contain updates or unsure slots' });
  if (value.intent === 'ask_professional' && !value.professionalTopic) context.addIssue({ code: z.ZodIssueCode.custom, message: 'professionalTopic is required', path: ['professionalTopic'] });
}) as z.ZodType<Interpretation>;
