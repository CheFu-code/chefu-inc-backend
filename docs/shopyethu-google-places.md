# ShopYethu Google Places setup

The seller operating-area picker uses Places API (New) from the backend. Configure
`GOOGLE_MAPS_PLACES_API_KEY` as a backend secret; do not put it in an Expo
`EXPO_PUBLIC_*` variable or the mobile app.

In Google Cloud:

1. Enable Places API (New) and billing for the project.
2. Restrict the key to Places API (New) and the backend's outbound IP addresses.
3. Configure API quotas and billing alerts for Autocomplete and Place Details.

Autocomplete requests include `includedRegionCodes: ["za"]` and request region
results only. Place Details verifies the selected place is in South Africa.
Suggestion labels are shown with Google Maps attribution but are not persisted.
Only the selected Place ID is saved; app screens resolve its label live using a
`Cache-Control: no-store` endpoint. Keep this behavior when changing location
forms or client caching.

The location API routes share a per-IP request budget to limit upstream usage.
