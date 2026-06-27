import { resolveDaemonPaths } from '../daemon/config.ts';
import type { RemoteConfigProfile } from '../remote-config-schema.ts';
import { AppError } from '../utils/errors.ts';
import type { CliFlags } from '../utils/cli-flags.ts';
import type { EnvMap } from '../utils/env-map.ts';
import {
  generatedProfileDefaultsFromFlags,
  persistAndResolveGeneratedProfile,
} from './generated-remote-config.ts';

const DEFAULT_LIMRUN_TENANT = 'limrun';

export function resolveLimrunConnectProfile(options: {
  flags: CliFlags;
  stateDir: string;
  cwd: string;
  env?: EnvMap;
}): { flags: CliFlags; remoteConfigPath: string } {
  const env = options.env ?? process.env;
  const apiKey = env.LIMRUN_API_KEY?.trim() || env.LIM_API_KEY?.trim();
  if (!apiKey) {
    throw new AppError('INVALID_ARGS', 'connect limrun requires LIMRUN_API_KEY.', {
      hint: 'Set LIMRUN_API_KEY in the environment before running agent-device connect limrun.',
    });
  }

  const profile = buildLimrunRemoteProfile({ flags: options.flags });
  return persistAndResolveGeneratedProfile({
    stateDir: options.stateDir,
    provider: 'limrun',
    profile,
    cwd: options.cwd,
    env,
    flags: options.flags,
  });
}

function buildLimrunRemoteProfile(options: { flags: CliFlags }): RemoteConfigProfile {
  const flags = options.flags;
  const daemonPaths = resolveDaemonPaths(flags.stateDir);
  return {
    ...generatedProfileDefaultsFromFlags(flags),
    stateDir: daemonPaths.baseDir,
    daemonTransport: 'auto',
    tenant: flags.tenant ?? DEFAULT_LIMRUN_TENANT,
    runId: flags.runId ?? `cli-${Date.now().toString(36)}`,
    sessionIsolation: 'tenant',
    leaseBackend: flags.leaseBackend ?? inferLimrunLeaseBackend(flags.platform),
    leaseProvider: 'limrun',
    target: flags.target ?? 'mobile',
  };
}

function inferLimrunLeaseBackend(platform: CliFlags['platform']) {
  if (platform === 'ios') return 'ios-instance';
  if (platform === 'android') return 'android-instance';
  return undefined;
}
