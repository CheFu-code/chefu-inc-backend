export const COLLECTION = 'cloudenceFiles';
export const AUDIT_COLLECTION = 'cloudence_audit_logs';
export const QUOTA_COLLECTION = 'cloudence_quotas';
export const MAX_STORAGE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB quota per user
export const MAX_SHARE_RECIPIENTS = 25; // Anti-phishing / anti-spam share cap
export const ALLOWED_TYPES = new Set(['document', 'image', 'video', 'audio', 'other']);

// Block executables, scripts, and potential malware vectors
export const BLOCKED_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'psd1',
  'msi', 'msp', 'scr', 'pif', 'com', 'hta', 'cpl', 'vbs', 'vbe', 'wsf', 'wsh',
  'php', 'php3', 'php4', 'php5', 'phtml', 'phar',
  'py', 'pyc', 'pyo', 'pyw', 'rb', 'pl', 'cgi',
  'jar', 'war', 'ear',
  'dll', 'so', 'dylib', 'sys', 'drv',
  'js', 'mjs', 'cjs', 'ts',
]);

export const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
