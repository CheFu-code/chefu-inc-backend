# Country detection

Country is approximate network metadata for account display and sign-in alert
context. It is not proof of residence, identity or phone ownership. A VPN can
change the apparent country. Never use it to grant account or seller permissions.

## Deployment

Detection is disabled by default. Select exactly one provider using
`COUNTRY_HEADER_PROVIDER` and list the actual immediate reverse-proxy IPs/CIDRs in
`TRUSTED_PROXY_IPS`. Unsupported providers, missing proxy addresses, wildcard/hop
trust and `/0` ranges fail startup when detection is enabled.

| Provider | Accepted header |
| --- | --- |
| `cloudflare` | `cf-ipcountry` |
| `vercel` | `x-vercel-ip-country` |
| `cloudfront` | `cloudfront-viewer-country` |
| `appengine` | `x-appengine-country` |
| `proxy` | `x-country-code` |

The selected proxy must **remove client-supplied values and overwrite the selected
header with its own geolocation result**. An IP allowlist alone cannot prevent
spoofing if a trusted proxy forwards arbitrary client headers. For multiple proxy
hops, enforce this throughout the chain; do not trust arbitrary traffic from a
shared hosting network. Restrict origin access to the controlled proxy where
possible. Do not enable a provider solely because a request contains its header.

The backend checks the actual TCP peer against Express's configured trust
function. `X-Forwarded-For`, provider-looking headers and the browser's origin
cannot establish country-header trust. IPv4, IPv6 and mapped IPv4 addresses use
the existing Express IP/CIDR matching. Untrusted connections return no country.

Only the configured provider is used. Missing/invalid values do not fall back to
other country headers. Duplicate headers (including different casing), arrays,
comma-separated lists and non-ISO 3166-1 alpha-2 codes are rejected. Provider
sentinels such as `XX` and `T1` return no country. Valid codes are normalized to
uppercase. No default country is invented when detection fails.

## Storage and cost

The configuration is captured once at startup. Detection does not call a
geolocation service, access GPS, poll, or read/write a database.

The existing `/auth/me` profile read supplies the saved country and timestamp.
An unchanged country writes at most once per 24 hours; changes update immediately.
Invalid timestamps or dates over five minutes in the future are refreshed; small
clock differences are tolerated. Missing/untrusted headers
produce no country write and preserve previously saved metadata. Existing
sign-in/profile writes may also include country metadata; no separate lookup was
added. Historical country values were not reverified or migrated by this change.
