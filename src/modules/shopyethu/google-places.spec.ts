import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { GooglePlacesService } from './google-places.service';

const sessionToken = '123e4567-e89b-12d3-a456-426614174000';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

void test('autocomplete is country- and area-type-restricted and returns only place suggestions', async t => {
  const previousKey = process.env.GOOGLE_MAPS_PLACES_API_KEY;
  process.env.GOOGLE_MAPS_PLACES_API_KEY = 'test-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.GOOGLE_MAPS_PLACES_API_KEY;
    else process.env.GOOGLE_MAPS_PLACES_API_KEY = previousKey;
  });
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    requestUrl = String(input);
    requestInit = init;
    return jsonResponse({
      suggestions: [
        { placePrediction: { placeId: 'ChIJcapeTown', text: { text: 'Cape Town, South Africa' } } },
        { queryPrediction: { text: { text: 'Cape Town' } } },
      ],
    });
  });

  const result = await new GooglePlacesService().suggestions('Cape Town', sessionToken);
  assert.equal(requestUrl, 'https://places.googleapis.com/v1/places:autocomplete');
  assert.equal(new Headers(requestInit?.headers).get('X-Goog-Api-Key'), 'test-key');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    input: 'Cape Town',
    includedRegionCodes: ['za'],
    includedPrimaryTypes: ['(regions)'],
    languageCode: 'en',
    sessionToken,
  });
  assert.deepEqual(result.suggestions, [
    { placeId: 'ChIJcapeTown', text: 'Cape Town, South Africa' },
  ]);
});

void test('place details validates the selected country and uses the autocomplete session token', async t => {
  const previousKey = process.env.GOOGLE_MAPS_PLACES_API_KEY;
  process.env.GOOGLE_MAPS_PLACES_API_KEY = 'test-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.GOOGLE_MAPS_PLACES_API_KEY;
    else process.env.GOOGLE_MAPS_PLACES_API_KEY = previousKey;
  });
  let requestUrl = '';
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    requestUrl = String(input);
    return jsonResponse({
      formattedAddress: 'Cape Town, South Africa',
      addressComponents: [{ types: ['country', 'political'], shortText: 'ZA' }],
    });
  });

  const result = await new GooglePlacesService().resolve('ChIJcapeTown', sessionToken);
  assert.equal(result.label, 'Cape Town, South Africa');
  assert.match(requestUrl, /places\/ChIJcapeTown\?sessionToken=123e4567/);
});

void test('place details rejects locations outside South Africa', async t => {
  const previousKey = process.env.GOOGLE_MAPS_PLACES_API_KEY;
  process.env.GOOGLE_MAPS_PLACES_API_KEY = 'test-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.GOOGLE_MAPS_PLACES_API_KEY;
    else process.env.GOOGLE_MAPS_PLACES_API_KEY = previousKey;
  });
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({
    formattedAddress: 'London, United Kingdom',
    addressComponents: [{ types: ['country'], shortText: 'GB' }],
  }));
  await assert.rejects(
    new GooglePlacesService().resolve('ChIJoutside'),
    (error: BadRequestException) => error.getStatus() === 400,
  );
});

void test('location requests fail explicitly when the server key is not configured', async t => {
  const previousKey = process.env.GOOGLE_MAPS_PLACES_API_KEY;
  delete process.env.GOOGLE_MAPS_PLACES_API_KEY;
  t.after(() => {
    if (previousKey !== undefined) process.env.GOOGLE_MAPS_PLACES_API_KEY = previousKey;
  });
  await assert.rejects(
    new GooglePlacesService().suggestions('Cape Town', sessionToken),
    (error: ServiceUnavailableException) => error.getStatus() === 503,
  );
});
