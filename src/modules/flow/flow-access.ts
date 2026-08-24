export const FLOW_SESSION_HEADER = 'x-flow-session';
export const FLOW_ACCESS_DENIED_MESSAGE =
    'This account is not approved for Flow Mail. Please sign in with an authorized sender account to continue.';

/** The only domain permitted when dynamically registering allowed Flow user emails. */
export const FLOW_ALLOWED_EMAIL_DOMAIN = 'chefu.co.za';

export function isFlowSessionRequest(value?: string) {
    return ['1', 'true', 'flow'].includes(String(value || '').toLowerCase());
}

/**
 * Returns true when the email appears in the env FLOW_SENDERS list.
 * If FLOW_SENDERS is empty this returns true (open access), matching the
 * original behaviour. Use this as the fast, synchronous env-only check.
 */
export function isFlowAllowedEmail(value?: string | null) {
    const allowedEmails = flowEnvAllowedEmails();
    if (!allowedEmails.size) return true;

    const email = normalizeEmailAddress(value || '');
    return Boolean(email && allowedEmails.has(email));
}

/**
 * Returns true when the email belongs to the permitted domain
 * (@chefu.co.za). Used to validate emails before storing them in Firestore.
 */
export function isChefuEmail(value: string) {
    const email = normalizeEmailAddress(value);
    if (!email) return false;

    const domain = email.split('@').pop() || '';
    return domain === FLOW_ALLOWED_EMAIL_DOMAIN;
}

/** Parses the FLOW_SENDERS env variable into a Set of bare email addresses. */
export function flowEnvAllowedEmails() {
    return new Set(
        String(process.env.FLOW_SENDERS || '')
            .split(';')
            .map(value => normalizeEmailAddress(value))
            .filter(Boolean),
    );
}

export function normalizeEmailAddress(value: string) {
    const match = value.match(/<([^>]+)>/);
    const email = (match?.[1] || value).trim().toLowerCase();

    return /^\S+@\S+\.\S+$/.test(email) ? email : '';
}

export function formatSenderIdentity(email: string, name?: string | null): string {
    const cleanEmail = normalizeEmailAddress(email);
    const cleanName = (name || '').trim().replace(/[<>"\r\n]/g, '');

    if (!cleanEmail) return '';
    if (!cleanName) return cleanEmail;

    return `${cleanName} <${cleanEmail}>`;
}

export function parseSenderLabel(sender: string): string {
    const match = sender.match(/^(.+?)\s*<(.+?)>$/);
    if (!match) return sender.trim();

    return `${match[1].replace(/^"|"$/g, '').trim()} (${match[2].trim()})`;
}
