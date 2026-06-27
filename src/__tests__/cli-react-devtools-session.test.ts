import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

vi.mock('../cli/commands/react-devtools.ts', () => ({
  runReactDevtoolsCommand: vi.fn(async () => 0),
}));

import { runCli } from '../cli.ts';
import { runReactDevtoolsCommand } from '../cli/commands/react-devtools.ts';
import { installIsolatedCliTestEnv } from './cli-test-env.ts';
import { hashRemoteConfigFile, writeRemoteConnectionState } from '../remote-connection-state.ts';
import type { DaemonResponse } from '../daemon-client.ts';
import type { AgentDeviceDaemonTransport } from '../client-types.ts';

afterEach(() => {
  vi.clearAllMocks();
});

test('react-devtools uses active remote connection session after defaults are merged', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-react-devtools-session-'));
  const stateDir = path.join(tempRoot, 'state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://daemon.example.test',
      platform: 'android',
      metroProxyBaseUrl: 'https://bridge.example.test',
      metroBearerToken: 'token',
    }),
  );
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: { baseUrl: 'https://daemon.example.test', transport: 'http' },
      tenant: 'tenant-1',
      runId: 'run-1',
      leaseId: 'lease-1',
      leaseBackend: 'android-instance',
      leaseProvider: 'limrun',
      platform: 'android',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });

  const originalExit = process.exit;
  let exitCode: number | undefined;
  const restoreEnv = installIsolatedCliTestEnv();
  (process as any).exit = ((code?: number) => {
    exitCode = code ?? 0;
  }) as typeof process.exit;

  const sendToDaemon = async (): Promise<DaemonResponse> => ({
    ok: true,
    data: {
      lease: {
        leaseId: 'lease-1',
        tenantId: 'tenant-1',
        runId: 'run-1',
        backend: 'android-instance',
      },
    },
  });

  try {
    await runCli(['react-devtools', 'status', '--state-dir', stateDir], { sendToDaemon });
  } finally {
    restoreEnv();
    process.exit = originalExit;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  assert.equal(exitCode, 0);
  assert.equal(vi.mocked(runReactDevtoolsCommand).mock.calls.length, 1);
  assert.equal(vi.mocked(runReactDevtoolsCommand).mock.calls[0]?.[1]?.session, 'adc-android');
});

test('react-devtools start configures direct Android remote reverse after materialization', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-react-devtools-reverse-'));
  const stateDir = path.join(tempRoot, 'state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      platform: 'android',
      tenant: 'tenant-1',
      runId: 'run-1',
      leaseBackend: 'android-instance',
      leaseProvider: 'limrun',
    }),
  );
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: { transport: 'auto' },
      tenant: 'tenant-1',
      runId: 'run-1',
      leaseId: 'lease-1',
      leaseBackend: 'android-instance',
      leaseProvider: 'limrun',
      platform: 'android',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });

  const originalExit = process.exit;
  let exitCode: number | undefined;
  const restoreEnv = installIsolatedCliTestEnv();
  (process as any).exit = ((code?: number) => {
    exitCode = code ?? 0;
  }) as typeof process.exit;

  vi.mocked(runReactDevtoolsCommand).mockImplementationOnce(async (_args, options) => {
    await options?.configureDirectPortReverse?.();
    return 0;
  });
  const requests: Array<Parameters<AgentDeviceDaemonTransport>[0]> = [];
  const sendToDaemon: AgentDeviceDaemonTransport = async (req): Promise<DaemonResponse> => {
    requests.push(req);
    if (req.command === 'runtime') {
      return { ok: true, data: {} };
    }
    return {
      ok: true,
      data: {
        lease: {
          leaseId: 'lease-1',
          tenantId: 'tenant-1',
          runId: 'run-1',
          backend: 'android-instance',
          provider: 'limrun',
        },
      },
    };
  };

  try {
    await runCli(['react-devtools', 'start', '--state-dir', stateDir], { sendToDaemon });
  } finally {
    restoreEnv();
    process.exit = originalExit;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const runtimeRequest = requests.find((req) => req.command === 'runtime');
  assert.equal(exitCode, 0);
  assert.deepEqual(runtimeRequest?.positionals, ['port-reverse']);
  assert.equal(runtimeRequest?.flags?.leaseId, 'lease-1');
  assert.equal(runtimeRequest?.flags?.leaseProvider, 'limrun');
  assert.equal(runtimeRequest?.flags?.devicePort, 8097);
  assert.equal(runtimeRequest?.flags?.hostPort, 8097);
  assert.equal(runtimeRequest?.flags?.portReverseName, 'react-devtools');
});
