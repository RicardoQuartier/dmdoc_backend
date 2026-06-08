import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { RoleSchema, type Role } from '@dmdoc/shared-types';
import type { Config } from '../config.js';

/**
 * Serviço de tokens JWT — autenticação STATELESS (decisão de produto).
 *
 * Dois tokens, dois SEGREDOS distintos:
 *  - access (curto, `JWT_SECRET`): autoriza requisições. Carrega a identidade
 *    completa `{ sub, tenantId, role }` para o middleware popular o contexto
 *    sem ir ao banco a cada request.
 *  - refresh (longo, `JWT_REFRESH_SECRET`): só serve para emitir um novo par.
 *    Carrega apenas `{ sub }` — em /auth/refresh re-buscamos o usuário no banco
 *    para refletir role/tenant/active atuais (e barrar quem foi desativado).
 *
 * Usar segredos distintos garante que um refresh token NUNCA seja aceito como
 * access token (e vice-versa): cada `verify` valida com o segredo do seu tipo.
 *
 * Logout é stateless: o cliente descarta os tokens. Denylist de refresh (para
 * revogação ativa) fica para a Fase 5.
 */

/**
 * Conteúdo do access token, validado na verificação. `tenantId` é `null` para
 * SUPER_ADMIN (sem empresa fixa).
 */
const AccessClaimsSchema = z.object({
  sub: z.string().uuid(),
  tenantId: z.string().uuid().nullable(),
  role: RoleSchema,
});

export interface AccessClaims {
  sub: string;
  tenantId: string | null;
  role: Role;
}

const RefreshClaimsSchema = z.object({
  sub: z.string().uuid(),
});

export interface RefreshClaims {
  sub: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

type JwtConfig = Pick<
  Config,
  'JWT_SECRET' | 'JWT_REFRESH_SECRET' | 'JWT_EXPIRES_IN' | 'JWT_REFRESH_EXPIRES_IN'
>;

/**
 * Monta as `SignOptions` com o tempo de expiração. O tipo de `expiresIn` no
 * `jsonwebtoken` é `number | StringValue` (ex.: "15m", "7d"); a config valida
 * que é uma string não vazia, então a estreitamos aqui.
 */
function signOptions(expiresIn: string): jwt.SignOptions {
  return { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] & string };
}

/**
 * Erro interno do serviço de tokens — token inválido, expirado ou com claims
 * fora do schema esperado. A rota/middleware traduz isto para 401 genérico.
 */
export class InvalidTokenError extends Error {
  constructor(message = 'Token inválido') {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

export class TokenService {
  private readonly config: JwtConfig;

  constructor(config: JwtConfig) {
    this.config = config;
  }

  /**
   * Assina um access token com a identidade completa do usuário.
   */
  signAccessToken(claims: AccessClaims): string {
    return jwt.sign(claims, this.config.JWT_SECRET, signOptions(this.config.JWT_EXPIRES_IN));
  }

  /**
   * Assina um refresh token (apenas o subject).
   */
  signRefreshToken(claims: RefreshClaims): string {
    return jwt.sign(
      claims,
      this.config.JWT_REFRESH_SECRET,
      signOptions(this.config.JWT_REFRESH_EXPIRES_IN)
    );
  }

  /**
   * Emite o par access+refresh para um usuário já autenticado.
   */
  issuePair(claims: AccessClaims): TokenPair {
    return {
      accessToken: this.signAccessToken(claims),
      refreshToken: this.signRefreshToken({ sub: claims.sub }),
    };
  }

  /**
   * Verifica e decodifica um access token. Lança `InvalidTokenError` se a
   * assinatura, a expiração ou o schema de claims falharem.
   */
  verifyAccessToken(token: string): AccessClaims {
    return this.verify(token, this.config.JWT_SECRET, AccessClaimsSchema);
  }

  /**
   * Verifica e decodifica um refresh token. Lança `InvalidTokenError` se a
   * assinatura, a expiração ou o schema de claims falharem.
   */
  verifyRefreshToken(token: string): RefreshClaims {
    return this.verify(token, this.config.JWT_REFRESH_SECRET, RefreshClaimsSchema);
  }

  private verify<T>(token: string, secret: string, schema: z.ZodType<T>): T {
    let decoded: unknown;
    try {
      decoded = jwt.verify(token, secret);
    } catch {
      throw new InvalidTokenError();
    }
    const parsed = schema.safeParse(decoded);
    if (!parsed.success) {
      throw new InvalidTokenError('Claims do token inválidas');
    }
    return parsed.data;
  }
}
