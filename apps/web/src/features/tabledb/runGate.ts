import { classifySql, type SqlClassification } from '@vnpay/shared';

export type RunMode = 'read' | 'write';
export type RunDecision =
  | { action: 'run-read'; classification: SqlClassification }
  | { action: 'confirm-write'; classification: SqlClassification }
  | { action: 'reject'; classification: SqlClassification; reason: 'empty' | 'multi' | 'not-read' | 'write-not-allowed' };

/**
 * Pure gate deciding what may happen when the user presses Run. The UI may never call execute() with
 * mode "write" unless this returns confirm-write AND the user confirmed. The server/sidecar re-check everything.
 */
export function decideRun(sql: string, mode: RunMode, writeAllowed: boolean): RunDecision {
  const classification = classifySql(sql);
  if (!sql.trim()) return { action: 'reject', classification, reason: 'empty' };
  if (classification.multi) return { action: 'reject', classification, reason: 'multi' };
  if (mode === 'read') {
    return classification.kind === 'read' ? { action: 'run-read', classification } : { action: 'reject', classification, reason: 'not-read' };
  }
  if (!writeAllowed) return { action: 'reject', classification, reason: 'write-not-allowed' };
  // write mode: reads still run as reads; anything else (write/ddl/other) needs explicit confirmation
  return classification.kind === 'read' ? { action: 'run-read', classification } : { action: 'confirm-write', classification };
}
