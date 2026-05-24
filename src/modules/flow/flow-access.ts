export const FLOW_SESSION_HEADER = 'x-flow-session';
export const FLOW_ACCESS_DENIED_MESSAGE =
  'This account is not approved for Flow Mail. Sign in with an approved CheFu sender account to continue.';

export function isFlowSessionRequest(value?: string) {
  return ['1', 'true', 'flow'].includes(String(value || '').toLowerCase());
}

export function isFlowAllowedEmail(value?: string | null) {
  const allowedEmails = flowAllowedEmails();
  if (!allowedEmails.size) return true;

  const email = emailAddress(value || '');
  return Boolean(email && allowedEmails.has(email));
}

function flowAllowedEmails() {
  return new Set(
    String(process.env.FLOW_SENDERS || '')
      .split(';')
      .map(value => emailAddress(value))
      .filter(Boolean),
  );
}

function emailAddress(value: string) {
  const match = value.match(/<([^>]+)>/);
  const email = (match?.[1] || value).trim().toLowerCase();

  return /^\S+@\S+\.\S+$/.test(email) ? email : '';
}
