import { describe, expect, test } from 'vitest';
import { normalizePhone } from '../src/scm/shared/phone';

// The scan path used to carry its own normalizeMyPhone(), which returned the
// bare national part "under the +60 prefix". It destroyed every number that was
// not Malaysian:
//
//   slip says "+65 6123 4567"
//     -> strip non-digits            "6561234567"
//     -> starts with "60"? no. "0"? no  -> falls through unchanged
//     -> every consumer treats it as a Malaysian national part
//     -> stored as "+60" + "6561234567" = "+606561234567"
//
// Corrupted server-side, so no UI change could have saved it, and the original
// is not recoverable from the stored value.
//
// postProcessSlip now maps every extracted phone through the shared
// normalizePhone. These cases pin the behaviour the slip actually needs — the
// operator writes a local form for a local customer and an explicit +xx when
// they mean another country.
const slipPhone = (raw: string | null | undefined) =>
  typeof raw === 'string' ? normalizePhone(raw) : null;

describe('a slip phone survives whatever country it was written in', () => {
  test('the Singapore number that used to be destroyed', () => {
    expect(slipPhone('+65 6123 4567')).toBe('+6561234567');
    // The old behaviour, stated so a regression is unmistakable:
    expect(slipPhone('+65 6123 4567')).not.toBe('+606561234567');
  });

  test('other countries the owner trades with are preserved too', () => {
    expect(slipPhone('+62 812 3456 7890')).toBe('+6281234567890');
    expect(slipPhone('+66 81 234 5678')).toBe('+66812345678');
    expect(slipPhone('+86 138 0013 8000')).toBe('+8613800138000');
  });
});

describe('the Malaysian forms a slip is actually written in still work', () => {
  test('local trunk-0 form', () => {
    expect(slipPhone('0197770309')).toBe('+60197770309');
    expect(slipPhone('012-345 6789')).toBe('+60123456789');
  });

  test('the 11-digit 011 form the prompt warns about (doubled digits kept)', () => {
    expect(slipPhone('01137166720')).toBe('+601137166720');
  });

  test('already carrying the country code, with or without the plus', () => {
    expect(slipPhone('+6017 888 9999')).toBe('+60178889999');
    expect(slipPhone('60178889999')).toBe('+60178889999');
  });

  test('written without the trunk 0 — the form the OCR prompt describes', () => {
    expect(slipPhone('197770309')).toBe('+60197770309');
  });

  test('landline', () => {
    expect(slipPhone('03-1234 5678')).toBe('+60312345678');
  });
});

describe('unusable input yields null rather than a guess', () => {
  test('empty and non-string', () => {
    expect(slipPhone('')).toBe(null);
    expect(slipPhone(null)).toBe(null);
    expect(slipPhone(undefined)).toBe(null);
    expect(slipPhone(123 as unknown as string)).toBe(null);
  });

  test('too few digits to be a phone', () => {
    expect(slipPhone('1234')).toBe(null);
    expect(slipPhone('-')).toBe(null);
  });
});
