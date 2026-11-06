import { describe, expect, it } from 'vitest';
import { ConnectionLimiter, isHandshakeAllowed, ownHostnamesOf } from '../src/server/lan';

const OWN_HOSTNAMES = ownHostnamesOf('MESA-PC');

describe('isHandshakeAllowed', () => {
  it('accepts a handshake without an Origin header, as sent by native clients', () => {
    expect(isHandshakeAllowed(undefined, '192.168.0.10:3000', OWN_HOSTNAMES)).toBe(true);
    expect(isHandshakeAllowed(undefined, '127.0.0.1:3100', OWN_HOSTNAMES)).toBe(true);
  });

  it('accepts a page served by this very server, whatever address it was reached through', () => {
    expect(isHandshakeAllowed('http://192.168.0.10:3000', '192.168.0.10:3000', OWN_HOSTNAMES)).toBe(true);
    expect(isHandshakeAllowed('http://localhost:3000', 'localhost:3000', OWN_HOSTNAMES)).toBe(true);
    expect(isHandshakeAllowed('http://[::1]:3000', '[::1]:3000', OWN_HOSTNAMES)).toBe(true);
    expect(isHandshakeAllowed('http://[fe80::1a2b]:3000', '[fe80::1a2b]:3000', OWN_HOSTNAMES)).toBe(true);
  });

  it('ignores letter case and a default port that browsers leave out of the Host header', () => {
    expect(isHandshakeAllowed('http://MESA-PC:3000', 'mesa-pc:3000', OWN_HOSTNAMES)).toBe(true);
    expect(isHandshakeAllowed('http://mesa-pc:80', 'mesa-pc', OWN_HOSTNAMES)).toBe(true);
    expect(isHandshakeAllowed('http://LOCALHOST:3000', 'localhost:3000', OWN_HOSTNAMES)).toBe(true);
  });

  it('accepts the machine name and its .local alias, which players may type instead of the IP', () => {
    expect(isHandshakeAllowed('http://mesa-pc:3000', 'mesa-pc:3000', OWN_HOSTNAMES)).toBe(true);
    expect(isHandshakeAllowed('http://mesa-pc.local:3000', 'mesa-pc.local:3000', OWN_HOSTNAMES)).toBe(true);
    expect(isHandshakeAllowed(undefined, 'mesa-pc:3000', OWN_HOSTNAMES)).toBe(true);
  });

  it('rejects a page from another site or another port', () => {
    expect(isHandshakeAllowed('http://evil.example', '192.168.0.10:3000', OWN_HOSTNAMES)).toBe(false);
    expect(isHandshakeAllowed('http://192.168.0.10:8080', '192.168.0.10:3000', OWN_HOSTNAMES)).toBe(false);
    expect(isHandshakeAllowed('http://192.168.0.11:3000', '192.168.0.10:3000', OWN_HOSTNAMES)).toBe(false);
  });

  it('rejects DNS rebinding, where a hostile domain resolves to the LAN address and Origin matches Host', () => {
    expect(isHandshakeAllowed('http://evil.example:3000', 'evil.example:3000', OWN_HOSTNAMES)).toBe(false);
    expect(isHandshakeAllowed('http://10.0.0.5.nip.io:3000', '10.0.0.5.nip.io:3000', OWN_HOSTNAMES)).toBe(false);
    expect(isHandshakeAllowed('http://mesa-pc.evil.example:3000', 'mesa-pc.evil.example:3000', OWN_HOSTNAMES)).toBe(
      false,
    );
  });

  it('rejects a rebound page whose same-origin polling request carries no Origin header', () => {
    expect(isHandshakeAllowed(undefined, 'evil.example:3000', OWN_HOSTNAMES)).toBe(false);
    expect(isHandshakeAllowed(undefined, 'mesa-pc.evil.example', OWN_HOSTNAMES)).toBe(false);
  });

  it('rejects malformed, opaque and host-less handshakes instead of throwing', () => {
    expect(isHandshakeAllowed('null', '192.168.0.10:3000', OWN_HOSTNAMES)).toBe(false);
    expect(isHandshakeAllowed('', '192.168.0.10:3000', OWN_HOSTNAMES)).toBe(false);
    expect(isHandshakeAllowed('not a url', '192.168.0.10:3000', OWN_HOSTNAMES)).toBe(false);
    expect(isHandshakeAllowed('http://192.168.0.10:3000', undefined, OWN_HOSTNAMES)).toBe(false);
    expect(isHandshakeAllowed(undefined, undefined, OWN_HOSTNAMES)).toBe(false);
    expect(isHandshakeAllowed(undefined, '', OWN_HOSTNAMES)).toBe(false);
    expect(isHandshakeAllowed(undefined, 'bad host:3000', OWN_HOSTNAMES)).toBe(false);
  });
});

describe('ownHostnamesOf', () => {
  it('lower-cases the machine name and adds its .local alias', () => {
    expect([...ownHostnamesOf('MESA-PC')]).toEqual(['mesa-pc', 'mesa-pc.local']);
  });

  it('matches the punycode form that browsers send for a non-ASCII machine name', () => {
    expect(isHandshakeAllowed(undefined, 'xn--mesa--fsa:3000', ownHostnamesOf('Mesa-é'))).toBe(true);
  });

  it('trusts nothing extra when the machine name is not a valid host name', () => {
    expect(ownHostnamesOf('bad name').size).toBe(0);
  });
});

describe('ConnectionLimiter', () => {
  it('turns an address away once it holds its share of connections', () => {
    const limiter = new ConnectionLimiter(10, 2);
    limiter.track('192.168.0.2');
    limiter.track('192.168.0.2');

    expect(limiter.refusalFor('192.168.0.2')).toContain('por endereço');
    expect(limiter.refusalFor('192.168.0.3')).toBeNull();
  });

  it('turns everyone away once the table holds its total of connections', () => {
    const limiter = new ConnectionLimiter(3, 3);
    ['a', 'b', 'c'].forEach((address) => limiter.track(address));

    expect(limiter.refusalFor('d')).toContain('limite de 3 conexões');
  });

  it('gives a slot back when its connection closes, and only once', () => {
    const limiter = new ConnectionLimiter(2, 1);
    const releaseFirst = limiter.track('a');
    limiter.track('b');
    expect(limiter.refusalFor('c')).not.toBeNull();

    releaseFirst();
    releaseFirst();

    expect(limiter.refusalFor('a')).toBeNull();
    limiter.track('a');
    expect(limiter.refusalFor('c')).not.toBeNull();
  });

  it('uses sane LAN defaults', () => {
    const limiter = new ConnectionLimiter();
    for (let index = 0; index < 12; index += 1) limiter.track('192.168.0.2');

    expect(limiter.refusalFor('192.168.0.2')).not.toBeNull();
    expect(limiter.refusalFor('192.168.0.3')).toBeNull();
    for (let index = 0; index < 52; index += 1) limiter.track(`10.0.0.${index}`);
    expect(limiter.refusalFor('192.168.0.99')).toContain('limite de 64 conexões');
  });
});
