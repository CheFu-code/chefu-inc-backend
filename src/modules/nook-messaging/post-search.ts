export function postSearchTokens(value: string) {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return [...new Set(normalized.match(/[\p{L}\p{N}]{2,32}/gu) ?? [])].slice(0, 30);
}
