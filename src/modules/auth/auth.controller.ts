import { Controller } from '@nestjs/common';
import { AuthProfilePictureRoutes } from './auth-profile-picture.routes';

@Controller('auth')
export class AuthController extends AuthProfilePictureRoutes {}
