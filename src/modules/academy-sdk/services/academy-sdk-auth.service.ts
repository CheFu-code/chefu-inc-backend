import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { FirebaseAdminService } from '../../firebase-admin/firebase-admin.service';
import {
  ACADEMY_SDK_ID_TOOLKIT_URL,
  ACADEMY_SDK_SECURE_TOKEN_URL,
} from '../academy-sdk.constants';

type LoginBody = {
  email?: string;
  password?: string;
};

type RegisterBody = LoginBody & {
  fullname?: string;
};

type RefreshBody = {
  refreshToken?: string;
};

type IdentityToolkitError = {
  error?: {
    message?: string;
  };
};

@Injectable()
export class AcademySdkAuthService {
  private readonly logger = new Logger(AcademySdkAuthService.name);

  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

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

    const response = await fetch(
      `${ACADEMY_SDK_ID_TOOLKIT_URL}${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          returnSecureToken: true,
        }),
      },
    );

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({}))) as
        | IdentityToolkitError
        | Record<string, never>;
      this.throwIdentityToolkitError(errorBody, response.status);
    }

    const payload = (await response.json()) as {
      localId?: string;
      idToken?: string;
      refreshToken?: string;
      expiresIn?: string;
    };
    if (!payload.localId) {
      throw new InternalServerErrorException(
        'Failed to login. Please try again.',
      );
    }

    const [customToken, userRecord] = await Promise.all([
      this.firebaseAdmin.auth().createCustomToken(payload.localId),
      this.firebaseAdmin.auth().getUser(payload.localId),
    ]);

    return {
      token: payload.idToken || customToken,
      idToken: payload.idToken || '',
      refreshToken: payload.refreshToken || '',
      expiresIn: payload.expiresIn || '',
      customToken,
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
      await this.saveDeveloperProfile({
        uid: userRecord.uid,
        email: userRecord.email || email,
        fullname,
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

  async refreshSession(body: RefreshBody) {
    const refreshToken = this.requireString(body.refreshToken, 'Refresh token');
    const apiKey =
      process.env.FIREBASE_WEB_API_KEY || process.env.FIREBASE_API_KEY;

    if (!apiKey) {
      this.logger.error(
        JSON.stringify({
          event: 'academy_sdk_refresh_misconfigured',
          reason: 'missing_firebase_web_api_key',
        }),
      );
      throw new HttpException(
        'CheFu Academy SDK login is not configured.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const response = await fetch(
      `${ACADEMY_SDK_SECURE_TOKEN_URL}${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      },
    );

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({}))) as
        | IdentityToolkitError
        | Record<string, never>;
      this.throwIdentityToolkitError(errorBody, response.status);
    }

    const payload = (await response.json()) as {
      id_token?: string;
      refresh_token?: string;
      expires_in?: string;
      user_id?: string;
    };

    if (!payload.id_token) {
      throw new InternalServerErrorException(
        'Failed to refresh session. Please login again.',
      );
    }

    return {
      token: payload.id_token,
      idToken: payload.id_token,
      refreshToken: payload.refresh_token || refreshToken,
      expiresIn: payload.expires_in || '',
      userId: payload.user_id || '',
    };
  }

  private async saveDeveloperProfile(user: {
    uid: string;
    email: string;
    fullname: string;
  }) {
    const now = new Date();
    const normalizedEmail = user.email.trim().toLowerCase();

    await this.firebaseAdmin
      .db()
      .collection('users')
      .doc(normalizedEmail)
      .set(
        {
          id: user.uid,
          uid: user.uid,
          email: normalizedEmail,
          fullname: user.fullname,
          name: user.fullname,
          profilePicture: null,
          bio: '',
          country: '',
          countryCode: '',
          fcmToken: null,
          isVerified: false,
          language: 'en',
          learningGoal: '',
          skillLevel: 'beginner',
          learningInterests: [],
          weeklyLearningGoal: 3,
          lessonStyle: 'example-heavy',
          defaultCourseDifficulty: 'beginner',
          preferredContentFormat: 'examples',
          aiTutorSuggestions: true,
          privacy: {
            publicProfile: false,
            showCompletedCourses: false,
            showCountry: true,
            personalizedAiRecommendations: true,
          },
          lastLogin: now,
          lastSeen: now,
          member: false,
          memberUntil: null,
          favoriteCourseIds: [],
          onboardingComplete: false,
          appGuideComplete: false,
          provider: 'sdk',
          roles: ['student', 'developer'],
          subscriptionStatus: 'free',
          accountType: 'developer',
          accountStatus: 'active',
          developer: true,
          sdkDeveloper: true,
          source: 'academy-sdk',
          createdAt: now,
          updatedAt: now,
          emailPreferences: {
            activity: false,
            general: false,
            marketing: false,
            security: true,
            courseReminders: true,
            aiCourseCompletion: true,
            weeklyProgressSummary: false,
          },
          deviceInfo: {
            deviceBrand: 'Unknown',
            deviceModel: 'Unknown',
            deviceName: 'SDK',
            isRTL: false,
            isTablet: false,
            manufacturer: 'Unknown',
            orientation: 'unknown',
            os: 'unknown',
            osVersion: 0,
            screenHeight: 0,
            screenWidth: 0,
            totalMemory: 0,
          },
        },
        { merge: true },
      );
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
      code.includes('are blocked') ||
      code.includes('API key restrictions') ||
      code.includes('SignInWithPassword') ||
      code.includes('OPERATION_NOT_ALLOWED') ||
      code.includes('PASSWORD_LOGIN_DISABLED') ||
      code.includes('ADMIN_ONLY_OPERATION') ||
      statusCode === 403
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
}
