import { isIP } from 'node:net';

export function getTrustedProxyAddresses(value?: string) {
  if (!value?.trim()) return [];

  const addresses = value.split(',').map(entry => entry.trim());
  if (
    addresses.some(
      entry =>
        !entry ||
        entry === '*' ||
        /^(true|false|\d+)$/.test(entry) ||
        !isExplicitProxyAddress(entry),
    )
  ) {
    throw new Error(
      'TRUSTED_PROXY_IPS must contain only explicit IP addresses or CIDR ranges.',
    );
  }
  return [...new Set(addresses)];
}

function isExplicitProxyAddress(value: string) {
  const [address, prefix, ...extra] = value.split('/');
  if (extra.length || !address) return false;

  const version = isIP(address);
  if (version === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;

  const bits = Number(prefix);
  return bits >= 0 && bits <= (version === 4 ? 32 : 128);
}
