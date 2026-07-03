export function jsonResponse(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', init.cacheControl || 'no-store');
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

export function errorResponse(status, message) {
  return jsonResponse({ detail: message }, { status });
}

export async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

export function methodNotAllowed(allowed) {
  return jsonResponse(
    { detail: `Method not allowed. Use ${allowed.join(', ')}` },
    {
      status: 405,
      headers: { allow: allowed.join(', ') },
    },
  );
}
