import { Injectable } from '@nestjs/common';
import {
  CHEFU_APPS,
  ChefuApp,
  ChefuAppId,
  ChefuOauthClient,
  registeredAppOrigins,
  registeredOauthClients,
  resolveChefuAppId,
  resolveOauthClient,
} from './app-registry';

@Injectable()
export class AppsService {
  list(): ChefuApp[] {
    return CHEFU_APPS;
  }

  origins() {
    return registeredAppOrigins();
  }

  resolveId(value?: string): ChefuAppId | null {
    return resolveChefuAppId(value);
  }

  oauthClients(): ChefuOauthClient[] {
    return registeredOauthClients();
  }

  resolveOauthClient(clientId?: string): ChefuOauthClient | null {
    return resolveOauthClient(clientId);
  }
}
