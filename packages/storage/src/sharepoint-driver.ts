import type {
  DownloadUrlOptions,
  PutParams,
  StorageDriver,
  StorageProvider,
} from './driver.js';
import {
  StorageAuthError,
  StorageConfigError,
  StorageError,
  StorageInvalidKeyError,
  StorageNotFoundError,
  StorageRateLimitError,
} from './errors.js';

/**
 * Driver de armazenamento sobre uma biblioteca de documentos do SharePoint
 * Online, via Microsoft Graph com autenticação app-only (client credentials).
 *
 * ## A chave é o caminho
 *
 * A chave continua sendo a mesma do S3 —
 * `tenants/{tenantId}/documents/{contentHash}/{filename}` — e o driver a usa
 * como CAMINHO dentro da biblioteca (`/drives/{driveId}/root:/{rootFolder}/{key}`),
 * não como `itemId`. Consequências, todas conscientes:
 *
 * - `deletePrefix` apaga uma pasta só, em vez de iterar milhares de itens;
 * - a coluna de chave no banco é uniforme entre os provedores;
 * - **mover ou renomear o arquivo pela interface do SharePoint quebra o vínculo
 *   com o DMDoc** — o documento passa a existir só no banco. É a contrapartida
 *   aceita para não guardar `itemId` por documento.
 *
 * ## O que este driver NÃO faz
 *
 * Não lê `process.env` (spec §12): toda configuração chega pelo construtor, que
 * é quem sabe se ela veio do `config.ts` da plataforma ou de
 * `tenant_storage_configs`.
 */

const DEFAULT_GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const DEFAULT_LOGIN_BASE_URL = 'https://login.microsoftonline.com';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

/**
 * Acima deste tamanho o Graph exige upload session. O PUT simples aceita até
 * 4 MB — e `MAX_UPLOAD_MB` tem default 50, então a sessão de upload é o caminho
 * comum, não a exceção.
 */
const SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

/**
 * O Graph exige que todo chunk (menos o último) seja múltiplo de 320 KiB.
 * Enviar tamanho fora dessa grade devolve `invalidRange` e a sessão morre.
 */
const UPLOAD_CHUNK_UNIT_BYTES = 320 * 1024;

/** 10 MiB = 32 × 320 KiB. Compromisso entre número de round-trips e memória. */
const DEFAULT_UPLOAD_CHUNK_BYTES = 32 * UPLOAD_CHUNK_UNIT_BYTES;

/**
 * Renova o token com folga antes do expiry. O token do Graph vive ~1 h; 5 min
 * de folga cobrem o relógio fora de sincronia e uploads longos que começam com
 * o token quase vencido.
 */
const TOKEN_EXPIRY_SKEW_SECONDS = 300;

/** Piso de validade, para nunca cachear um token que já nasce vencido. */
const TOKEN_MIN_LIFETIME_SECONDS = 30;

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** Teto para a espera pedida via `Retry-After` — o Graph às vezes pede minutos. */
const MAX_RETRY_DELAY_MS = 60_000;

/** Base do backoff exponencial quando o provedor não manda `Retry-After`. */
const BASE_RETRY_DELAY_MS = 1_000;

/**
 * Status que valem nova tentativa:
 * - 429 — throttling do Graph, o caso mais comum em upload em lote;
 * - 503 / 504 — indisponibilidade momentânea do serviço.
 *
 * 5xx restantes não são repetidos: 500 do Graph costuma ser erro determinístico
 * de requisição malformada, e repetir só atrasa a falha.
 */
const RETRYABLE_STATUSES = new Set([429, 503, 504]);

/**
 * Caracteres que o SharePoint recusa em nome de arquivo ou pasta. `/` fica de
 * fora porque é o separador de segmentos da própria chave.
 */
// Caracteres de controle nao entram aqui: o Graph os rejeita e o regex ficaria ilegivel.
const FORBIDDEN_NAME_CHARS = /["*:<>?\\|]/;

export interface SharePointConfig {
  /** Diretório (tenant) do Entra ID onde o app está registrado. */
  azureTenantId: string;
  clientId: string;
  clientSecret: string;
  /**
   * Site onde a biblioteca vive. O driver endereça tudo por `driveId`; o
   * `siteId` fica guardado para diagnóstico e para a tela de configuração
   * mostrar de onde veio o drive.
   */
  siteId: string;
  /** Biblioteca de documentos de destino. */
  driveId: string;
  // Os opcionais aceitam `undefined` explícito (`?: T | undefined`) porque quem
  // monta esta config lê linha de `tenant_storage_configs`, onde coluna nula
  // vira `undefined` direto — sem obrigar spread condicional em cada campo.
  /**
   * Pasta raiz dentro da biblioteca (ex.: `DMDoc`). Ausente = raiz do drive.
   * Isola o acervo do DMDoc do que o cliente já guarda na mesma biblioteca.
   */
  rootFolder?: string | undefined;
  /** Sobrescreve o endpoint do Graph (nuvem soberana ou teste). */
  graphBaseUrl?: string | undefined;
  /** Sobrescreve o endpoint de login (nuvem soberana ou teste). */
  loginBaseUrl?: string | undefined;
  /** Tentativas extras após a primeira falha repetível. Default 3. */
  maxRetries?: number | undefined;
  /** Tamanho do chunk da upload session. Precisa ser múltiplo de 320 KiB. */
  uploadChunkBytes?: number | undefined;
  /** Timeout por requisição HTTP. Default 120 s (chunk de 10 MiB em link ruim). */
  requestTimeoutMs?: number | undefined;
}

/** Assinatura mínima de `fetch` usada pelo driver. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Dependências injetáveis. Existem para o teste: com elas a suíte cobre retry e
 * expiry de token sem abrir socket e sem esperar em tempo real.
 */
export interface SharePointDriverDeps {
  fetch?: FetchLike;
  /** Relógio, em ms desde a época. Default `Date.now`. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Config com todos os defaults já aplicados — o que o driver usa internamente. */
interface ResolvedConfig {
  azureTenantId: string;
  clientId: string;
  clientSecret: string;
  siteId: string;
  driveId: string;
  rootFolder: string | undefined;
  graphBaseUrl: string;
  loginBaseUrl: string;
  maxRetries: number;
  uploadChunkBytes: number;
  requestTimeoutMs: number;
}

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

interface RequestSpec {
  operation: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  /** `false` só para a upload session, cuja URL já é pré-autenticada. */
  authenticated: boolean;
}

export class SharePointDriver implements StorageDriver {
  readonly provider: StorageProvider = 'sharepoint';

  private readonly config: ResolvedConfig;

  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private cachedToken: CachedToken | null = null;
  /**
   * Requisição de token em voo. Sem isso, dez uploads simultâneos pedem dez
   * tokens ao Entra ID e tomam throttling logo na autenticação.
   */
  private pendingToken: Promise<string> | null = null;

  constructor(config: SharePointConfig, deps: SharePointDriverDeps = {}) {
    assertNonEmpty(config.azureTenantId, 'azureTenantId');
    assertNonEmpty(config.clientId, 'clientId');
    assertNonEmpty(config.clientSecret, 'clientSecret');
    assertNonEmpty(config.siteId, 'siteId');
    assertNonEmpty(config.driveId, 'driveId');

    const uploadChunkBytes = config.uploadChunkBytes ?? DEFAULT_UPLOAD_CHUNK_BYTES;
    if (uploadChunkBytes <= 0 || uploadChunkBytes % UPLOAD_CHUNK_UNIT_BYTES !== 0) {
      throw new StorageConfigError(
        `uploadChunkBytes deve ser múltiplo de ${UPLOAD_CHUNK_UNIT_BYTES} bytes (320 KiB), recebeu ${uploadChunkBytes}`,
        { provider: 'sharepoint', operation: 'config' }
      );
    }

    const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new StorageConfigError(
        `maxRetries deve ser inteiro >= 0, recebeu ${maxRetries}`,
        { provider: 'sharepoint', operation: 'config' }
      );
    }

    this.config = {
      azureTenantId: config.azureTenantId,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      siteId: config.siteId,
      driveId: config.driveId,
      rootFolder: normalizeRootFolder(config.rootFolder),
      graphBaseUrl: stripTrailingSlash(config.graphBaseUrl ?? DEFAULT_GRAPH_BASE_URL),
      loginBaseUrl: stripTrailingSlash(config.loginBaseUrl ?? DEFAULT_LOGIN_BASE_URL),
      maxRetries,
      uploadChunkBytes,
      requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    };

    const injectedFetch = deps.fetch;
    if (injectedFetch === undefined && typeof globalThis.fetch !== 'function') {
      throw new StorageConfigError(
        'runtime sem fetch global — injete um fetch em SharePointDriverDeps',
        { provider: 'sharepoint', operation: 'config' }
      );
    }
    this.fetchImpl = injectedFetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = deps.now ?? (() => Date.now());
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  // ── Interface StorageDriver ────────────────────────────────────────────────

  async put(params: PutParams): Promise<void> {
    const path = this.itemPath(params.key, 'put');

    if (params.buffer.byteLength <= SIMPLE_UPLOAD_MAX_BYTES) {
      await this.putSimple(path, params);
      return;
    }
    await this.putWithSession(path, params);
  }

  async get(key: string): Promise<Buffer> {
    const path = this.itemPath(key, 'get');
    const response = await this.send({
      operation: 'get',
      method: 'GET',
      url: `${this.driveRoot()}:/${path}:/content`,
      authenticated: true,
    });

    if (response.status === 404) {
      await discardBody(response);
      throw new StorageNotFoundError(`arquivo não encontrado no SharePoint: ${key}`, {
        provider: 'sharepoint',
        operation: 'get',
        status: 404,
      });
    }
    await this.assertOk(response, 'get');

    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Devolve a URL pré-autenticada do Graph (`@microsoft.graph.downloadUrl`).
   *
   * Duas opções da interface **não** têm equivalente aqui e são ignoradas de
   * propósito:
   *
   * - `expiresInSeconds` — a validade é fixada pelo Graph (~1 h). Como a API
   *   pede 300 s, a URL entregue vive mais do que o pretendido; ninguém a
   *   armazena, então o risco é o mesmo de um link compartilhado por engano.
   * - `contentDisposition` — o Graph não aceita sobrescrever o header. O
   *   SharePoint serve o arquivo com a disposição que ele escolhe, e é por isso
   *   que o preview inline pode precisar de uma rota que faça stream pelo
   *   backend em vez de mandar o navegador direto para esta URL.
   *
   * `audience` também não muda nada: a URL é pública nos dois casos.
   */
  async getDownloadUrl(key: string, _options: DownloadUrlOptions): Promise<string> {
    const path = this.itemPath(key, 'getDownloadUrl');
    // Sem `$select`: o metadado inteiro é pequeno e o `select` de propriedade
    // anotada (`@microsoft.graph.downloadUrl`) tem comportamento inconsistente
    // entre SharePoint e OneDrive. Pedir tudo é o caminho previsível.
    const response = await this.send({
      operation: 'getDownloadUrl',
      method: 'GET',
      url: `${this.driveRoot()}:/${path}`,
      authenticated: true,
    });

    if (response.status === 404) {
      await discardBody(response);
      throw new StorageNotFoundError(`arquivo não encontrado no SharePoint: ${key}`, {
        provider: 'sharepoint',
        operation: 'getDownloadUrl',
        status: 404,
      });
    }
    await this.assertOk(response, 'getDownloadUrl');

    const item = await readJson(response, 'getDownloadUrl');
    const url = item['@microsoft.graph.downloadUrl'];
    if (typeof url !== 'string' || url.length === 0) {
      throw new StorageError(
        `Graph não devolveu @microsoft.graph.downloadUrl para ${key} — o item existe mas não é um arquivo?`,
        { provider: 'sharepoint', operation: 'getDownloadUrl', status: response.status }
      );
    }
    return url;
  }

  /**
   * Apaga o arquivo. Item inexistente é sucesso: a exclusão é idempotente, e um
   * documento cujo arquivo já sumiu não pode ficar preso no banco por isso
   * (mesma tolerância do driver S3, cujo DELETE também não reclama).
   */
  async delete(key: string): Promise<void> {
    const path = this.itemPath(key, 'delete');
    const response = await this.send({
      operation: 'delete',
      method: 'DELETE',
      url: `${this.driveRoot()}:/${path}`,
      authenticated: true,
    });

    if (response.status === 404) {
      await discardBody(response);
      return;
    }
    await this.assertOk(response, 'delete');
    await discardBody(response);
  }

  /**
   * Apaga a PASTA correspondente ao prefixo, de uma vez — em vez de listar e
   * apagar item a item como no S3, onde não existe pasta de verdade.
   *
   * Prefixo sem pasta correspondente é no-op: purga reexecutada e empresa que
   * nunca enviou arquivo são casos normais.
   */
  async deletePrefix(prefix: string): Promise<void> {
    const normalized = stripTrailingSlash(prefix);
    if (normalized.length === 0) {
      // No S3 um prefixo vazio varre o bucket inteiro; aqui varreria a
      // biblioteca do cliente, com arquivos que não são nossos. Recusar.
      throw new StorageInvalidKeyError(
        'deletePrefix com prefixo vazio apagaria a raiz da biblioteca do cliente',
        { provider: 'sharepoint', operation: 'deletePrefix' }
      );
    }

    const path = this.itemPath(normalized, 'deletePrefix');
    const response = await this.send({
      operation: 'deletePrefix',
      method: 'DELETE',
      url: `${this.driveRoot()}:/${path}`,
      authenticated: true,
    });

    if (response.status === 404) {
      await discardBody(response);
      return;
    }
    await this.assertOk(response, 'deletePrefix');
    await discardBody(response);
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  private async putSimple(path: string, params: PutParams): Promise<void> {
    // `conflictBehavior=replace` explícito: reenviar o mesmo documento (mesma
    // chave, mesmo hash) tem de sobrescrever, nunca virar `arquivo (2).pdf`.
    const response = await this.send({
      operation: 'put',
      method: 'PUT',
      url: `${this.driveRoot()}:/${path}:/content?%40microsoft.graph.conflictBehavior=replace`,
      headers: { 'content-type': params.mimeType },
      body: params.buffer,
      authenticated: true,
    });
    await this.assertOk(response, 'put');
    await discardBody(response);
  }

  private async putWithSession(path: string, params: PutParams): Promise<void> {
    const sessionResponse = await this.send({
      operation: 'put',
      method: 'POST',
      url: `${this.driveRoot()}:/${path}:/createUploadSession`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        item: {
          '@microsoft.graph.conflictBehavior': 'replace',
        },
      }),
      authenticated: true,
    });
    await this.assertOk(sessionResponse, 'put');

    const session = await readJson(sessionResponse, 'put');
    const uploadUrl = session['uploadUrl'];
    if (typeof uploadUrl !== 'string' || uploadUrl.length === 0) {
      throw new StorageError('Graph não devolveu uploadUrl ao criar a sessão de upload', {
        provider: 'sharepoint',
        operation: 'put',
        status: sessionResponse.status,
      });
    }

    try {
      await this.uploadChunks(uploadUrl, params.buffer);
    } catch (error) {
      // Sessão abandonada segura o arquivo pela metade na biblioteca e bloqueia
      // a próxima tentativa até expirar. Cancelar é best-effort: se o cancel
      // falhar, o erro que importa é o original.
      await this.cancelUploadSession(uploadUrl);
      throw error;
    }
  }

  private async uploadChunks(uploadUrl: string, buffer: Buffer): Promise<void> {
    const total = buffer.byteLength;
    const chunkSize = this.config.uploadChunkBytes;

    for (let start = 0; start < total; start += chunkSize) {
      const end = Math.min(start + chunkSize, total);
      const isLast = end === total;
      const chunk = buffer.subarray(start, end);

      const response = await this.send({
        operation: 'put',
        method: 'PUT',
        url: uploadUrl,
        headers: {
          // `end - 1` porque Content-Range é inclusivo nas duas pontas.
          'content-range': `bytes ${start}-${end - 1}/${total}`,
        },
        body: Buffer.from(chunk),
        // A uploadUrl já vem assinada; mandar Authorization nela é motivo
        // documentado de 401 no Graph.
        authenticated: false,
      });

      if (!isLast) {
        if (response.status !== 202) {
          await this.assertOk(response, 'put');
          // 2xx fora de 202 antes do último chunk significa que o Graph fechou
          // a sessão cedo — o arquivo ficaria truncado sem ninguém notar.
          throw new StorageError(
            `sessão de upload respondeu ${response.status} antes do último chunk (bytes ${start}-${end - 1}/${total})`,
            { provider: 'sharepoint', operation: 'put', status: response.status }
          );
        }
        await discardBody(response);
        continue;
      }

      await this.assertOk(response, 'put');
      await discardBody(response);
    }
  }

  private async cancelUploadSession(uploadUrl: string): Promise<void> {
    try {
      const response = await this.send({
        operation: 'put',
        method: 'DELETE',
        url: uploadUrl,
        authenticated: false,
      });
      await discardBody(response);
    } catch {
      // Silenciado de propósito: o erro do upload é o que interessa a quem
      // chamou, e a sessão expira sozinha em pouco tempo.
    }
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private driveRoot(): string {
    return `${this.config.graphBaseUrl}/drives/${encodeURIComponent(this.config.driveId)}/root`;
  }

  /**
   * Converte a chave lógica no caminho dentro da biblioteca, validando as
   * regras de nome do SharePoint antes de gastar um round-trip. O erro daqui é
   * determinístico e explica o que está errado — muito melhor que o
   * `invalidRequest` genérico do Graph.
   */
  private itemPath(key: string, operation: string): string {
    const segments = key.split('/');
    const prefixSegments = this.config.rootFolder?.split('/') ?? [];

    for (const segment of segments) {
      assertSharePointName(segment, key, operation);
    }

    return [...prefixSegments, ...segments].map((s) => encodeURIComponent(s)).join('/');
  }

  /**
   * Executa a requisição com retry em 429/503/504 e em falha de rede.
   *
   * Devolve a `Response` mesmo em erro: quem chama decide o que é tolerável
   * (404 em `delete` é sucesso, em `get` não é) e chama `assertOk` para o resto.
   */
  private async send(spec: RequestSpec): Promise<Response> {
    let attempt = 0;

    for (;;) {
      const headers: Record<string, string> = { ...spec.headers };
      if (spec.authenticated) {
        headers['authorization'] = `Bearer ${await this.getAccessToken(spec.operation)}`;
      }

      let response: Response;
      try {
        response = await this.fetchImpl(spec.url, {
          method: spec.method,
          headers,
          ...(spec.body !== undefined ? { body: spec.body } : {}),
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
      } catch (error) {
        if (attempt >= this.config.maxRetries) {
          throw new StorageError(
            `falha de rede ao falar com o SharePoint (${spec.method} ${redactUrl(spec.url)})`,
            { provider: 'sharepoint', operation: spec.operation, cause: error }
          );
        }
        await this.sleep(backoffDelayMs(attempt));
        attempt += 1;
        continue;
      }

      if (!RETRYABLE_STATUSES.has(response.status)) return response;

      const retryAfterSeconds = parseRetryAfter(
        response.headers.get('retry-after'),
        this.now()
      );

      if (attempt >= this.config.maxRetries) {
        const body = await readBodyText(response);
        const details = parseGraphError(body);
        const requestId = response.headers.get('request-id') ?? details.requestId;
        const motivo =
          response.status === 429 ? 'limite de taxa' : 'indisponibilidade temporária';
        throw new StorageRateLimitError(
          `SharePoint recusou por ${motivo} após ${attempt + 1} tentativas (HTTP ${response.status})${details.message !== undefined ? `: ${details.message}` : ''}`,
          {
            provider: 'sharepoint',
            operation: spec.operation,
            status: response.status,
            ...(details.code !== undefined ? { providerCode: details.code } : {}),
            ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
            ...(requestId !== null && requestId !== undefined ? { requestId } : {}),
          }
        );
      }

      await discardBody(response);
      await this.sleep(
        retryAfterSeconds !== undefined
          ? Math.min(retryAfterSeconds * 1000, MAX_RETRY_DELAY_MS)
          : backoffDelayMs(attempt)
      );
      attempt += 1;
    }
  }

  /** Traduz resposta não-2xx em erro tipado. No-op quando a resposta é 2xx. */
  private async assertOk(response: Response, operation: string): Promise<void> {
    if (response.ok) return;

    const body = await readBodyText(response);
    const details = parseGraphError(body);
    const requestId = response.headers.get('request-id') ?? details.requestId;

    const base = {
      provider: 'sharepoint' as const,
      operation,
      status: response.status,
      ...(details.code !== undefined ? { providerCode: details.code } : {}),
      ...(requestId !== null && requestId !== undefined ? { requestId } : {}),
    };
    const suffix = details.message !== undefined ? `: ${details.message}` : '';

    if (response.status === 401 || response.status === 403) {
      throw new StorageAuthError(
        `SharePoint recusou a credencial da empresa (HTTP ${response.status})${suffix}. ` +
          'Confira clientId/clientSecret e se o app tem a permissão de aplicação Sites.ReadWrite.All com consentimento de administrador.',
        base
      );
    }

    if (response.status === 404) {
      throw new StorageNotFoundError(
        `SharePoint não encontrou o recurso (HTTP 404)${suffix}. ` +
          'Confira o driveId configurado e se a pasta raiz existe na biblioteca.',
        base
      );
    }

    throw new StorageError(
      `SharePoint respondeu HTTP ${response.status} em ${operation}${suffix}`,
      base
    );
  }

  // ── Autenticação ──────────────────────────────────────────────────────────

  /**
   * Token app-only, cacheado até perto do expiry. Chamadas concorrentes
   * compartilham a mesma requisição em voo.
   */
  private async getAccessToken(operation: string): Promise<string> {
    const cached = this.cachedToken;
    if (cached !== null && cached.expiresAtMs > this.now()) return cached.value;

    let pending = this.pendingToken;
    if (pending === null) {
      pending = this.requestToken(operation).finally(() => {
        this.pendingToken = null;
      });
      this.pendingToken = pending;
    }
    return pending;
  }

  private async requestToken(operation: string): Promise<string> {
    const url = `${this.config.loginBaseUrl}/${encodeURIComponent(this.config.azureTenantId)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: GRAPH_SCOPE,
      grant_type: 'client_credentials',
    }).toString();

    const response = await this.send({
      operation: 'auth',
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      authenticated: false,
    });

    if (!response.ok) {
      const text = await readBodyText(response);
      const oauth = parseOAuthError(text);
      throw new StorageAuthError(
        `Entra ID recusou as credenciais da empresa (HTTP ${response.status})${
          oauth.description !== undefined ? `: ${oauth.description}` : ''
        }`,
        {
          provider: 'sharepoint',
          operation,
          status: response.status,
          ...(oauth.code !== undefined ? { providerCode: oauth.code } : {}),
        }
      );
    }

    const payload = await readJson(response, 'auth');
    const accessToken = payload['access_token'];
    const expiresIn = payload['expires_in'];
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new StorageAuthError('Entra ID devolveu resposta sem access_token', {
        provider: 'sharepoint',
        operation,
        status: response.status,
      });
    }

    const lifetimeSeconds =
      typeof expiresIn === 'number' && Number.isFinite(expiresIn)
        ? Math.max(expiresIn - TOKEN_EXPIRY_SKEW_SECONDS, TOKEN_MIN_LIFETIME_SECONDS)
        : TOKEN_MIN_LIFETIME_SECONDS;

    this.cachedToken = {
      value: accessToken,
      expiresAtMs: this.now() + lifetimeSeconds * 1000,
    };
    return accessToken;
  }
}

/** Factory que cria um `SharePointDriver` a partir de uma config já resolvida. */
export function createSharePointDriver(
  config: SharePointConfig,
  deps: SharePointDriverDeps = {}
): SharePointDriver {
  return new SharePointDriver(config, deps);
}

// ── Auxiliares ──────────────────────────────────────────────────────────────

function assertNonEmpty(value: string | undefined, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StorageConfigError(`SharePointConfig.${field} é obrigatório`, {
      provider: 'sharepoint',
      operation: 'config',
    });
  }
}

function normalizeRootFolder(rootFolder: string | undefined): string | undefined {
  if (rootFolder === undefined) return undefined;
  const trimmed = rootFolder.replace(/^\/+|\/+$/g, '');
  if (trimmed.length === 0) return undefined;

  // Pasta raiz com caractere proibido faria TODA operação falhar no Graph.
  // Melhor recusar no cadastro do que a cada upload.
  for (const segment of trimmed.split('/')) {
    if (segment.length === 0 || FORBIDDEN_NAME_CHARS.test(segment)) {
      throw new StorageConfigError(
        `SharePointConfig.rootFolder tem segmento inválido para o SharePoint: ${rootFolder}`,
        { provider: 'sharepoint', operation: 'config' }
      );
    }
  }
  return trimmed;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Regras de nome do SharePoint que valem a checagem local. Não é a lista
 * completa da Microsoft (nomes reservados de sistema, `~$`, etc. também
 * existem), mas cobre o que aparece em nome de arquivo enviado por usuário.
 */
function assertSharePointName(segment: string, key: string, operation: string): void {
  const fail = (motivo: string): never => {
    throw new StorageInvalidKeyError(
      `chave incompatível com o SharePoint (${motivo}): ${key}`,
      { provider: 'sharepoint', operation }
    );
  };

  if (segment.length === 0) fail('segmento vazio — barra duplicada ou sobrando');
  if (segment === '.' || segment === '..') fail(`segmento "${segment}" não é permitido`);
  if (FORBIDDEN_NAME_CHARS.test(segment)) fail('caractere proibido em " * : < > ? \\ |');
  if (segment.startsWith(' ') || segment.endsWith(' ')) fail('espaço no início ou no fim do nome');
  if (segment.endsWith('.')) fail('nome terminando em ponto');
  if (segment.startsWith('~$')) fail('nome começando com ~$');
}

function backoffDelayMs(attempt: number): number {
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

/**
 * `Retry-After` vem em segundos ou como data HTTP. O Graph usa segundos, mas o
 * front-end da Microsoft já devolveu data em 503 — aceitar os dois é barato.
 */
function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined;

  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(Math.ceil((dateMs - nowMs) / 1000), 0);
}

interface GraphErrorDetails {
  code: string | undefined;
  message: string | undefined;
  requestId: string | undefined;
}

/**
 * Extrai `error.code` / `error.message` do corpo de erro do Graph. Corpo vazio,
 * HTML de proxy ou JSON de formato inesperado não podem virar exceção aqui: já
 * estamos tratando um erro, e perder o status original por causa do parse
 * deixaria o log pior do que sem ele.
 */
function parseGraphError(body: string): GraphErrorDetails {
  const empty: GraphErrorDetails = { code: undefined, message: undefined, requestId: undefined };
  if (body.length === 0) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Não-JSON (HTML de gateway, por exemplo): devolve um resumo curto.
    return { ...empty, message: truncate(body.replace(/\s+/g, ' ').trim(), 200) };
  }

  if (typeof parsed !== 'object' || parsed === null) return empty;
  const error = (parsed as Record<string, unknown>)['error'];
  if (typeof error !== 'object' || error === null) return empty;

  const record = error as Record<string, unknown>;
  const inner = record['innerError'];
  const requestId =
    typeof inner === 'object' && inner !== null
      ? (inner as Record<string, unknown>)['request-id']
      : undefined;

  return {
    code: typeof record['code'] === 'string' ? record['code'] : undefined,
    message:
      typeof record['message'] === 'string' ? truncate(record['message'], 300) : undefined,
    requestId: typeof requestId === 'string' ? requestId : undefined,
  };
}

/**
 * Erro do endpoint de token: `{ error, error_description }`. A descrição do
 * Entra ID tem várias linhas com timestamp e trace id; a primeira linha
 * (`AADSTS7000215: Invalid client secret provided`) é a que resolve o chamado.
 */
function parseOAuthError(body: string): { code: string | undefined; description: string | undefined } {
  if (body.length === 0) return { code: undefined, description: undefined };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { code: undefined, description: truncate(body.replace(/\s+/g, ' ').trim(), 200) };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { code: undefined, description: undefined };
  }
  const record = parsed as Record<string, unknown>;
  const description = record['error_description'];

  return {
    code: typeof record['error'] === 'string' ? record['error'] : undefined,
    description:
      typeof description === 'string'
        ? truncate((description.split('\n')[0] ?? description).trim(), 300)
        : undefined,
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function readJson(response: Response, operation: string): Promise<Record<string, unknown>> {
  const text = await readBodyText(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StorageError('resposta do Microsoft Graph não é JSON válido', {
      provider: 'sharepoint',
      operation,
      status: response.status,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StorageError('resposta do Microsoft Graph em formato inesperado', {
      provider: 'sharepoint',
      operation,
      status: response.status,
    });
  }
  return parsed as Record<string, unknown>;
}

/** Descarta o corpo sem vazar socket, tolerando mocks que não têm `body`. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Corpo já consumido ou ausente — nada a fazer.
  }
}

/**
 * A uploadUrl da sessão carrega credencial na query string. Nunca deve entrar
 * em mensagem de erro nem em log.
 */
function redactUrl(url: string): string {
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : `${url.slice(0, queryStart)}?<omitido>`;
}
