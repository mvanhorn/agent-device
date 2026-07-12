import fs from 'node:fs';
import type { CommandFlags } from '../../core/dispatch.ts';
import { resolveReplayAction, type ReplayVarScope } from '../../replay/vars.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse, SessionAction } from '../types.ts';
import { mergeParentFlags } from '../../core/batch.ts';
import {
  gesturePayloadFromPositionals,
  swipePayloadFromPositionals,
} from '../../contracts/gesture-normalization.ts';

type ReplayBaseRequest = Omit<DaemonRequest, 'command' | 'positionals'>;

export async function invokeReplayAction(params: {
  req: DaemonRequest;
  sessionName: string;
  action: SessionAction;
  scope: ReplayVarScope;
  filePath: string;
  line: number;
  step: number;
  /** Resolved source file when it differs from `filePath` (a `runFlow` include's path). */
  sourcePath?: string;
  tracePath?: string;
  invoke: DaemonInvokeFn;
}): Promise<DaemonResponse> {
  const { req, sessionName, action, scope, filePath, line, step, sourcePath, tracePath, invoke } =
    params;
  const resolved = resolveReplayAction(action, scope, { file: sourcePath ?? filePath, line });
  const startedAt = Date.now();
  appendReplayTraceEvent(tracePath, {
    type: 'replay_action_start',
    ts: new Date(startedAt).toISOString(),
    replayPath: filePath,
    ...(sourcePath ? { sourcePath } : {}),
    line,
    step,
    command: resolved.command,
    positionals: resolved.positionals ?? [],
  });

  const response = await invokeResolvedReplayAction({
    req,
    sessionName,
    resolved,
    scope,
    line,
    step,
    invoke,
  });

  const finishedAt = Date.now();
  appendReplayTraceEvent(tracePath, {
    type: 'replay_action_stop',
    ts: new Date(finishedAt).toISOString(),
    replayPath: filePath,
    ...(sourcePath ? { sourcePath } : {}),
    line,
    step,
    command: resolved.command,
    ok: response.ok,
    durationMs: finishedAt - startedAt,
    resultTiming: response.ok ? readResponseTiming(response.data) : undefined,
    errorCode: response.ok ? undefined : response.error.code,
  });
  return withReplayFailureSource(response, sourcePath ?? filePath, line);
}

/**
 * Attaches the failing action's resolved source for the top-level failure
 * context; deepest failure wins (never overwrites an inner attachment).
 */
function withReplayFailureSource(
  response: DaemonResponse,
  path: string,
  line: number,
): DaemonResponse {
  if (response.ok) return response;
  if (response.error.details?.replaySource !== undefined) return response;
  return {
    ok: false,
    error: {
      ...response.error,
      details: { ...(response.error.details ?? {}), replaySource: { path, line } },
    },
  };
}

async function invokeResolvedReplayAction(params: {
  req: DaemonRequest;
  sessionName: string;
  resolved: SessionAction;
  scope: ReplayVarScope;
  line: number;
  step: number;
  invoke: DaemonInvokeFn;
}): Promise<DaemonResponse> {
  const { req, sessionName, resolved, invoke } = params;
  const flags = buildReplayActionFlags(req.flags, resolved.flags);
  const baseReq: ReplayBaseRequest = {
    token: req.token,
    session: sessionName,
    flags,
    runtime: resolved.runtime,
    meta: req.meta,
    internal: req.internal,
  };
  return await invoke(buildReplayInteractionRequest(baseReq, resolved));
}

function buildReplayInteractionRequest(
  baseReq: ReplayBaseRequest,
  action: SessionAction,
): DaemonRequest {
  const positionals = action.positionals ?? [];
  if (action.command === 'gesture') {
    return {
      ...baseReq,
      command: action.command,
      positionals: [],
      input: gesturePayloadFromPositionals(positionals, baseReq.flags?.pointerCount),
    };
  }
  if (action.command === 'swipe') {
    return {
      ...baseReq,
      command: action.command,
      positionals: [],
      input: swipePayloadFromPositionals(positionals, {
        count: baseReq.flags?.count,
        pauseMs: baseReq.flags?.pauseMs,
        pattern: baseReq.flags?.pattern,
      }),
    };
  }
  return { ...baseReq, command: action.command, positionals };
}

function readResponseTiming(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const timing = (data as { timing?: unknown }).timing;
  if (!timing || typeof timing !== 'object' || Array.isArray(timing)) return undefined;
  return Object.fromEntries(
    Object.entries(timing).filter(([, value]) => {
      const kind = typeof value;
      return kind === 'number' || kind === 'string' || kind === 'boolean';
    }),
  );
}

function appendReplayTraceEvent(
  tracePath: string | undefined,
  event: Record<string, unknown>,
): void {
  if (!tracePath) return;
  fs.appendFileSync(tracePath, `${JSON.stringify(event)}\n`);
}

function buildReplayActionFlags(
  parentFlags: CommandFlags | undefined,
  actionFlags: SessionAction['flags'] | undefined,
): CommandFlags {
  return mergeParentFlags(parentFlags, { ...(actionFlags ?? {}) });
}
