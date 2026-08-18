export interface GateDecision {
  proceed: boolean;
  ackFingerprint: boolean;
  ackExtensionKeys: string[];
  applyToRemaining: boolean;
  retryAfterFingerprintMatch?: boolean;
}

export type GateDecisionAction = "proceed" | "cancel" | "retry";

export function gateDecisionAction(decision: GateDecision): GateDecisionAction {
  if (decision.retryAfterFingerprintMatch) return "retry";
  return decision.proceed ? "proceed" : "cancel";
}
