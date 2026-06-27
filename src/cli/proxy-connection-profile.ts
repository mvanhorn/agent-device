import crypto from 'node:crypto';
import type { RemoteConfigProfile } from '../remote-config-schema.ts';
import { AppError } from '../utils/errors.ts';
import type { CliFlags } from '../utils/cli-flags.ts';
import type { EnvMap } from '../utils/env-map.ts';
import {
  generatedProfileDefaultsFromFlags,
  persistAndResolveGeneratedProfile,
} from './generated-remote-config.ts';
import { resolveRequestedLeaseBackend } from './commands/connection-runtime.ts';

export function resolveProxyConnectProfile(options: {
  flags: CliFlags;
  stateDir: string;
  cwd: string;
  env?: EnvMap;
}): { flags: CliFlags; remoteConfigPath: string } {
  const daemonBaseUrl = options.flags.daemonBaseUrl ?? options.env?.AGENT_DEVICE_DAEMON_BASE_URL;
  if (!daemonBaseUrl) {
    throw new AppError(
      'INVALID_ARGS',
      'connect proxy requires --daemon-base-url <url> or AGENT_DEVICE_DAEMON_BASE_URL.',
    );
  }
  const clientId = buildProxyClientId(options.stateDir, daemonBaseUrl, options.flags.session);
  const profile: RemoteConfigProfile = {
    ...generatedProfileDefaultsFromFlags(options.flags),
    daemonBaseUrl,
    daemonTransport: options.flags.daemonTransport ?? 'http',
    daemonServerMode: options.flags.daemonServerMode,
    tenant: options.flags.tenant ?? 'proxy',
    sessionIsolation: options.flags.sessionIsolation ?? 'tenant',
    runId: options.flags.runId ?? `proxy-${clientId}`,
    leaseProvider: 'proxy',
    clientId,
    leaseBackend: options.flags.leaseBackend ?? resolveRequestedLeaseBackend(options.flags),
  };
  return persistAndResolveGeneratedProfile({
    stateDir: options.stateDir,
    provider: 'proxy',
    profile,
    cwd: options.cwd,
    env: options.env,
    flags: options.flags,
    extraFlags: {
      daemonBaseUrl,
      daemonTransport: options.flags.daemonTransport ?? 'http',
    },
  });
}

function buildProxyClientId(
  stateDir: string,
  daemonBaseUrl: string,
  session: string | undefined,
): string {
  return crypto
    .createHash('sha256')
    .update(`${stateDir}\0${daemonBaseUrl}\0${session ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}
