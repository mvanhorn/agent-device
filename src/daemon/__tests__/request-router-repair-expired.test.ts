/**
 * ADR 0012 decision 6, R7 (C5a): when a repair session was reaped before it was
 * finalized, the request router rewrites the resulting `SESSION_NOT_FOUND` into
 * a `REPAIR_SESSION_EXPIRED` recovery error with actionable re-run guidance,
 * rather than leaking a bare SESSION_NOT_FOUND. Any other error, or the absence
 * of a live tombstone, passes through unchanged.
 */
import { test, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { createRequestHandler } from '../request-router.ts';
import type { DaemonRequest, SessionState } from '../types.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';

function makeHandler(prefix: string) {
  const sessionStore = makeSessionStore(prefix);
  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
  return { sessionStore, handler };
}

function tombstonedSession(name: string): SessionState {
  return {
    name,
    device: { platform: 'apple', id: 'sim-1', name: 'iPhone', kind: 'simulator', booted: true },
    createdAt: Date.now(),
    actions: [],
    saveScriptBoundary: 0,
    repairSourcePath: '/flows/login.ad',
  };
}

function closeRequest(session: string): DaemonRequest {
  return { token: 'test-token', session, command: 'close', positionals: [], flags: {} };
}

test('a command that finds no session but hits a live repair tombstone gets REPAIR_SESSION_EXPIRED', async () => {
  const { sessionStore, handler } = makeHandler('agent-device-router-repair-expired-');
  // The repair session was reaped (idle-reap) leaving a tombstone; the store
  // has no live session by that name.
  sessionStore.writeRepairTombstone(tombstonedSession('repair-x'));

  const response = await handler(closeRequest('repair-x'));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('REPAIR_SESSION_EXPIRED');
  // Re-run guidance carries the original script path from the tombstone.
  expect(response.error.message).toMatch(/replay \/flows\/login\.ad --save-script/);
});

test('without a tombstone, a missing session still returns a plain SESSION_NOT_FOUND', async () => {
  const { handler } = makeHandler('agent-device-router-no-tombstone-');
  const response = await handler(closeRequest('never-existed'));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('SESSION_NOT_FOUND');
});

test('an expired tombstone does not shadow a missing session', async () => {
  const { sessionStore, handler } = makeHandler('agent-device-router-expired-tombstone-');
  // TTL 0 => already stale.
  sessionStore.writeRepairTombstone(tombstonedSession('repair-y'), 0);

  const response = await handler(closeRequest('repair-y'));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('SESSION_NOT_FOUND');
});
