import { Controller, Get, INestApplication, Req, UseGuards, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Request } from 'express';
import request from 'supertest';

import { AuthenticatedUser } from '../src/modules/auth/authenticated-user';
import { AuthGuard } from '../src/modules/auth/auth.guard';
import { HoneytokenService } from '../src/modules/auth/honeytoken.service';
import { OAuthAccessTokenClaims, OAuthService } from '../src/modules/auth/oauth.service';
import { SessionSignerService } from '../src/modules/auth/session-signer.service';
import { FirebaseAdminService } from '../src/modules/firebase-admin/firebase-admin.service';

type RequestWithUser = Request & {
  user?: AuthenticatedUser;
};

type FirebaseAuthMock = {
  verifyIdToken: jest.Mock;
  verifySessionCookie: jest.Mock;
};

@Controller('security-test')
@UseGuards(AuthGuard)
class SecurityTestController {
  @Get('me')
  me(@Req() request: RequestWithUser) {
    return {
      email: request.user?.email,
      roles: request.user?.roles ?? [],
      uid: request.user?.uid,
    };
  }
}

describe('AuthGuard integration security behavior', () => {
  let app: INestApplication;
  let firebaseAuth: FirebaseAuthMock;
  let honeytokens: { inspectRequest: jest.Mock };
  let oauthService: { verifyAccessToken: jest.Mock };

  beforeEach(async () => {
    firebaseAuth = {
      verifyIdToken: jest.fn(),
      verifySessionCookie: jest.fn(),
    };
    honeytokens = {
      inspectRequest: jest.fn(async () => undefined),
    };
    oauthService = {
      verifyAccessToken: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [SecurityTestController],
      providers: [
        AuthGuard,
        {
          provide: FirebaseAdminService,
          useValue: {
            auth: () => firebaseAuth,
            db: () => ({
              collection: () => ({
                doc: () => ({
                  get: async () => ({
                    data: () => ({ roles: ['user'] }),
                  }),
                }),
              }),
            }),
          },
        },
        {
          provide: OAuthService,
          useValue: oauthService,
        },
        {
          provide: HoneytokenService,
          useValue: honeytokens,
        },
        {
          provide: SessionSignerService,
          useValue: {
            verify: jest.fn(() => null),
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('blocks requests without a real bearer token or session cookie', async () => {
    await request(app.getHttpServer()).get('/security-test/me').expect(401);

    expect(honeytokens.inspectRequest).toHaveBeenCalledTimes(1);
    expect(firebaseAuth.verifyIdToken).not.toHaveBeenCalled();
    expect(oauthService.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('blocks expired SSO access tokens with 401', async () => {
    firebaseAuth.verifyIdToken.mockRejectedValue(new Error('not firebase'));
    oauthService.verifyAccessToken.mockRejectedValue(
      new UnauthorizedException('Access token has expired.'),
    );

    await request(app.getHttpServer())
      .get('/security-test/me')
      .set('Authorization', 'Bearer expired-token')
      .expect(401);

    expect(oauthService.verifyAccessToken).toHaveBeenCalledWith(
      'expired-token',
      expect.any(Object),
      undefined,
    );
  });

  it('does not trust spoofed identity headers without authentication', async () => {
    await request(app.getHttpServer())
      .get('/security-test/me')
      .set('x-chefu-app', 'quantum')
      .set('x-chefu-user-id', 'attacker')
      .set('x-forwarded-email', 'attacker@example.com')
      .expect(401);

    expect(firebaseAuth.verifyIdToken).not.toHaveBeenCalled();
    expect(oauthService.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('allows a verified OAuth bearer token and exposes sanitized user context', async () => {
    const claims: OAuthAccessTokenClaims = {
      aud: 'https://api.chefuinc.com',
      email: 'user@chefuinc.com',
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      iss: 'https://api.chefuinc.com',
      jti: 'token-1',
      nbf: Math.floor(Date.now() / 1000),
      roles: ['user'],
      sub: 'user-1',
      typ: 'access_token',
    };

    firebaseAuth.verifyIdToken.mockRejectedValue(new Error('not firebase'));
    oauthService.verifyAccessToken.mockResolvedValue(claims);

    await request(app.getHttpServer())
      .get('/security-test/me')
      .set('Authorization', 'Bearer valid-oauth-token')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          email: 'user@chefuinc.com',
          roles: ['user'],
          uid: 'user-1',
        });
      });
  });
});
