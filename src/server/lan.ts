import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { domainToASCII } from 'node:url';

const VIRTUAL_ADAPTER_PATTERN = /vEthernet|WSL|VirtualBox|VMware|Docker|Hyper-V|Loopback|Bluetooth/i;
const VIRTUAL_ADAPTER_PENALTY = 10;
const NOT_PRIVATE_RANK = 3;

interface Candidate {
  address: string;
  rank: number;
  order: number;
}

function privateRangeRank(address: string): number {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  const secondOctet = Number(address.split('.')[1]);
  if (address.startsWith('172.') && secondOctet >= 16 && secondOctet <= 31) return 2;
  return NOT_PRIVATE_RANK;
}

export const MAX_TOTAL_CONNECTIONS = 64;
export const MAX_CONNECTIONS_PER_ADDRESS = 12;

/** Names under which this machine is reachable on the LAN besides its IP addresses and "localhost". */
export function ownHostnamesOf(machineName: string): ReadonlySet<string> {
  // Browsers put the punycode form of a non-ASCII name in the Host header.
  const asciiName = domainToASCII(machineName.toLowerCase());
  return asciiName === '' ? new Set() : new Set([asciiName, `${asciiName}.local`]);
}

function parseHostHeader(requestHost: string): URL | null {
  try {
    return new URL(`http://${requestHost}`);
  } catch {
    return null;
  }
}

function isTrustedHostname(hostname: string, ownHostnames: ReadonlySet<string>): boolean {
  const withoutBrackets = hostname.replace(/^\[|\]$/g, '');
  return withoutBrackets === 'localhost' || isIP(withoutBrackets) !== 0 || ownHostnames.has(withoutBrackets);
}

/**
 * Two defences against a web page driving the table from a player's browser.
 * - Cross-site WebSocket: browsers exempt WebSockets from the same-origin policy, so an Origin has to be the very
 *   host:port that was requested. A missing Origin means a native client (or a test), which a page cannot imitate.
 * - DNS rebinding: a hostile domain that resolves to the LAN address makes Origin and Host agree, and the first
 *   same-origin polling request carries no Origin at all. So the Host must always be a literal IP, "localhost" or
 *   a name of this machine; a name the attacker registered is none of those.
 */
export function isHandshakeAllowed(
  origin: string | undefined,
  requestHost: string | undefined,
  ownHostnames: ReadonlySet<string>,
): boolean {
  if (requestHost === undefined) return false;
  const requested = parseHostHeader(requestHost);
  if (requested === null || !isTrustedHostname(requested.hostname, ownHostnames)) return false;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === requested.host;
  } catch {
    return false;
  }
}

/** Bounds how many connections the table serves in total and per remote address. */
export class ConnectionLimiter {
  private readonly countsByAddress = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly maxTotal = MAX_TOTAL_CONNECTIONS,
    private readonly maxPerAddress = MAX_CONNECTIONS_PER_ADDRESS,
  ) {}

  /** Why a new connection from this address must be turned away, or null while there is room. */
  refusalFor(address: string): string | null {
    if (this.total >= this.maxTotal) return `limite de ${this.maxTotal} conexões atingido`;
    if ((this.countsByAddress.get(address) ?? 0) >= this.maxPerAddress) {
      return `limite de ${this.maxPerAddress} conexões por endereço atingido`;
    }
    return null;
  }

  /** Counts an open connection and returns the function that gives its slot back when it closes. */
  track(address: string): () => void {
    this.total += 1;
    this.countsByAddress.set(address, (this.countsByAddress.get(address) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const remaining = (this.countsByAddress.get(address) ?? 1) - 1;
      if (remaining > 0) this.countsByAddress.set(address, remaining);
      else this.countsByAddress.delete(address);
    };
  }
}

/** Non-internal IPv4 addresses, real private-range adapters first and virtual adapters last. */
export function getLanAddresses(): string[] {
  const candidates: Candidate[] = [];
  for (const [adapterName, entries] of Object.entries(networkInterfaces())) {
    const virtualPenalty = VIRTUAL_ADAPTER_PATTERN.test(adapterName) ? VIRTUAL_ADAPTER_PENALTY : 0;
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      candidates.push({
        address: entry.address,
        rank: privateRangeRank(entry.address) + virtualPenalty,
        order: candidates.length,
      });
    }
  }
  candidates.sort((first, second) => first.rank - second.rank || first.order - second.order);
  return [...new Set(candidates.map((candidate) => candidate.address))];
}
