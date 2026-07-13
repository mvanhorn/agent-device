/**
 * ADR 0012 decision 6 "repair transaction" lifecycle fixes (Q1/Q2a/Q2b/Q2c):
 * proves the WHOLE chain end to end, at the layer these fixes actually live —
 * `runReplayScriptFile` + `handleCloseCommand` sharing a live `SessionStore`,
 * exactly like an agent's separate CLI invocations against the same daemon
 * session would. `sendToDaemon`'s process-level keep-alive (Fix 1's daemon
 * teardown guard) is a different architectural layer — a client-side process
 * manager, not session/script state — and is covered separately in
 * `src/utils/__tests__/daemon-client-lifecycle.test.ts`
 * ("keeps an owned ephemeral daemon alive and hints its --state-dir...").
 *
 * Fix 1 (session-side): a divergence never deletes the session — it stays in
 * the SessionStore, addressable for the next call.
 * Fix 2: SessionScriptWriter.write only publishes once `close --save-script`
 * sets `saveScriptFinalized` — never on a divergence-only exit or an
 * abandoned close.
 * Fix 3: the source plan's terminal `close` is skipped while repair-armed, so
 * the resume completes instead of diverging on lifecycle.
 * Fix 4: the publish is atomic (temp + rename) and carries the completeness
 * sentinel, so a stale/partial file never blocks a later repair.
 */
import { test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../platforms/apple/core/simulator.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/simulator.ts')>();
  return { ...actual, shutdownSimulator: vi.fn() };
});
vi.mock('../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn() };
});
vi.mock('../../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, stopIosRunnerSession: vi.fn(async () => {}) };
});
vi.mock('../../../platforms/apple/core/perf-xctrace.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/perf-xctrace.ts')>();
  return { ...actual, cleanupAppleXctracePerfCapture: vi.fn(async () => ({})) };
});
vi.mock('../../runtime-hints.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime-hints.ts')>();
  return { ...actual, clearRuntimeHintsFromApp: vi.fn(async () => {}) };
});
vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})), resolveTargetDevice: vi.fn() };
});
vi.mock('../session-device-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-device-utils.ts')>();
  return { ...actual, settleIosSimulator: vi.fn(async () => {}) };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReplayScriptFile } from '../session-replay-runtime.ts';
import { handleCloseCommand } from '../session-close.ts';
import { SessionStore } from '../../session-store.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { dispatchCommand } from '../../../core/dispatch.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { HEAL_COMPLETE_SENTINEL } from '../../session-script-writer.ts';
import { parseReplayScriptDetailed } from '../../../replay/script.ts';
import {
  baseReplayRequest as baseReq,
  writeReplayFile,
} from './session-replay-runtime.fixtures.ts';
import { freshEvidence, makeRecordingReplayInvoke } from './session-replay-repair.fixtures.ts';

const mockDispatchCommand = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  // The "current" app state: "save" was renamed to "save-v2" (why step 2
  // diverges), matching the target verification the SAVE_ANNOTATION triggers.
  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'save-v2',
        label: 'Save V2',
        rect: { x: 10, y: 10, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });
});

const SAVE_ANNOTATION =
  '# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"verified"}';

function setup(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  return {
    root,
    sessionStore,
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    leaseRegistry: new LeaseRegistry(),
  };
}

test('end-to-end repair transaction: cold divergence stays alive, corrective resume completes, close --save-script finalizes a COMPLETE healed .ad atomically, and an abandoned repair leaves no partial file', async () => {
  // ============================================================
  // Part 1 — the repair chain that COMMITS.
  // ============================================================
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-commit-',
  );
  const filePath = writeReplayFile(root, [
    'open "Demo" --relaunch',
    SAVE_ANNOTATION,
    'click id="save"',
    'click id="confirm"',
    'close',
  ]);
  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    evidence: (req) => (req.command === 'click' ? freshEvidence('confirm', 'Confirm') : undefined),
  });

  // --- Cold `replay drifted.ad --save-script` diverges on the renamed id. ---
  const leg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(leg1.ok).toBe(false);
  if (leg1.ok) return;
  expect(leg1.error.code).toBe('REPLAY_DIVERGENCE');
  const divergence = leg1.error.details?.divergence as {
    kind: string;
    resume: { allowed: boolean; from: number; planDigest: string };
  };
  expect(divergence.kind).toBe('selector-miss');
  expect(divergence.resume.allowed).toBe(true);

  // Fix 1 (session-side): the session stays alive — never torn down on a
  // divergence-only exit. (The client-side daemon PROCESS keep-alive that
  // makes this session reachable across separate CLI invocations is proven
  // in daemon-client-lifecycle.test.ts.)
  expect(sessionStore.get(sessionName)).toBeDefined();
  expect(sessionStore.get(sessionName)!.actions.map((a) => a.command)).toEqual(['open']);

  // --- Agent performs the corrective press (blessed @ref), recorded live. ---
  const session = sessionStore.get(sessionName)!;
  sessionStore.recordAction(session, {
    command: 'press',
    positionals: ['@e7'],
    flags: {},
    result: { selectorChain: ['id="save-v2"'] },
    targetEvidence: freshEvidence('save-v2', 'Save V2'),
  });

  // --- `replay --from N+1 --plan-digest <original>` resumes to the end. The
  // source plan's own terminal `close` (Fix 3) is skipped, so this completes
  // instead of diverging on lifecycle. ---
  const leg2 = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { saveScript: true, replayFrom: 3, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(leg2.ok).toBe(true);
  expect(session.actions.map((a) => a.command)).toEqual(['open', 'press', 'click']);
  // The terminal close never dispatched or recorded.
  expect(session.actions.some((a) => a.command === 'close')).toBe(false);
  expect(session.saveScriptFinalized).toBeFalsy();

  // --- The agent finalizes: `close --save-script` (the real handler, not a
  // direct writer call) commits the healed `.ad`. ---
  const closeResponse = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { saveScript: true },
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });
  expect(closeResponse.ok).toBe(true);
  // The session is gone (close's normal lifecycle) — but the healed script
  // was written to disk before deletion.
  expect(sessionStore.get(sessionName)).toBeUndefined();

  const healedPath = path.join(root, 'flow.healed.ad');
  expect(fs.existsSync(healedPath)).toBe(true);
  const healedScript = fs.readFileSync(healedPath, 'utf8');
  // Fix 4: complete + atomic — the sentinel is present, and the only file in
  // the directory is the final published one (no stray temp file survived).
  expect(healedScript).toContain(HEAL_COMPLETE_SENTINEL);
  expect(fs.readdirSync(root).filter((entry) => entry.endsWith('.ad'))).toEqual([
    'flow.ad',
    'flow.healed.ad',
  ]);
  const parsed = parseReplayScriptDetailed(healedScript);
  // Exactly the repair run's own execution path: open, the corrective press,
  // the surviving click, and the agent's own close — never the source
  // plan's original (skipped) close, never a bare @ref.
  expect(parsed.actions.map((a) => a.command)).toEqual(['open', 'press', 'click', 'close']);
  const bareRefs = parsed.actions.flatMap((a) => a.positionals.filter((p) => p.startsWith('@')));
  expect(bareRefs).toEqual([]);

  // ============================================================
  // Part 2 — a diverged-and-abandoned repair leaves NO partial file.
  // ============================================================
  const abandoned = setup('agent-device-repair-transaction-abandoned-');
  const abandonedFilePath = writeReplayFile(abandoned.root, [
    'open "Demo" --relaunch',
    SAVE_ANNOTATION,
    'click id="save"',
    'close',
  ]);
  const abandonedInvoke = makeRecordingReplayInvoke({
    sessionStore: abandoned.sessionStore,
    sessionName: abandoned.sessionName,
  });

  const abandonedLeg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [abandonedFilePath], flags: { saveScript: true } }),
    sessionName: abandoned.sessionName,
    logPath: abandoned.logPath,
    sessionStore: abandoned.sessionStore,
    invoke: abandonedInvoke,
  });
  expect(abandonedLeg1.ok).toBe(false);

  // The agent walks away: a plain `close` (no --save-script) reaches the
  // still repair-armed session — Fix 1/2's "abort/discard", not a commit.
  const abandonedCloseResponse = await handleCloseCommand({
    req: {
      token: 't',
      session: abandoned.sessionName,
      command: 'close',
      positionals: [],
      flags: {},
    },
    sessionName: abandoned.sessionName,
    logPath: abandoned.logPath,
    sessionStore: abandoned.sessionStore,
    leaseRegistry: abandoned.leaseRegistry,
  });
  expect(abandonedCloseResponse.ok).toBe(true);

  const abandonedHealedPath = path.join(abandoned.root, 'flow.healed.ad');
  expect(fs.existsSync(abandonedHealedPath)).toBe(false);
  // No stray temp artifact either.
  expect(
    fs.existsSync(path.dirname(abandonedHealedPath))
      ? fs.readdirSync(path.dirname(abandonedHealedPath))
      : [],
  ).toEqual(['flow.ad']);
});
