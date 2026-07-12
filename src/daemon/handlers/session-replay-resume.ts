import type { SessionAction } from '../types.ts';
import type { ReplayDivergenceResume } from '../../replay/divergence.ts';

/** Generic `.ad` actions have no runtime variable producers or control wrappers. */
export type ReplayResumePreflightResult = { allowed: true } | { allowed: false; reason: string };

export function evaluateReplayResumePreflight(params: {
  from: number;
  actions: SessionAction[];
}): ReplayResumePreflightResult {
  void params;
  return { allowed: true };
}

/** Builds the `resume` object attached to every divergence report. */
export function buildReplayDivergenceResume(params: {
  failedIndex: number; // 1-based
  actions: SessionAction[];
  planDigest: string;
}): ReplayDivergenceResume {
  const { failedIndex, actions, planDigest } = params;
  const preflight = evaluateReplayResumePreflight({ from: failedIndex, actions });
  return preflight.allowed
    ? { allowed: true, from: failedIndex, planDigest }
    : { allowed: false, from: failedIndex, planDigest, reason: preflight.reason };
}
