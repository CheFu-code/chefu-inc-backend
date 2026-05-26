import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import crypto from 'crypto';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { AcademySdkApiKey, AcademySdkUser } from './academy-sdk.types';

const ID_TOOLKIT_URL =
  'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=';

type LoginBody = {
  email?: string;
  password?: string;
};

type RegisterBody = LoginBody & {
  fullname?: string;
};

type IdentityToolkitError = {
  error?: {
    message?: string;
  };
};

@Injectable()
export class AcademySdkService {
  private readonly logger = new Logger(AcademySdkService.name);

  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

  verifyApiKey(apiKey?: AcademySdkApiKey) {
    return {
      valid: true,
      plan: apiKey?.plan || 'free',
    };
  }

  async login(body: LoginBody) {
    const email = this.requireString(body.email, 'Email');
    const password = this.requireString(body.password, 'Password');
    const apiKey =
      process.env.FIREBASE_WEB_API_KEY || process.env.FIREBASE_API_KEY;

    if (!apiKey) {
      this.logger.error(
        JSON.stringify({
          event: 'academy_sdk_login_misconfigured',
          reason: 'missing_firebase_web_api_key',
        }),
      );
      throw new HttpException(
        'CheFu Academy SDK login is not configured.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const response = await fetch(`${ID_TOOLKIT_URL}${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
      }),
    });

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({}))) as
        | IdentityToolkitError
        | Record<string, never>;
      this.throwIdentityToolkitError(errorBody, response.status);
    }

    const payload = (await response.json()) as { localId?: string };
    if (!payload.localId) {
      throw new InternalServerErrorException(
        'Failed to login. Please try again.',
      );
    }

    const [token, userRecord] = await Promise.all([
      this.firebaseAdmin.auth().createCustomToken(payload.localId),
      this.firebaseAdmin.auth().getUser(payload.localId),
    ]);

    return {
      token,
      user: this.safeUserPayload({
        uid: userRecord.uid,
        email: userRecord.email,
        displayName: userRecord.displayName,
      }),
    };
  }

  async register(body: RegisterBody) {
    const email = this.requireString(body.email, 'Email');
    const password = this.requireString(body.password, 'Password');
    const fullname = this.requireString(body.fullname, 'Full name');

    if (password.length < 6 || fullname.length < 2) {
      throw new UnprocessableEntityException(
        'Invalid input. Please check your details.',
      );
    }

    try {
      const userRecord = await this.firebaseAdmin.auth().createUser({
        email,
        password,
        displayName: fullname,
        emailVerified: false,
        disabled: false,
      });

      return {
        message: 'Registration successful',
        user: this.safeUserPayload({
          uid: userRecord.uid,
          email: userRecord.email,
          displayName: userRecord.displayName,
        }),
      };
    } catch (error) {
      const code = this.firebaseErrorCode(error);
      if (code === 'auth/email-already-exists') {
        throw new ConflictException(
          'An account with this email already exists.',
        );
      }
      if (code === 'auth/invalid-password' || code === 'auth/invalid-email') {
        throw new UnprocessableEntityException(
          'Invalid input. Please check your details.',
        );
      }

      throw new InternalServerErrorException(
        'Failed to register. Please try again.',
      );
    }
  }

  async createApiKey(user: AcademySdkUser, name?: string) {
    if (!user.uid) {
      throw new UnauthorizedException('Unauthorized attempt to create API key.');
    }

    const { rawKey, hash } = this.generateApiKey();
    await this.firebaseAdmin.db().collection('api_keys').add({
      keyHash: hash,
      name: this.cleanKeyName(name),
      ownerUid: user.uid,
      active: true,
      plan: 'free',
      createdAt: new Date(),
    });

    return {
      apiKey: rawKey,
      warning: 'Save this key now. You will not see it again.',
    };
  }

  async listApiKeys(user: AcademySdkUser) {
    if (!user.uid) {
      throw new UnauthorizedException('Unauthorized attempt to list API keys.');
    }

    const snapshot = await this.firebaseAdmin
      .db()
      .collection('api_keys')
      .where('ownerUid', '==', user.uid)
      .orderBy('createdAt', 'desc')
      .get();

    return snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name || 'Untitled key',
        active: data.active === true,
        plan: data.plan || 'free',
        createdAt: data.createdAt || null,
        lastUsedAt: data.lastUsedAt || null,
      };
    });
  }

  async revokeApiKey(user: AcademySdkUser, keyId?: string) {
    if (!user.uid) {
      throw new UnauthorizedException('Unauthorized attempt to revoke API key.');
    }
    if (!keyId) {
      throw new BadRequestException('API key id is required.');
    }

    const ref = this.firebaseAdmin.db().collection('api_keys').doc(keyId);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      throw new NotFoundException('API key not found.');
    }

    if (snapshot.data()?.ownerUid !== user.uid) {
      throw new ForbiddenException('You cannot revoke this API key.');
    }

    await ref.update({ active: false });
    return { success: true };
  }

  async listCourses() {
    const snapshot = await this.firebaseAdmin.db().collection('course').get();
    const courses = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    return {
      courses,
      total: courses.length,
    };
  }

  async getCourseById(courseId?: string) {
    if (!courseId) {
      throw new BadRequestException('Invalid course ID.');
    }

    const snapshot = await this.firebaseAdmin
      .db()
      .collection('course')
      .doc(courseId)
      .get();

    if (!snapshot.exists) {
      throw new NotFoundException('Course not found.');
    }

    return {
      id: snapshot.id,
      ...snapshot.data(),
    };
  }

  private requireString(value: unknown, label: string) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new UnprocessableEntityException(`${label} is required.`);
    }

    return value.trim();
  }

  private throwIdentityToolkitError(
    errorBody: IdentityToolkitError,
    statusCode?: number,
  ) {
    const code = errorBody.error?.message || '';

    this.logger.warn(
      JSON.stringify({
        event: 'academy_sdk_identity_toolkit_error',
        statusCode: statusCode || null,
        code: code || 'unknown',
      }),
    );

    if (
      code.includes('INVALID_LOGIN_CREDENTIALS') ||
      code.includes('INVALID_PASSWORD') ||
      code.includes('EMAIL_NOT_FOUND') ||
      code.includes('INVALID_EMAIL') ||
      code.includes('INVALID_CREDENTIALS') ||
      code.includes('USER_DISABLED')
    ) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    if (
      code.includes('API_KEY_INVALID') ||
      code.includes('API key not valid') ||
      code.includes('INVALID_API_KEY') ||
      code.includes('PROJECT_NOT_FOUND') ||
      code.includes('CONFIGURATION_NOT_FOUND') ||
      code.includes('OPERATION_NOT_ALLOWED') ||
      code.includes('PASSWORD_LOGIN_DISABLED') ||
      code.includes('ADMIN_ONLY_OPERATION')
    ) {
      throw new HttpException(
        'CheFu Academy SDK login is not configured.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    if (code.includes('TOO_MANY_ATTEMPTS_TRY_LATER')) {
      throw new HttpException(
        'Too many attempts. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (statusCode === 400) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    if (statusCode && statusCode >= 500) {
      throw new HttpException(
        'CheFu Academy authentication is temporarily unavailable.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    throw new InternalServerErrorException('Failed to login. Please try again.');
  }

  private safeUserPayload(user: {
    uid: string;
    email?: string | null;
    displayName?: string | null;
  }) {
    return {
      id: user.uid,
      email: user.email || '',
      fullname: user.displayName || '',
    };
  }

  private firebaseErrorCode(error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'errorInfo' in error &&
      error.errorInfo &&
      typeof error.errorInfo === 'object' &&
      'code' in error.errorInfo
    ) {
      return String(error.errorInfo.code);
    }

    return '';
  }

  private generateApiKey() {
    const rawKey = `ck_${crypto.randomBytes(24).toString('hex')}`;
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');

    return { rawKey, hash };
  }

  private cleanKeyName(name?: string) {
    const value = typeof name === 'string' ? name.trim() : '';
    return value || 'Untitled key';
  }
}
