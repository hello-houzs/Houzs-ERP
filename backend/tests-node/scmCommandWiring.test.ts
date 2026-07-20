import { describe, expect, test } from 'vitest';
import salesOrderSource from '../src/scm/routes/mfg-sales-orders.ts?raw';
import amendmentSource from '../src/scm/routes/so-amendments.ts?raw';

describe('SCM atomic command wiring', () => {
  for (const [handler, path] of [
    ['tbcUpdateCommandHandler', "post('/:docNo/items/:itemId/tbc-update'"],
    ['tbcSwapCommandHandler', "post('/:docNo/items/:itemId/tbc-swap'"],
    ['tbcSwapSofaCommandHandler', "post('/:docNo/items/:itemId/tbc-swap-sofa'"],
  ] as const) {
    test(`${path} is fail-closed behind the PG transaction + lease row lock`, () => {
      const handlerAt = salesOrderSource.indexOf(`export async function ${handler}`);
      const routeAt = salesOrderSource.indexOf(`mfgSalesOrders.${path}`);
      expect(handlerAt).toBeGreaterThanOrEqual(0);
      expect(routeAt).toBeGreaterThan(handlerAt);
      const registration = salesOrderSource.slice(routeAt, routeAt + 600);
      expect(registration).toContain('runScmPgCommand');
      expect(registration).toContain("docNo: c.req.param('docNo')");
      expect(registration).toContain("leaseToken: c.req.header('X-SO-Edit-Lease')");
    });
  }

  test('approve-so applies and finalizes the amendment inside one PG transaction', () => {
    const handlerAt = amendmentSource.indexOf('export async function approveSoCommandHandler');
    const routeAt = amendmentSource.indexOf("soAmendments.patch('/:id/approve-so'");
    expect(handlerAt).toBeGreaterThanOrEqual(0);
    expect(routeAt).toBeGreaterThan(handlerAt);
    const handler = amendmentSource.slice(handlerAt, routeAt);
    expect(handler).toContain('applySoAmendment(sb');
    expect(handler).toContain("sb.from('so_amendments').update");
    expect(amendmentSource.slice(routeAt, routeAt + 250)).toContain('runScmPgCommand');
  });

  test('mirrored amendment dispatch waits until the local command transaction commits', () => {
    const dispatchAt = amendmentSource.indexOf('async function dispatchMirroredCommand');
    const dispatch = amendmentSource.slice(dispatchAt, dispatchAt + 5000);
    expect(dispatch).toContain("dispatchOne(c.get('supabase')");
    expect(dispatch).toContain('deferScmAfterCommit(c, dispatch)');
    expect(dispatch).not.toContain('dispatchOne(sb, cfg.config');
  });

  test('sofa R2 cleanup and global allocation are explicitly after-commit effects', () => {
    expect(salesOrderSource).toContain('deferScmAfterCommit(c, async () =>');
    const cleanup = salesOrderSource.indexOf('const oldPhotoKeys');
    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(salesOrderSource.slice(cleanup, cleanup + 500)).toContain('deferScmAfterCommit');
  });
});
