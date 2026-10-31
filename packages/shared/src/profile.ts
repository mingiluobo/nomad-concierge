import { z } from 'zod';

export const slotKeys = ['destination', 'goals', 'applicantNationality', 'hasPartner', 'partnerNationality', 'childrenCount', 'childrenAges', 'currentResidence', 'residenceStatus', 'timeline', 'incomeSource', 'businessType', 'incomeCountry', 'schoolPreference', 'hasHealthInsurance'] as const;
export const slotKeySchema = z.enum(slotKeys);
export type SlotKey = z.infer<typeof slotKeySchema>;
export const slotStatusSchema = z.enum(['missing', 'known', 'unsure']);
export type SlotStatus = z.infer<typeof slotStatusSchema>;
export interface SlotState<T = unknown> {
  status: SlotStatus;
  value?: T;
  previousValue?: T;
  corrected?: boolean;
  sourceMessageId?: string;
  updatedAt?: string;
}
export interface Profile {
  slots: Record<SlotKey, SlotState>;
  pendingSlots: SlotKey[];
}
export const slotStateSchema: z.ZodType<SlotState> = z.object({
  status: slotStatusSchema, value: z.unknown().optional(), previousValue: z.unknown().optional(),
  corrected: z.boolean().optional(), sourceMessageId: z.string().optional(), updatedAt: z.string().optional(),
});
const profileSlotShape = Object.fromEntries(slotKeys.map(key => [key, slotStateSchema])) as Record<SlotKey, typeof slotStateSchema>;
export const profileSchema: z.ZodType<Profile> = z.object({ slots: z.object(profileSlotShape), pendingSlots: z.array(slotKeySchema) });
export const progressSchema = z.object({
  required: z.number().int().nonnegative(), answered: z.number().int().nonnegative(),
  missing: z.array(slotKeySchema), unsure: z.array(slotKeySchema), isComplete: z.boolean(), canGenerateEarly: z.boolean(),
});
export type Progress = z.infer<typeof progressSchema>;
export function createEmptyProfile(): Profile {
  return { slots: Object.fromEntries(slotKeys.map(key => [key, { status: 'missing' }])) as Profile['slots'], pendingSlots: [] };
}
