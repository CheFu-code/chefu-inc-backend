import {
    Controller,
    Get,
    Header,
    ServiceUnavailableException,
} from '@nestjs/common';

const PACKAGE_NAME = 'za.co.chefu.shopyethu';
const RELEASE_FINGERPRINT =
    '96:A8:D7:C8:37:1E:E5:A7:CC:C9:2C:83:94:2E:08:46:96:03:53:2B:40:AE:E6:53:20:57:0D:30:8F:14:4E:5D';

@Controller('.well-known')
export class ShopYethuAppLinksController {
    @Get('assetlinks.json')
    @Header('Cache-Control', 'public, max-age=3600')
    androidAssetLinks() {
        const configuredFingerprints = RELEASE_FINGERPRINT;
        const fingerprints = configuredFingerprints
            .split(',')
            .map(value => value.replace(/:/g, '').trim().toUpperCase())
            .filter(Boolean);

        if (
            !fingerprints.length ||
            fingerprints.some(value => !/^[A-F0-9]{64}$/.test(value))
        ) {
            throw new ServiceUnavailableException(
                'Android App Links signing fingerprints are not configured.',
            );
        }

        return [
            {
                relation: ['delegate_permission/common.handle_all_urls'],
                target: {
                    namespace: 'android_app',
                    package_name: PACKAGE_NAME,
                    sha256_cert_fingerprints: fingerprints.map(value =>
                        value.replace(/(..)(?=.)/g, '$1:'),
                    ),
                },
            },
        ];
    }

    @Get('apple-app-site-association')
    @Header('Cache-Control', 'public, max-age=3600')
    appleAppSiteAssociation() {
        const teamId = process.env.SHOPYETHU_APPLE_TEAM_ID
            ?.trim()
            .toUpperCase();

        if (!teamId || !/^[A-Z0-9]{10}$/.test(teamId)) {
            throw new ServiceUnavailableException(
                'ShopYethu Apple Developer Team ID is not configured.',
            );
        }

        return {
            applinks: {
                apps: [],
                details: [
                    {
                        appID: `${teamId}.${PACKAGE_NAME}`,
                        paths: ['/shopyethu/store/*'],
                    },
                ],
            },
        };
    }
}
