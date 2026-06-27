import type { DeviceLease } from '../../daemon/lease-registry.ts';
import type { DeviceInfo } from '../../utils/device.ts';

export type LimrunPlatform = 'ios' | 'android';

export const LIMRUN_PROVIDER = 'limrun';

const LIMRUN_DEVICE_ID_PREFIX = LIMRUN_PROVIDER;

const LIMRUN_IOS_SUPPORTED_COMMANDS = [
  'install',
  'install-from-source',
  'reinstall',
  'open',
  'close',
  'click',
  'press',
  'fill',
  'type',
  'focus',
  'scroll',
  'screenshot',
  'snapshot',
  'wait',
  'get',
  'find',
  'is',
  'back',
  'rotate',
] as const;

const LIMRUN_ANDROID_SUPPORTED_COMMANDS = [
  'install',
  'install-from-source',
  'reinstall',
  'open',
  'close',
  'click',
  'press',
  'fill',
  'type',
  'focus',
  'scroll',
  'swipe',
  'longpress',
  'pan',
  'fling',
  'screenshot',
  'snapshot',
  'wait',
  'get',
  'find',
  'is',
  'back',
  'home',
  'app-switcher',
] as const;

export function platformForLimrunLeaseBackend(backend: string): LimrunPlatform | undefined {
  if (backend === 'ios-instance') return 'ios';
  if (backend === 'android-instance') return 'android';
  return undefined;
}

export function buildLimrunDevice(
  platform: LimrunPlatform,
  lease: DeviceLease,
  instanceId: string,
): DeviceInfo {
  return {
    platform,
    id: limrunDeviceId(platform, lease.leaseId),
    name: `Limrun ${platform} ${instanceId.slice(0, 8)}`,
    kind: platform === 'ios' ? 'simulator' : 'emulator',
    target: 'mobile',
    booted: true,
    capabilities: {
      supportedCommands:
        platform === 'ios'
          ? [...LIMRUN_IOS_SUPPORTED_COMMANDS]
          : [...LIMRUN_ANDROID_SUPPORTED_COMMANDS],
    },
  };
}

export function parseLimrunDeviceId(
  value: string,
): { platform: LimrunPlatform; leaseId: string } | null {
  const [prefix, platform, leaseId] = value.split(':');
  if (prefix !== LIMRUN_DEVICE_ID_PREFIX) return null;
  if (platform !== 'ios' && platform !== 'android') return null;
  if (!leaseId) return null;
  return { platform, leaseId };
}

export function readLimrunLeaseIdFromInventoryRequest(request: {
  leaseId?: string;
}): string | undefined {
  return request.leaseId;
}

function limrunDeviceId(platform: LimrunPlatform, leaseId: string): string {
  return `${LIMRUN_DEVICE_ID_PREFIX}:${platform}:${leaseId}`;
}
