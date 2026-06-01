const baseUrl = process.env.SMOKE_BASE_URL;
const routes = ["/health"];

if (!baseUrl) {
  console.log("SMOKE_BASE_URL is not set; skipping smoke checks.");
  process.exit(0);
}

for (const route of routes) {
  const url = new URL(route, baseUrl);
  const response = await fetch(url);

  if (response.status >= 500) {
    throw new Error(`Smoke check failed for ${url}: ${response.status}`);
  }

  console.log(`ok ${response.status} ${url}`);
}
