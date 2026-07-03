const TRUSTED_IP_HEADERS = [
  'x-nf-client-connection-ip',
  'client-ip',
  'cf-connecting-ip',
  'x-real-ip',
];

function normalizeIpValue(value) {
  return String(value || 'local')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'local';
}

export function requestIpKey(req) {
  for (const header of TRUSTED_IP_HEADERS) {
    const value = req.headers.get(header);
    if (value) return `ip:${normalizeIpValue(value)}`;
  }

  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    return `ip:${normalizeIpValue(forwarded.split(',')[0])}`;
  }

  return 'ip:local';
}
