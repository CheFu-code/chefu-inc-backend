import {
  BadRequestException,
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
      response_mode?: string;
      response_type?: string;
      scope?: string;
      state?: string;
    },
    @Req() request: Request,
    @Res() response: Response,
  ) {
    try {
      const { redirectTo } = await this.oauthService.authorize(query, request);
      return response.redirect(302, redirectTo);
    } catch (error) {
      const redirectTo = this.extractRedirectTo(error);
      if (redirectTo) {
        return response.redirect(302, redirectTo);
      }

      throw error;
    }
  }

  @Post('token')
  @HttpCode(200)
  async token(
    @Body()
    body: {
      audience?: string;
      client_assertion?: string;
      client_assertion_type?: string;
      client_id?: string;
      code?: string;
      code_verifier?: string;
      grant_type?: string;
      redirect_uri?: string;
      refresh_token?: string;
      requested_token_type?: string;
      scope?: string;
      subject_token?: string;
      subject_token_type?: string;
    },
    @Headers('dpop') dpop: string | undefined,
    @Req() request: Request,
  ) {
    return this.oauthService.token(body, request, dpop);
  }

  @Post('revoke')
  @HttpCode(200)
  async revoke(
    @Body()
    body: {
      client_id?: string;
      token?: string;
      token_type_hint?: string;
    },
    @Headers('dpop') dpop: string | undefined,
    @Req() request: Request,
  ) {
    return this.oauthService.revoke(body, request, dpop);
  }

  @Get('userinfo')
  async userinfo(
    @Headers('authorization') authorization: string | undefined,
    @Headers('dpop') dpop: string | undefined,
    @Req() request: Request,
  ) {
    return this.oauthService.userinfo(authorization, request, dpop);
  }

  @Get('jwks')
  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=300')
  jwks() {
    return this.oauthService.jwks();
  }

  private extractRedirectTo(error: unknown) {
    if (!(error instanceof BadRequestException)) {
      return null;
    }

    const response = error.getResponse();
    if (
      response &&
      typeof response === 'object' &&
      'redirect_to' in response &&
      typeof response.redirect_to === 'string'
    ) {
      return response.redirect_to;
    }

    return null;
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
