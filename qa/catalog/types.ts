export interface CaseDefinition {
  id: string;
  title: string;
  type: 'api' | 'e2e' | 'ws' | 'env' | 'manual';
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  requirements: string[];
  assertions: string;
  evidence: string;
}
