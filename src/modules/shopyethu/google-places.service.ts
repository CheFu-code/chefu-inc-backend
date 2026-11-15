import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';

const placesUrl = 'https://places.googleapis.com/v1';
const placeIdPattern = /^[A-Za-z0-9_-]{1,256}$/;
const sessionTokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PlaceSuggestion = {
    placePrediction?: {
        placeId?: unknown;
        text?: { text?: unknown };
    };
};

@Injectable()
export class GooglePlacesService {
    async suggestions(input: unknown, sessionToken: unknown) {
        const query = typeof input === 'string' ? input.trim() : '';
        if (query.length < 3 || query.length > 120) {
            throw new BadRequestException('Search for a town or suburb using 3–120 characters.');
        }
        if (typeof sessionToken !== 'string' || !sessionTokenPattern.test(sessionToken)) {
            throw new BadRequestException('Restart the location search and try again.');
        }

        const result = await this.request(`${placesUrl}/places:autocomplete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                input: query,
                includedRegionCodes: ['za'],
                includedPrimaryTypes: ['(regions)'],
                languageCode: 'en',
                sessionToken,
            }),
        }, 'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text');
        const suggestions = Array.isArray(result.suggestions) ? result.suggestions : [];
        return {
            suggestions: suggestions.flatMap((item: PlaceSuggestion) => {
                const placeId = item.placePrediction?.placeId;
                const text = item.placePrediction?.text?.text;
                return typeof placeId === 'string' && placeIdPattern.test(placeId) &&
                    typeof text === 'string' && text.length > 0
                    ? [{ placeId, text }]
                    : [];
            }),
        };
    }

    async resolve(placeId: unknown, sessionToken?: unknown) {
        if (typeof placeId !== 'string' || !placeIdPattern.test(placeId)) {
            throw new BadRequestException('Choose a valid South African location.');
        }
        if (sessionToken !== undefined && sessionToken !== '' &&
            (typeof sessionToken !== 'string' || !sessionTokenPattern.test(sessionToken))) {
            throw new BadRequestException('Restart the location search and try again.');
        }

        const token = typeof sessionToken === 'string' && sessionToken
            ? `?sessionToken=${encodeURIComponent(sessionToken)}`
            : '';
        const result = await this.request(
            `${placesUrl}/places/${encodeURIComponent(placeId)}${token}`,
            { method: 'GET' },
            'id,formattedAddress,addressComponents',
        );
        const components = Array.isArray(result.addressComponents) ? result.addressComponents : [];
        const country = components.find((component: { types?: unknown }) =>
            Array.isArray(component.types) && component.types.includes('country'));
        if (country?.shortText !== 'ZA' || typeof result.formattedAddress !== 'string') {
            throw new BadRequestException('Choose a location in South Africa.');
        }
        return { placeId, label: result.formattedAddress };
    }

    private async request(url: string, init: RequestInit, fieldMask: string) {
        const apiKey = process.env.GOOGLE_MAPS_PLACES_API_KEY?.trim();
        if (!apiKey) {
            throw new ServiceUnavailableException('Location search is not configured yet.');
        }

        let response: Response;
        try {
            response = await fetch(url, {
                ...init,
                headers: {
                    ...init.headers,
                    'X-Goog-Api-Key': apiKey,
                    'X-Goog-FieldMask': fieldMask,
                },
                signal: AbortSignal.timeout(8_000),
            });
        } catch {
            throw new ServiceUnavailableException('Location search is temporarily unavailable.');
        }
        if (!response.ok) {
            throw new ServiceUnavailableException('Location search is temporarily unavailable.');
        }
        let result: unknown;
        try {
            result = await response.json();
        } catch {
            throw new ServiceUnavailableException('Location search returned an invalid response.');
        }
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
            throw new ServiceUnavailableException('Location search returned an invalid response.');
        }
        return result as Record<string, unknown>;
    }
}
