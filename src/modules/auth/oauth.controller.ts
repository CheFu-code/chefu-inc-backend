import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { OAuthService } from './oauth.service';

@Controller('oauth')
export class OAuthController {
  constructor(private readonly oauthService: OAuthService) {}

  @Get('authorize')
  async authorize(
    @Query()
    query: {
      client_id?: string;
      code_challenge?: string;
      code_challenge_method?: string;
      nonce?: string;
      prompt?: string;
      redirect_uri?: string;
      response_type?: string;
      scope?: string;
      state?: string;
    },
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const { redirectTo } = await this.oauthService.authorize(query, request);
    return response.redirect(302, redirectTo);
  }

  @Post('token')
  @HttpCode(200)
  async token(
    @Body()
    body: {
      client_id?: string;
      code?: string;
      code_verifier?: string;
      grant_type?: string;
      redirect_uri?: string;
    },
    @Req() request: Request,
  ) {
    return this.oauthService.exchangeCode(body, request);
  }

  @Get('userinfo')
  async userinfo(@Headers('authorization') authorization?: string) {
    return this.oauthService.userinfo(authorization);
  }

  @Get('jwks')
  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=300')
  jwks() {
    return this.oauthService.jwks();
  }
}

@Controller('.well-known')
export class OAuthDiscoveryController {
  constructor(private readonly oauthService: OAuthService) {}

  @Get('openid-configuration')
  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=300')
  openidConfiguration() {
    return this.oauthService.metadata();
  }

  @Get('oauth-authorization-server')
  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=300')
  oauthAuthorizationServer() {
    return this.oauthService.authorizationServerMetadata();
  }

  @Get('jwks.json')
  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=300')
  jwks() {
    return this.oauthService.jwks();
  }
}
