import { countryName } from '@nomad/shared';
import type { Profile } from '@nomad/shared';

export function householdSummary(profile: Profile): string {
  const partner = profile.slots.hasPartner;
  const children = profile.slots.childrenCount;
  if (partner.status === 'known' && partner.value === true || children.status === 'known' && Number(children.value) > 0) return '全家';
  if (partner.status === 'known' && partner.value === false && children.status === 'known' && children.value === 0) return '个人';
  return '家庭情况待了解';
}
export function generateTitle(profile: Profile): string {
  const destination = profile.slots.destination;
  return destination.status === 'known' ? `${countryName(String(destination.value))} · ${householdSummary(profile)}` : '新的出海咨询';
}
