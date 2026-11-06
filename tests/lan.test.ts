import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getLanAddresses } from '../src/server/lan';

interface FakeInterface {
  family: 'IPv4' | 'IPv6';
  address: string;
  internal: boolean;
}

// The machine's real adapters would make the ranking untestable, so the OS boundary is replaced.
const operatingSystem = vi.hoisted(() => ({ adapters: {} as Record<string, FakeInterface[] | undefined> }));
vi.mock('node:os', () => ({ networkInterfaces: () => operatingSystem.adapters }));

function ipv4(address: string, internal = false): FakeInterface {
  return { family: 'IPv4', address, internal };
}

describe('getLanAddresses', () => {
  beforeEach(() => {
    operatingSystem.adapters = {};
  });

  it('lists private ranges in the order 192.168, 10., 172.16-31 and public addresses last', () => {
    operatingSystem.adapters = {
      Ethernet: [ipv4('203.0.113.9')],
      Wifi: [ipv4('172.20.0.5')],
      Lan: [ipv4('10.0.0.7')],
      Casa: [ipv4('192.168.1.20')],
    };

    expect(getLanAddresses()).toEqual(['192.168.1.20', '10.0.0.7', '172.20.0.5', '203.0.113.9']);
  });

  it('does not treat 172.32.x.x as a private address', () => {
    operatingSystem.adapters = { Ethernet: [ipv4('172.32.0.1')], Wifi: [ipv4('172.16.0.1')] };

    expect(getLanAddresses()).toEqual(['172.16.0.1', '172.32.0.1']);
  });

  it('puts virtual adapters after every real adapter even when their address is more private', () => {
    operatingSystem.adapters = {
      'vEthernet (WSL)': [ipv4('192.168.50.1')],
      'VMware Network Adapter VMnet8': [ipv4('192.168.60.1')],
      'Wi-Fi': [ipv4('10.1.2.3')],
    };

    expect(getLanAddresses()).toEqual(['10.1.2.3', '192.168.50.1', '192.168.60.1']);
  });

  it('skips internal and IPv6 entries and adapters without addresses', () => {
    operatingSystem.adapters = {
      Loopback: [ipv4('127.0.0.1', true)],
      Ethernet: [{ family: 'IPv6', address: 'fe80::1', internal: false }, ipv4('192.168.0.10')],
      Empty: undefined,
    };

    expect(getLanAddresses()).toEqual(['192.168.0.10']);
  });

  it('returns each address once when several adapters report it', () => {
    operatingSystem.adapters = { Ethernet: [ipv4('192.168.0.10')], Wifi: [ipv4('192.168.0.10')] };

    expect(getLanAddresses()).toEqual(['192.168.0.10']);
  });

  it('returns an empty list when the machine has no network adapters', () => {
    expect(getLanAddresses()).toEqual([]);
  });
});
