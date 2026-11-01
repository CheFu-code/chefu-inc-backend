/**
 * Advisory session risk signals. These never grant access or block authentication.
 * Authentication and trusted-device enforcement remain in their existing handlers.
 */
export type SessionRiskSignals = {
  score: number;
  level: 'low' | 'elevated' | 'high';
  reasons: string[];
};

export function assessSessionRisk(input: {
  trustedDevice: boolean;
  userAgent?: string | null;
  appId: string;
}): SessionRiskSignals {
  const reasons: string[] = [];
  let score = 0;

  if (!input.trustedDevice) {
    score += 30;
    reasons.push('unrecognized_device');
  }

  const userAgent = (input.userAgent || '').trim();
  if (!userAgent) {
    score += 20;
    reasons.push('missing_user_agent');
  } else if (/\b(?:curl|wget|python-requests|httpie)\b/i.test(userAgent)) {
    score += 35;
    reasons.push('automation_user_agent');
  }

  // Admin sign-ins deserve closer monitoring, not automatic rejection.
  if (input.appId === 'admin' && !input.trustedDevice) {
    score += 15;
    reasons.push('unrecognized_admin_device');
  }

  return {
    score: Math.min(100, score),
    level: score >= 60 ? 'high' : score >= 30 ? 'elevated' : 'low',
    reasons,
  };
}
