/**
 * Accepts Indian mobile numbers typed in the usual ways
 * ("98765 43210", "+91-9876543210", "09876543210") and returns E.164 ("+919876543210").
 * Returns null when the input is not a valid Indian mobile number.
 */
export function normalizeIndianMobile(input: string): string | null {
  if (typeof input !== 'string') return null;
  let digits = input.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

/** "+919876543210" -> "+91 98••• ••210" */
export function maskPhone(e164: string): string {
  const d = e164.replace(/^\+91/, '');
  if (d.length !== 10) return '••••••••••';
  return `+91 ${d.slice(0, 2)}••• ••${d.slice(7)}`;
}
