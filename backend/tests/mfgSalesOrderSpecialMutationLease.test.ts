import { describe, expect, test } from 'vitest';
import routeSource from '../src/scm/routes/mfg-sales-orders.ts?raw';
import { soLineWriteLeaseMatches } from '../src/scm/routes/mfg-sales-orders';

const routes = [
  "post('/:docNo/items/:itemId/override'",
  "post('/:docNo/items/:itemId/tbc-update'",
  "post('/:docNo/items/:itemId/tbc-swap'",
  "post('/:docNo/items/:itemId/tbc-swap-sofa'",
  "post('/:docNo/items/:itemId/photos'",
  "delete('/:docNo/items/:itemId/photos/:photoKey'",
  "patch('/:docNo/items/:itemId/stock-status'",
];

describe('special SO line mutation lease coverage', () => {
  test('runtime guard accepts only the current unexpired token', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(soLineWriteLeaseMatches({ edit_lease_token: 'held', edit_lease_expires_at: future }, 'held')).toBe(true);
    expect(soLineWriteLeaseMatches({ edit_lease_token: 'held', edit_lease_expires_at: future }, 'other')).toBe(false);
    expect(soLineWriteLeaseMatches({ edit_lease_token: 'held', edit_lease_expires_at: past }, 'held')).toBe(false);
    expect(soLineWriteLeaseMatches({ edit_lease_token: null, edit_lease_expires_at: null }, '')).toBe(false);
  });

  for (const route of routes) {
    test(`${route} checks the central lease guard before any mutation`, () => {
      const start = routeSource.indexOf(`mfgSalesOrders.${route}`);
      expect(start).toBeGreaterThanOrEqual(0);
      const next = routeSource.indexOf('\nmfgSalesOrders.', start + 20);
      const block = routeSource.slice(start, next < 0 ? routeSource.length : next);
      const guard = block.indexOf('requireSoLineWriteLease(sb, docNo, c)');
      expect(guard).toBeGreaterThan(0);
      const firstWrite = [
        block.indexOf('.update('), block.indexOf('.insert('), block.indexOf('.delete()'),
        block.indexOf('.put('), block.indexOf('recordSoAudit('),
      ].filter((index) => index >= 0).sort((a, b) => a - b)[0];
      if (firstWrite !== undefined) expect(guard).toBeLessThan(firstWrite);
    });
  }
});
