import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildReplayDivergenceResume,
  evaluateReplayResumePreflight,
} from '../session-replay-resume.ts';
import type { SessionAction } from '../../types.ts';

function action(overrides: Partial<SessionAction> = {}): SessionAction {
  return { ts: 0, command: 'click', positionals: ['label="Save"'], flags: {}, ...overrides };
}

test('generic .ad replay allows resuming from the first action', () => {
  const actions: SessionAction[] = [action({ command: 'back', positionals: [] }), action()];
  assert.deepEqual(evaluateReplayResumePreflight({ from: 1, actions }), { allowed: true });
});

test('generic .ad replay allows resuming after earlier actions', () => {
  const actions: SessionAction[] = [
    action({ command: 'open', positionals: ['Demo'] }),
    action({ command: 'click', positionals: ['label="Continue"'] }),
    action({ command: 'click', positionals: ['label="Save"'] }),
  ];
  assert.deepEqual(evaluateReplayResumePreflight({ from: 3, actions }), { allowed: true });
});

test('repeated generic .ad action lines occupy distinct plan indices', () => {
  const actions: SessionAction[] = [
    action({ command: 'click', positionals: ['label="Item"'] }),
    action({ command: 'click', positionals: ['label="Item"'] }),
    action({ command: 'click', positionals: ['label="Item"'] }),
  ];
  assert.deepEqual(evaluateReplayResumePreflight({ from: 3, actions }), { allowed: true });
});

test('buildReplayDivergenceResume reports a resumable generic .ad failure', () => {
  const actions: SessionAction[] = [
    action({ command: 'open', positionals: ['Demo'] }),
    action({ command: 'click', positionals: ['label="Save"'] }),
  ];
  const resume = buildReplayDivergenceResume({
    failedIndex: 2,
    actions,
    planDigest: 'abc123',
  });
  assert.deepEqual(resume, { allowed: true, from: 2, planDigest: 'abc123' });
});
