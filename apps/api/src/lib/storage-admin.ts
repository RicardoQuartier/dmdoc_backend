import { z } from 'zod';
import {
  StorageAuthError,
  StorageConfigError,
  StorageError,
  StorageNotFoundError,
  StorageRateLimitError,
  StorageTargetError,
  type ResolvedStorageTarget,
  type S3Config,
} from '@dmdoc/storage';
import type { Config } from '../config.js';

/**
 * Peças puras da administração do destino de armazenamento de uma empresa
 * (épico E-11 / T-140). Ficam fora de `routes/admin/tenants.ts` porque são
 * lógica sem I/O — validação de corpo, mascaramento de segredo, comparação de
 * configurações e tradução de erro de provedor — e é assim que dá para
 * exercitá-las sem subir a app.
 *
 * ## O que NUNCA sai daqui
 *
 * O segredo da empresa (secret access key da AWS, client secret do Entra ID).
 * Ele entra pelo corpo do `PUT`, vira `encrypted_secret` e some: não aparece em
 * resposta, em log nem em audit log. `maskStorageSecrets` existe para que o
 * diff de auditoria diga "o segredo mudou" sem dizer qual é.
 */

// ---------------------------------------------------------------------------
// Corpo do PUT / POST de teste
// ---------------------------------------------------------------------------

/**
 * Segredo informado no corpo.
 *
 * `.min(1)` é decisão de comportamento, não capricho: campo AUSENTE preserva o
 * segredo já gravado, e string VAZIA é recusada com 422. Aceitar `''` como
 * "apagar o segredo" produziria uma configuração `credentials_source = 'tenant'`
 * sem `encrypted_secret` — que o `parseStorageTarget` recusa na hora de resolver
 * o driver, transformando um cadastro salvo com sucesso em falha de todo upload
 * seguinte. Melhor recusar no cadastro.
 */
const SecretSchema = z
  .string()
  .min(1, 'segredo não pode ser string vazia — omita o campo para preservar o já gravado');

/** `s3` + `platform`: o bucket da plataforma. Nenhum campo de configuração. */
const S3PlatformBodySchema = z.object({
  provider: z.literal('s3'),
  credentialsSource: z.literal('platform'),
});

/** `s3` + `tenant`: bucket próprio da empresa (AWS, R2, MinIO). */
const S3TenantBodySchema = z.object({
  provider: z.literal('s3'),
  credentialsSource: z.literal('tenant'),
  region: z.string().min(1).max(64),
  bucket: z.string().min(1).max(255),
  accessKeyId: z.string().min(1).max(255),
  secretAccessKey: SecretSchema.optional(),
  endpoint: z.string().url().max(500).optional(),
  publicEndpoint: z.string().url().max(500).optional(),
  forcePathStyle: z.boolean().default(false),
});

/**
 * `sharepoint`: sempre com credenciais da empresa.
 *
 * `credentialsSource` é `z.literal('tenant')` com default — é o que rejeita
 * `('sharepoint','platform')` com 422 do Zod ANTES de o CHECK
 * `storage_platform_creds_only_s3` (migration 0017) ser exercitado. Não existe
 * SharePoint da plataforma: o DMDoc não tem um tenant Azure global para
 * hospedar arquivo de cliente.
 */
const SharePointBodySchema = z.object({
  provider: z.literal('sharepoint'),
  credentialsSource: z.literal('tenant').default('tenant'),
  azureTenantId: z.string().min(1).max(255),
  clientId: z.string().min(1).max(255),
  clientSecret: SecretSchema.optional(),
  siteId: z.string().min(1).max(500),
  driveId: z.string().min(1).max(500),
  rootFolder: z.string().max(500).optional(),
});

/**
 * Discriminador lido primeiro, para escolher o schema específico.
 *
 * `z.union` das três variantes também funcionaria, mas devolveria
 * `invalid_union` sem apontar o campo que falta — e este endpoint é preenchido
 * à mão por um operador, para quem "faltou `bucket`" e "isso aqui não casou com
 * nenhuma variante" são mensagens muito diferentes.
 */
const StorageBodyDiscriminatorSchema = z.object({
  provider: z.enum(['s3', 'sharepoint']),
  credentialsSource: z.enum(['platform', 'tenant']).optional(),
});

export type StorageConfigBody =
  | z.infer<typeof S3PlatformBodySchema>
  | z.infer<typeof S3TenantBodySchema>
  | z.infer<typeof SharePointBodySchema>;

/**
 * Valida o corpo do `PUT` / do teste de conexão.
 *
 * Lança `ZodError` (→ 422 pelo error handler central) em qualquer entrada
 * inválida, inclusive na combinação proibida `('sharepoint','platform')`.
 */
export function parseStorageConfigBody(body: unknown): StorageConfigBody {
  const { provider, credentialsSource } = StorageBodyDiscriminatorSchema.parse(body);

  if (provider === 'sharepoint') {
    return SharePointBodySchema.parse(body);
  }
  // `s3` sem `credentialsSource` é o bucket da plataforma — o default do
  // produto e o estado de toda empresa que nunca configurou nada.
  if (credentialsSource === 'tenant') {
    return S3TenantBodySchema.parse(body);
  }
  return S3PlatformBodySchema.parse(body);
}

// ---------------------------------------------------------------------------
// Corpo → linha da tabela
// ---------------------------------------------------------------------------

/** Valores aceitos dentro do jsonb `config` (o `sql.json` do postgres.js é tipado). */
export type StorageConfigJson = Record<string, string | boolean>;

/**
 * O que o corpo pede, já separado nas três partes que a tabela guarda:
 * o provider, a parte NÃO sensível (`config`, jsonb) e o segredo em claro
 * (ainda por cifrar), quando informado.
 *
 * `credentialsSource: 'platform'` é o caso sem linha nenhuma: `config` vazio,
 * segredo ausente.
 */
export interface DesiredStorageConfig {
  provider: 's3' | 'sharepoint';
  credentialsSource: 'platform' | 'tenant';
  config: StorageConfigJson;
  /** Segredo em claro informado agora. `undefined` = preservar o já gravado. */
  secret: string | undefined;
}

/**
 * Traduz o corpo validado na configuração desejada.
 *
 * O segredo sai do `config`: ele nunca entra no jsonb, que é a parte legível
 * da linha (aparece no `GET`, no audit log e em qualquer `SELECT` de suporte).
 * O único lugar dele é `encrypted_secret`.
 *
 * Campos opcionais ausentes NÃO viram chave com `undefined`: o jsonb precisa
 * ser comparável por igualdade estrutural (idempotência do `PUT`), e
 * `{bucket:'x'}` e `{bucket:'x', endpoint:undefined}` produziriam jsonb
 * diferentes depois do round-trip pelo banco.
 */
export function toDesiredConfig(body: StorageConfigBody): DesiredStorageConfig {
  if (body.provider === 'sharepoint') {
    return {
      provider: 'sharepoint',
      credentialsSource: 'tenant',
      config: {
        azureTenantId: body.azureTenantId,
        clientId: body.clientId,
        siteId: body.siteId,
        driveId: body.driveId,
        ...(body.rootFolder !== undefined && body.rootFolder !== ''
          ? { rootFolder: body.rootFolder }
          : {}),
      },
      secret: body.clientSecret,
    };
  }

  if (body.credentialsSource === 'platform') {
    return { provider: 's3', credentialsSource: 'platform', config: {}, secret: undefined };
  }

  return {
    provider: 's3',
    credentialsSource: 'tenant',
    config: {
      region: body.region,
      bucket: body.bucket,
      accessKeyId: body.accessKeyId,
      forcePathStyle: body.forcePathStyle,
      ...(body.endpoint !== undefined ? { endpoint: body.endpoint } : {}),
      ...(body.publicEndpoint !== undefined ? { publicEndpoint: body.publicEndpoint } : {}),
    },
    secret: body.secretAccessKey,
  };
}

/**
 * Igualdade estrutural entre duas configurações jsonb, com as chaves em ordem.
 *
 * O postgres.js não promete ordem de chaves de jsonb entre leituras, então
 * comparar `JSON.stringify` direto acusaria diferença onde não há — e o `PUT`
 * versionaria a cada clique em Salvar, enchendo `previousDestinations` de
 * configurações idênticas com zero documentos. Mesma técnica do
 * `stableStringify` de `packages/storage/src/resolve.ts`.
 */
export function sameStorageConfig(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Identidade FÍSICA de um destino
// ---------------------------------------------------------------------------

/**
 * A impressão digital do LUGAR onde os arquivos ficam (`storageLocationKey`)
 * MUDOU DE CASA: agora vive em `@dmdoc/storage` (`packages/storage/src/location.ts`).
 *
 * O motivo é que ela deixou de ter um consumidor só. Nasceu aqui para o
 * `cleanup-source` (T-141) e passou a ser também o dedup da purga de empresa no
 * worker (T-142) — e saber o que é um "lugar físico" (endpoint + bucket vs
 * site + drive + pasta raiz) é conhecimento de storage, não de rota de admin.
 * Duas cópias divergiriam no dia em que um provider novo entrasse.
 *
 * O que continua aqui é `sameStorageConfig`, que responde a outra pergunta
 * (idempotência do `PUT`, jsonb inteiro, credenciais incluídas).
 */

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/** Marca que substitui o segredo em qualquer coisa que outra pessoa vá ler. */
export const SECRET_MASK = '***';

/**
 * Nomes de campo que carregam segredo. Não há nenhum hoje dentro do jsonb
 * `config` (o segredo mora em coluna própria), e é exatamente por isso que a
 * lista existe: se um campo sensível vazar para o jsonb num provider futuro,
 * ele já sai mascarado do audit log em vez de ser descoberto num incidente.
 */
const SECRET_FIELDS = new Set([
  'secret',
  'secretaccesskey',
  'clientsecret',
  'password',
  'encrypted_secret',
  'encryptedsecret',
  'accountkey',
  'connectionstring',
]);

/** Devolve uma cópia do objeto com todo campo sensível trocado por `***`. */
export function maskStorageSecrets(config: unknown): unknown {
  if (config === null || typeof config !== 'object') return config;
  if (Array.isArray(config)) return config.map(maskStorageSecrets);

  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    masked[key] = SECRET_FIELDS.has(key.toLowerCase()) ? SECRET_MASK : maskStorageSecrets(value);
  }
  return masked;
}

// ---------------------------------------------------------------------------
// Teste de conexão — tradução do erro do provedor
// ---------------------------------------------------------------------------

/**
 * Por que a conexão falhou, na granularidade que muda o que o operador faz a
 * seguir. É este código — não o texto — que a tela usa para destacar o campo
 * errado.
 */
export type StorageTestFailureCode =
  | 'INVALID_CREDENTIALS'
  | 'PERMISSION_DENIED'
  | 'DESTINATION_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'INVALID_CONFIG'
  | 'CONTENT_MISMATCH'
  | 'UNKNOWN';

export interface StorageTestFailure {
  code: StorageTestFailureCode;
  message: string;
}

/**
 * Códigos de erro do S3 que significam "a credencial não serve" — o
 * `@aws-sdk/client-s3` não tem classes tipadas para todos eles, então a
 * identificação é pelo `name`.
 */
const S3_CREDENTIAL_CODES = new Set([
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'AuthorizationHeaderMalformed',
  'TokenRefreshRequired',
  'ExpiredToken',
  'InvalidToken',
  'CredentialsProviderError',
]);

/** Códigos do S3 que significam "a credencial serve, mas falta permissão". */
const S3_PERMISSION_CODES = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'AllAccessDisabled',
  'AccountProblem',
]);

/** Códigos do S3 que significam "o destino não existe". */
const S3_NOT_FOUND_CODES = new Set(['NoSuchBucket', 'NotFound', 'NoSuchKey']);

/**
 * Traduz a falha de um provedor na resposta do "Testar conexão".
 *
 * Três regras que valem a leitura:
 *
 * 1. **Nunca devolve stack trace nem `cause`.** O que volta é uma frase em
 *    português dizendo o que arrumar. O erro completo vai para o log do Pino.
 * 2. **Credencial inválida, permissão faltando e destino inexistente são
 *    códigos DIFERENTES.** Colapsar os três em "falha ao conectar" devolve o
 *    operador ao mesmo lugar onde ele já estava: adivinhando qual dos seis
 *    campos está errado.
 * 3. **`StorageAuthError` sozinho não distingue credencial de permissão** — o
 *    driver do SharePoint usa a mesma classe para o 401 do Entra ID e para o
 *    403 do Graph. O status é o que separa: 403 é "o app autenticou, mas não
 *    tem Sites.ReadWrite.All"; 400/401 é "clientId/clientSecret errado".
 */
export function classifyStorageTestError(error: unknown): StorageTestFailure {
  if (error instanceof StorageTargetError) {
    return {
      code: 'INVALID_CONFIG',
      message: `Configuração inválida: ${error.message}`,
    };
  }

  if (error instanceof StorageConfigError) {
    return { code: 'INVALID_CONFIG', message: `Configuração inválida: ${error.message}` };
  }

  if (error instanceof StorageRateLimitError) {
    return {
      code: 'RATE_LIMITED',
      message:
        'O provedor está limitando as requisições agora. As credenciais parecem válidas — tente de novo em alguns instantes.',
    };
  }

  if (error instanceof StorageAuthError) {
    if (error.status === 403) {
      return {
        code: 'PERMISSION_DENIED',
        message:
          error.provider === 'sharepoint'
            ? 'As credenciais foram aceitas, mas o app não tem permissão nesta biblioteca. Conceda a permissão de aplicação Sites.ReadWrite.All ao app no Entra ID, com consentimento de administrador.'
            : 'As credenciais foram aceitas, mas não têm permissão de leitura/escrita neste bucket. Revise a policy do IAM (s3:PutObject, s3:GetObject e s3:DeleteObject no bucket).',
      };
    }
    return {
      code: 'INVALID_CREDENTIALS',
      message:
        error.provider === 'sharepoint'
          ? 'O Entra ID recusou as credenciais. Confira o diretório (tenant) do Azure, o clientId e o clientSecret — inclusive se o segredo não expirou.'
          : 'O provedor recusou as credenciais. Confira accessKeyId e secretAccessKey.',
    };
  }

  if (error instanceof StorageNotFoundError) {
    return {
      code: 'DESTINATION_NOT_FOUND',
      message:
        error.provider === 'sharepoint'
          ? 'O destino não foi encontrado. Confira o siteId, o driveId e se a pasta raiz informada existe na biblioteca.'
          : 'O destino não foi encontrado. Confira o nome do bucket e a região.',
    };
  }

  const s3 = classifyS3Error(error);
  if (s3 !== null) return s3;

  if (error instanceof StorageError) {
    return {
      code: 'UNKNOWN',
      message: `O provedor recusou a operação: ${error.message}`,
    };
  }

  return {
    code: 'UNKNOWN',
    message: `Não foi possível concluir o teste: ${describeUnknownError(error)}`,
  };
}

/**
 * Erros do `@aws-sdk/client-s3`, que chegam crus (o `S3Driver` não os
 * embrulha nas classes de `errors.ts`). A identificação é por `name` e, na
 * falta dele, pelo status HTTP em `$metadata`.
 */
function classifyS3Error(error: unknown): StorageTestFailure | null {
  if (typeof error !== 'object' || error === null) return null;

  const record = error as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const name = typeof record.name === 'string' ? record.name : undefined;
  const code = typeof record.Code === 'string' ? record.Code : name;
  const status =
    typeof record.$metadata?.httpStatusCode === 'number' ? record.$metadata.httpStatusCode : undefined;

  if (code !== undefined && S3_CREDENTIAL_CODES.has(code)) {
    return {
      code: 'INVALID_CREDENTIALS',
      message: `O provedor recusou as credenciais (${code}). Confira accessKeyId e secretAccessKey.`,
    };
  }
  if (code !== undefined && S3_PERMISSION_CODES.has(code)) {
    return {
      code: 'PERMISSION_DENIED',
      message: `As credenciais foram aceitas, mas não têm permissão neste bucket (${code}). Revise a policy do IAM (s3:PutObject, s3:GetObject e s3:DeleteObject).`,
    };
  }
  if (code !== undefined && S3_NOT_FOUND_CODES.has(code)) {
    return {
      code: 'DESTINATION_NOT_FOUND',
      message: `O destino não foi encontrado (${code}). Confira o nome do bucket, a região e o endpoint.`,
    };
  }
  if (status === 403) {
    return {
      code: 'PERMISSION_DENIED',
      message:
        'O provedor respondeu 403. As credenciais podem estar sem permissão neste bucket — revise a policy do IAM.',
    };
  }
  if (status === 404) {
    return {
      code: 'DESTINATION_NOT_FOUND',
      message: 'O provedor respondeu 404. Confira o nome do bucket, a região e o endpoint.',
    };
  }

  return null;
}

/** Mensagem curta e sem stack de um erro de tipo desconhecido. */
function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Configuração da plataforma
// ---------------------------------------------------------------------------

/**
 * Monta a `S3Config` do bucket DA PLATAFORMA a partir do `Config` da app.
 *
 * Mora aqui, e não em `app.ts`, porque duas peças precisam dela: o
 * `createStorageResolver` do boot e o "Testar conexão", que constrói um driver
 * avulso para a opção "S3 da plataforma". Duas cópias divergiriam no dia em que
 * alguém acrescentasse um campo à config.
 */
export function buildPlatformS3Config(config: Config): S3Config {
  return {
    region: config.AWS_REGION,
    bucket: config.AWS_S3_BUCKET,
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    ...(config.S3_ENDPOINT !== undefined ? { endpoint: config.S3_ENDPOINT } : {}),
    ...(config.S3_PUBLIC_ENDPOINT !== undefined
      ? { publicEndpoint: config.S3_PUBLIC_ENDPOINT }
      : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
  };
}

/** Fábrica de driver a partir de um alvo já resolvido — injetável em teste. */
export type StorageDriverFactory = (
  target: ResolvedStorageTarget
) => import('@dmdoc/storage').StorageDriver;
