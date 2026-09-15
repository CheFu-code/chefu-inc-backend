const apiBaseUrl = process.env.STAGING_API_URL;
const flowBaseUrl = process.env.STAGING_FLOW_URL;

if (!apiBaseUrl || !flowBaseUrl) {
  throw new Error('STAGING_API_URL and STAGING_FLOW_URL are required.');
}

await checkPage(flowBaseUrl, '/');
await checkPage(flowBaseUrl, '/login');
await checkHealth(apiBaseUrl);
await checkInboundRequiresAuthentication(apiBaseUrl);

if (process.env.STAGING_FLOW_WRITE_TEST === 'true') {
  await checkSanitizedInboundRoundTrip(apiBaseUrl);
} else {
  console.log('Skipped authenticated inbound round-trip. Set STAGING_FLOW_WRITE_TEST=true to enable it.');
}

async function checkPage(baseUrl, path) {
  const response = await fetch(new URL(path, baseUrl));
  if (response.status >= 500) {
    throw new Error(`Flow page check failed for ${response.url}: ${response.status}`);
  }
  console.log(`ok ${response.status} ${response.url}`);
}

async function checkHealth(baseUrl) {
  const response = await fetch(new URL('/health', baseUrl));
  if (!response.ok) {
    throw new Error(`Backend health check failed: ${response.status}`);
  }
  console.log(`ok ${response.status} ${response.url}`);
}

async function checkInboundRequiresAuthentication(baseUrl) {
  const response = await fetch(new URL('/flow/inbound', baseUrl), {
    body: JSON.stringify({
      type: 'email.received',
      data: {
        message_id: `security-check-${Date.now()}`,
        from: 'security-check@example.invalid',
        subject: 'Unauthenticated security check',
        html: '<p>must not be accepted</p>',
      },
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });

  if (![401, 403].includes(response.status)) {
    throw new Error(`Inbound authentication check failed: expected 401/403, got ${response.status}`);
  }
  console.log(`ok ${response.status} unauthenticated inbound rejected`);
}

async function checkSanitizedInboundRoundTrip(baseUrl) {
  const apiKey = process.env.STAGING_FLOW_API_KEY;
  if (!apiKey) throw new Error('STAGING_FLOW_API_KEY is required for the write test.');

  const messageId = `security-check-${Date.now()}`;
  const payload = {
    type: 'email.received',
    data: {
      message_id: messageId,
      from: 'security-check@example.invalid',
      to: 'mail@flow.chefu.co.za',
      subject: 'Sanitizer security check',
      html: '<svg/onload=alert(1)><a href="java&#x73;cript:alert(1)">unsafe</a><p>safe</p>',
      text: 'safe',
    },
  };
  const headers = {
    'content-type': 'application/json',
    'x-flow-api-key': apiKey,
  };

  try {
    const inbound = await fetch(new URL('/flow/inbound', baseUrl), {
      body: JSON.stringify(payload),
      headers,
      method: 'POST',
    });
    if (!inbound.ok) {
      throw new Error(`Authenticated inbound check failed: ${inbound.status} ${await inbound.text()}`);
    }

    const detail = await fetch(
      new URL(`/flow/messages/${encodeURIComponent(messageId)}`, baseUrl),
      { headers: { 'x-flow-api-key': apiKey } },
    );
    if (!detail.ok) {
      throw new Error(`Inbound detail check failed: ${detail.status}`);
    }

    const body = await detail.json();
    const html = body?.message?.html || '';
    if (/svg|onload|javascript:/i.test(html) || !html.includes('<p>safe</p>')) {
      throw new Error(`Sanitized inbound HTML check failed: ${html}`);
    }
    console.log(`ok ${detail.status} inbound HTML sanitized`);
  } finally {
    await fetch(new URL(`/flow/messages/${encodeURIComponent(messageId)}`, baseUrl), {
      headers: { 'x-flow-api-key': apiKey },
      method: 'DELETE',
    }).catch(() => {});
  }
}
