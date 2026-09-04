import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

function phpUrlEncode(str: string): string {
  return encodeURIComponent(str.trim())
    .replace(/%20/g, '+')
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function generatePayFastSignature(
  fields: Record<string, string | undefined>,
  passphrase?: string,
): { signature: string; parameterString: string } {
  const canonicalOrder = [
    'merchant_id',
    'merchant_key',
    'return_url',
    'cancel_url',
    'notify_url',
    'name_first',
    'name_last',
    'email_address',
    'cell_number',
    'm_payment_id',
    'amount',
    'item_name',
    'item_description',
  ];

  let pfOutput = '';
  for (const key of canonicalOrder) {
    const val = fields[key];
    if (val !== undefined && val !== null && val.trim() !== '') {
      pfOutput += `${key}=${phpUrlEncode(val.trim())}&`;
    }
  }

  let getString = pfOutput.slice(0, -1);
  if (passphrase) {
    getString += `&passphrase=${phpUrlEncode(passphrase)}`;
  }

  const signature = createHash('md5').update(getString).digest('hex');
  return { signature, parameterString: getString };
}

test('generatePayFastSignature orders parameters in canonical PayFast documentation order', () => {
  const fields = {
    merchant_id: '10000100',
    merchant_key: '46f0cd694581a',
    return_url: 'https://drippybanks.chefu.co.za/checkout?payfast_success=true&order_id=ORD-12345678',
    cancel_url: 'https://drippybanks.chefu.co.za/checkout?cancelled=true',
    notify_url: 'https://api.chefu.co.za/drippybanks/payfast/notify',
    name_first: 'John',
    name_last: 'Doe',
    email_address: 'john@example.com',
    cell_number: '0821234567',
    m_payment_id: 'ORD-12345678',
    amount: '1500.00',
    item_name: 'DrippyBanks Order ORD-12345678',
  };

  const passphrase = 'Dr1ppy-B4nks_S3cur3.Fl0w_2026';
  const result = generatePayFastSignature(fields, passphrase);

  // Assert cell_number is placed between email_address and m_payment_id
  const emailIdx = result.parameterString.indexOf('email_address=');
  const cellIdx = result.parameterString.indexOf('cell_number=');
  const paymentIdIdx = result.parameterString.indexOf('m_payment_id=');
  const passphraseIdx = result.parameterString.indexOf('&passphrase=');

  assert.ok(emailIdx < cellIdx, 'email_address must precede cell_number');
  assert.ok(cellIdx < paymentIdIdx, 'cell_number must precede m_payment_id');
  assert.ok(paymentIdIdx < passphraseIdx, 'm_payment_id must precede passphrase');
  assert.ok(result.parameterString.endsWith(`&passphrase=${phpUrlEncode(passphrase)}`));
  assert.equal(typeof result.signature, 'string');
  assert.equal(result.signature.length, 32);
});

test('generatePayFastSignature skips optional fields when absent without corrupting order', () => {
  const fields = {
    merchant_id: '10000100',
    merchant_key: '46f0cd694581a',
    return_url: 'https://drippybanks.chefu.co.za/checkout?payfast_success=true',
    cancel_url: 'https://drippybanks.chefu.co.za/checkout?cancelled=true',
    notify_url: 'https://api.chefu.co.za/drippybanks/payfast/notify',
    name_first: 'Jane',
    name_last: 'Smith',
    email_address: 'jane@example.com',
    m_payment_id: 'ORD-87654321',
    amount: '450.00',
    item_name: 'DrippyBanks Order ORD-87654321',
  };

  const passphrase = 'Dr1ppy-B4nks_S3cur3.Fl0w_2026';
  const result = generatePayFastSignature(fields, passphrase);

  assert.equal(result.parameterString.includes('cell_number='), false);
  assert.equal(result.parameterString.includes('item_description='), false);

  const emailIdx = result.parameterString.indexOf('email_address=');
  const paymentIdIdx = result.parameterString.indexOf('m_payment_id=');
  assert.ok(emailIdx < paymentIdIdx, 'email_address must directly precede m_payment_id when cell_number is absent');
});
