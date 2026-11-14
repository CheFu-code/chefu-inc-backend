import { BadRequestException, ConflictException, HttpException, Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PhoneVerificationRecords, type PhoneChallenge, type PhoneRecords, type VerifiedPhone } from './phone-verification.records';
import { PHONE_LEASE_MS, PHONE_MAX_CHECKS, PHONE_TTL_MS, phoneLimit, PhoneVerificationPolicy } from './phone-verification.policy';
import { TwilioVerificationProvider, type VerificationProvider } from './phone-verification.provider';

@Injectable()
export class PhoneVerificationService {
  constructor(
    @Inject(PhoneVerificationRecords) private readonly records: PhoneRecords,
    private readonly policy: PhoneVerificationPolicy,
    @Inject(TwilioVerificationProvider) private readonly provider: VerificationProvider,
  ) {}
  private identity(uid: string) {
    if (typeof uid !== 'string' || !uid.trim() || uid.length > 128) throw new UnauthorizedException('Authentication required.');
  }
  private async stored<T>(work: () => Promise<T>) {
    try { return await work(); }
    catch (cause) {
      if (cause instanceof HttpException) throw cause;
      throw new ServiceUnavailableException('Phone verification storage is temporarily unavailable.');
    }
  }
  async status(uid: string) {
    this.identity(uid);
    const receipt = await this.stored(() => this.records.get<VerifiedPhone>('verified', uid));
    return receipt?.uid === uid
      ? { verified: true as const, phone: receipt.phone, verifiedAt: receipt.verifiedAt }
      : { verified: false as const };
  }
  async sendCode(uid: string, input: unknown, ip = 'unknown') {
    this.identity(uid); this.policy.assertEnabled();
    const phone = this.policy.normalise(input);
    const verified = await this.status(uid);
    if (verified.verified && verified.phone === phone) return { ...verified, resendAfterSeconds: 0, expiresInSeconds: 0 };
    this.provider.assertConfigured();
    await this.policy.send(uid, phone, ip);
    const now = Date.now(), nonce = randomUUID();
    const challenge = await this.stored(() => this.records.transaction(async tx => {
      const previous = await tx.get<PhoneChallenge>('challenges', uid);
      if (previous && ['sending', 'checking'].includes(previous.state) && previous.leaseUntilMs > now) throw phoneLimit((previous.leaseUntilMs - now) / 1000);
      const same = previous?.phone === phone && previous.expiresAtMs > now;
      const next: PhoneChallenge = {
        uid, phone, nonce, state: 'sending', attempts: same ? previous!.attempts : 0,
        expiresAtMs: same ? previous!.expiresAtMs : now + PHONE_TTL_MS, leaseUntilMs: now + PHONE_LEASE_MS,
        ...(same && previous?.verificationSid ? { verificationSid: previous.verificationSid } : {}),
      };
      if (same && next.attempts >= PHONE_MAX_CHECKS) throw phoneLimit((next.expiresAtMs - now) / 1000);
      tx.set('challenges', uid, next); return next;
    }));
    // Never call a paid provider inside a retried Firestore transaction.
    const sid = await this.provider.start(phone);
    const saved = await this.stored(() => this.records.transaction(async tx => {
      const current = await tx.get<PhoneChallenge>('challenges', uid);
      if (current?.nonce !== nonce || current.state !== 'sending') throw new ConflictException('Your verification changed. Request a new code.');
      const same = challenge.verificationSid === sid;
      const next: PhoneChallenge = { ...current, verificationSid: sid, state: 'pending', leaseUntilMs: 0,
        attempts: same ? challenge.attempts : 0, expiresAtMs: same ? challenge.expiresAtMs : now + PHONE_TTL_MS };
      tx.set('challenges', uid, next); return next;
    }));
    return { phone, verified: false, resendAfterSeconds: 30, expiresInSeconds: Math.max(0, Math.floor((saved.expiresAtMs - Date.now()) / 1000)) };
  }
  async checkCode(uid: string, input: unknown, code: unknown, ip = 'unknown') {
    this.identity(uid); this.policy.assertEnabled();
    const phone = this.policy.normalise(input);
    if (typeof code !== 'string' || !/^\d{4,10}$/.test(code)) throw new BadRequestException('Enter the numeric code from your message.');
    await this.policy.check(uid, ip);
    const verified = await this.status(uid);
    if (verified.verified && verified.phone === phone) return verified;
    this.provider.assertConfigured();
    const now = Date.now(), checkToken = randomUUID();
    const challenge = await this.stored(() => this.records.transaction(async tx => {
      const current = await tx.get<PhoneChallenge>('challenges', uid);
      if (!current || current.uid !== uid || current.phone !== phone || current.expiresAtMs <= now || !current.verificationSid) {
        throw new BadRequestException('Request a new code for this phone number.');
      }
      if (['sending', 'checking'].includes(current.state) && current.leaseUntilMs > now) throw phoneLimit((current.leaseUntilMs - now) / 1000);
      if (current.state === 'sending' || current.state === 'approved') throw new BadRequestException('Request a new code for this phone number.');
      if (current.attempts >= PHONE_MAX_CHECKS) throw phoneLimit((current.expiresAtMs - now) / 1000);
      const next: PhoneChallenge = { ...current, attempts: current.attempts + 1, state: 'checking', checkToken, leaseUntilMs: now + PHONE_LEASE_MS };
      tx.set('challenges', uid, next); return next;
    }));
    let approved: boolean;
    try { approved = await this.provider.check(challenge.verificationSid!, phone, code); }
    catch (cause) {
      await this.finishCheck(challenge, checkToken, false);
      throw cause;
    }
    const receipt = await this.finishCheck(challenge, checkToken, approved);
    if (!approved || !receipt) throw new BadRequestException({ message: 'That code is incorrect.', attemptsRemaining: Math.max(0, PHONE_MAX_CHECKS - challenge.attempts) });
    return { verified: true as const, phone: receipt.phone, verifiedAt: receipt.verifiedAt };
  }
  private finishCheck(challenge: PhoneChallenge, checkToken: string, approved: boolean) {
    return this.stored(() => this.records.transaction(async tx => {
      const current = await tx.get<PhoneChallenge>('challenges', challenge.uid);
      if (current?.nonce !== challenge.nonce || current.checkToken !== checkToken || current.state !== 'checking' || current.expiresAtMs <= Date.now()) {
        if (approved) throw new ConflictException('Your verification changed or expired. Request a new code.');
        return null;
      }
      const next: PhoneChallenge = { ...current, state: approved ? 'approved' : 'pending', leaseUntilMs: 0 };
      const receipt: VerifiedPhone | null = approved ? { uid: current.uid, phone: current.phone, verifiedAt: new Date().toISOString(), provider: 'twilio-verify' } : null;
      tx.set('challenges', current.uid, next);
      if (receipt) tx.set('verified', current.uid, receipt);
      return receipt;
    }));
  }
}
