import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { resolveTenantContext, resolveTenantId } from './resolve-tenant.js';
import { ConflictError } from '../errors/ConflictError.js';
import { NotFoundError } from '../errors/NotFoundError.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const TENANT_C = '33333333-3333-3333-3333-333333333333';
const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/**
 * Constrói um FastifyRequest mínimo para os testes de resolve-tenant.
 * Apenas os campos acessados pela função são necessários.
 */
function makeRequest(opts: {
  role: 'SUPER_ADMIN' | 'MULTI_TENANT_ADMIN' | 'TENANT_ADMIN' | 'UPLOADER' | 'USER';
  tenantId: string | null;
  allowedTenantIds?: string[];
}): FastifyRequest {
  return {
    user: {
      sub: USER_ID,
      role: opts.role,
      tenantId: opts.tenantId,
      allowedTenantIds: opts.allowedTenantIds ?? [],
    },
    tenantId: opts.tenantId,
  } as unknown as FastifyRequest;
}

// ---------------------------------------------------------------------------
// resolveTenantContext
// ---------------------------------------------------------------------------

describe('resolveTenantContext', () => {
  // Caso 1: Role normal — usa o tenantId do token, ignora explícito
  describe('role normal (TENANT_ADMIN)', () => {
    it('retorna mode:single com tenantId do token', () => {
      const req = makeRequest({ role: 'TENANT_ADMIN', tenantId: TENANT_A });
      const ctx = resolveTenantContext(req);
      expect(ctx).toEqual({ mode: 'single', tenantId: TENANT_A });
    });

    it('ignora explicitTenantId passado (previne escalada de privilégio)', () => {
      const req = makeRequest({ role: 'TENANT_ADMIN', tenantId: TENANT_A });
      const ctx = resolveTenantContext(req, { explicitTenantId: TENANT_B });
      // Deve usar o tenantId do token, não o explícito
      expect(ctx).toEqual({ mode: 'single', tenantId: TENANT_A });
    });

    it('funciona para UPLOADER', () => {
      const req = makeRequest({ role: 'UPLOADER', tenantId: TENANT_A });
      const ctx = resolveTenantContext(req);
      expect(ctx).toEqual({ mode: 'single', tenantId: TENANT_A });
    });

    it('funciona para USER', () => {
      const req = makeRequest({ role: 'USER', tenantId: TENANT_A });
      const ctx = resolveTenantContext(req);
      expect(ctx).toEqual({ mode: 'single', tenantId: TENANT_A });
    });
  });

  // Caso 2: SUPER_ADMIN com explicitTenantId → single
  describe('SUPER_ADMIN com explicitTenantId', () => {
    it('retorna mode:single com o explicit', () => {
      const req = makeRequest({ role: 'SUPER_ADMIN', tenantId: null });
      const ctx = resolveTenantContext(req, { explicitTenantId: TENANT_A });
      expect(ctx).toEqual({ mode: 'single', tenantId: TENANT_A });
    });

    it('funciona tanto para leitura quanto escrita', () => {
      const req = makeRequest({ role: 'SUPER_ADMIN', tenantId: null });
      const ctxRead = resolveTenantContext(req, { explicitTenantId: TENANT_A, write: false });
      const ctxWrite = resolveTenantContext(req, { explicitTenantId: TENANT_A, write: true });
      expect(ctxRead).toEqual({ mode: 'single', tenantId: TENANT_A });
      expect(ctxWrite).toEqual({ mode: 'single', tenantId: TENANT_A });
    });
  });

  // Caso 3: SUPER_ADMIN sem explicit em leitura → all
  describe('SUPER_ADMIN sem explicitTenantId (leitura)', () => {
    it('retorna mode:all', () => {
      const req = makeRequest({ role: 'SUPER_ADMIN', tenantId: null });
      const ctx = resolveTenantContext(req);
      expect(ctx).toEqual({ mode: 'all' });
    });

    it('write:false retorna mode:all', () => {
      const req = makeRequest({ role: 'SUPER_ADMIN', tenantId: null });
      const ctx = resolveTenantContext(req, { write: false });
      expect(ctx).toEqual({ mode: 'all' });
    });
  });

  // Caso 4: SUPER_ADMIN sem explicit em escrita → ConflictError (409)
  describe('SUPER_ADMIN sem explicitTenantId (escrita)', () => {
    it('lança ConflictError', () => {
      const req = makeRequest({ role: 'SUPER_ADMIN', tenantId: null });
      expect(() => resolveTenantContext(req, { write: true })).toThrow(ConflictError);
    });
  });

  // Caso 5: MTA sem explicit em leitura → allowed
  describe('MULTI_TENANT_ADMIN sem explicitTenantId (leitura)', () => {
    it('retorna mode:allowed com a lista de tenants', () => {
      const req = makeRequest({
        role: 'MULTI_TENANT_ADMIN',
        tenantId: null,
        allowedTenantIds: [TENANT_A, TENANT_B],
      });
      const ctx = resolveTenantContext(req);
      expect(ctx).toEqual({ mode: 'allowed', tenantIds: [TENANT_A, TENANT_B] });
    });

    it('retorna mode:allowed com lista vazia quando não há tenants atribuídos', () => {
      const req = makeRequest({
        role: 'MULTI_TENANT_ADMIN',
        tenantId: null,
        allowedTenantIds: [],
      });
      const ctx = resolveTenantContext(req);
      expect(ctx).toEqual({ mode: 'allowed', tenantIds: [] });
    });
  });

  // Caso 6: MTA sem explicit em escrita → NotFoundError (404)
  describe('MULTI_TENANT_ADMIN sem explicitTenantId (escrita)', () => {
    it('lança NotFoundError', () => {
      const req = makeRequest({
        role: 'MULTI_TENANT_ADMIN',
        tenantId: null,
        allowedTenantIds: [TENANT_A],
      });
      expect(() => resolveTenantContext(req, { write: true })).toThrow(NotFoundError);
    });
  });

  // Caso 7: MTA com explicit válido (∈ allowedTenantIds) → single
  describe('MULTI_TENANT_ADMIN com explicitTenantId válido', () => {
    it('retorna mode:single quando tenant está na lista', () => {
      const req = makeRequest({
        role: 'MULTI_TENANT_ADMIN',
        tenantId: null,
        allowedTenantIds: [TENANT_A, TENANT_B],
      });
      const ctx = resolveTenantContext(req, { explicitTenantId: TENANT_A });
      expect(ctx).toEqual({ mode: 'single', tenantId: TENANT_A });
    });

    it('funciona para leitura e escrita quando tenant está na lista', () => {
      const req = makeRequest({
        role: 'MULTI_TENANT_ADMIN',
        tenantId: null,
        allowedTenantIds: [TENANT_A, TENANT_B],
      });
      const ctxRead = resolveTenantContext(req, { explicitTenantId: TENANT_B, write: false });
      const ctxWrite = resolveTenantContext(req, { explicitTenantId: TENANT_B, write: true });
      expect(ctxRead).toEqual({ mode: 'single', tenantId: TENANT_B });
      expect(ctxWrite).toEqual({ mode: 'single', tenantId: TENANT_B });
    });
  });

  // Caso 8: MTA com explicit inválido (∉ allowedTenantIds) → NotFoundError (404)
  describe('MULTI_TENANT_ADMIN com explicitTenantId fora da lista', () => {
    it('lança NotFoundError', () => {
      const req = makeRequest({
        role: 'MULTI_TENANT_ADMIN',
        tenantId: null,
        allowedTenantIds: [TENANT_A, TENANT_B],
      });
      // TENANT_C não está na lista
      expect(() =>
        resolveTenantContext(req, { explicitTenantId: TENANT_C }),
      ).toThrow(NotFoundError);
    });

    it('lança NotFoundError mesmo em escrita', () => {
      const req = makeRequest({
        role: 'MULTI_TENANT_ADMIN',
        tenantId: null,
        allowedTenantIds: [TENANT_A],
      });
      expect(() =>
        resolveTenantContext(req, { explicitTenantId: TENANT_C, write: true }),
      ).toThrow(NotFoundError);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveTenantId (legado — mantido por compatibilidade)
// ---------------------------------------------------------------------------

describe('resolveTenantId (compat)', () => {
  it('role normal → tenantId do token', () => {
    const req = makeRequest({ role: 'TENANT_ADMIN', tenantId: TENANT_A });
    expect(resolveTenantId(req, undefined, false)).toBe(TENANT_A);
  });

  it('SUPER_ADMIN sem explicit + requireForSuperAdmin:false → null', () => {
    const req = makeRequest({ role: 'SUPER_ADMIN', tenantId: null });
    expect(resolveTenantId(req, undefined, false)).toBeNull();
  });

  it('SUPER_ADMIN com explicit → tenantId explícito', () => {
    const req = makeRequest({ role: 'SUPER_ADMIN', tenantId: null });
    expect(resolveTenantId(req, TENANT_A, false)).toBe(TENANT_A);
  });

  it('SUPER_ADMIN sem explicit + requireForSuperAdmin:true → ConflictError', () => {
    const req = makeRequest({ role: 'SUPER_ADMIN', tenantId: null });
    expect(() => resolveTenantId(req, undefined, true)).toThrow(ConflictError);
  });

  it('MTA com explicit inválido → NotFoundError', () => {
    const req = makeRequest({
      role: 'MULTI_TENANT_ADMIN',
      tenantId: null,
      allowedTenantIds: [TENANT_A],
    });
    expect(() => resolveTenantId(req, TENANT_C, false)).toThrow(NotFoundError);
  });
});
