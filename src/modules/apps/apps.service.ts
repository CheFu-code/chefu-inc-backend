import { Injectable } from '@nestjs/common';
import {
  CHEFU_APPS,
  ChefuApp,
  ChefuAppId,
  registeredAppOrigins,
  resolveChefuAppId,
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
}
