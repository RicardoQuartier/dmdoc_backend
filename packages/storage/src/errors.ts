import type { StorageProvider } from './driver.js';

/**
 * Erros tipados de armazenamento.
 *
 * Quem chama a interface `StorageDriver` não conhece o provedor por trás dela e
 * não deve precisar interpretar mensagem de texto para decidir o que fazer. As
 * classes abaixo separam o que o chamador realmente distingue:
 *
 * - `StorageAuthError` — credencial da empresa errada, expirada ou sem a
 *   permissão necessária. É problema de configuração do cliente: repetir a
 *   operação não resolve, alguém precisa arrumar o cadastro.
 * - `StorageNotFoundError` — o objeto não está lá.
 * - `StorageRateLimitError` — o provedor pediu para desacelerar e as tentativas
 *   internas acabaram. O job pode ser reagendado.
 * - `StorageInvalidKeyError` — a chave é inválida para o provedor de destino
 *   (ex.: nome de arquivo com caractere que o SharePoint recusa). Falha
 *   determinística: reenviar o mesmo arquivo dá o mesmo erro.
 * - `StorageConfigError` — configuração do driver inválida, detectada na
 *   construção, antes de qualquer I/O.
 * - `StorageError` — o resto (falha de rede, erro inesperado do provedor).
 *
 * Nenhuma delas carrega segredo: mensagem e campos são seguros para log.
 */

export interface StorageErrorDetails {
  provider: StorageProvider;
  /** Operação da interface que falhou: `put`, `get`, `delete`, `auth`... */
  operation: string;
  /** Status HTTP devolvido pelo provedor, quando houve resposta. */
  status?: number | undefined;
  /** Código de erro do provedor (`error.code` do Graph, `error` do OAuth). */
  providerCode?: string | undefined;
  /** Identificador da requisição no provedor — é o que o suporte pede. */
  requestId?: string | undefined;
  cause?: unknown;
}

export class StorageError extends Error {
  readonly provider: StorageProvider;
  readonly operation: string;
  readonly status: number | undefined;
  readonly providerCode: string | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, details: StorageErrorDetails) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    // `new.target.name` mantém o nome correto nas subclasses sem repetir a
    // atribuição em cada uma delas.
    this.name = new.target.name;
    this.provider = details.provider;
    this.operation = details.operation;
    this.status = details.status;
    this.providerCode = details.providerCode;
    this.requestId = details.requestId;
  }
}

/** Credencial inválida, expirada ou sem permissão. Repetir não resolve. */
export class StorageAuthError extends StorageError {}

/** Objeto ou pasta inexistente no destino. */
export class StorageNotFoundError extends StorageError {}

/** Provedor limitou a taxa e as tentativas internas se esgotaram. */
export class StorageRateLimitError extends StorageError {
  /** Espera sugerida pelo provedor (header `Retry-After`), em segundos. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    details: StorageErrorDetails & { retryAfterSeconds?: number | undefined }
  ) {
    super(message, details);
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

/** Chave incompatível com as regras de nome do provedor de destino. */
export class StorageInvalidKeyError extends StorageError {}

/** Configuração do driver inválida — detectada antes de qualquer chamada. */
export class StorageConfigError extends StorageError {}

/**
 * A empresa tem um destino de armazenamento que não vira driver: provider
 * desconhecido, campo obrigatório ausente no jsonb, segredo ilegível.
 *
 * NÃO herda de `StorageError` de propósito — este erro nasce antes de existir
 * um provedor, e preencher `provider` com um chute tornaria o log mentiroso.
 * Para quem chama, todos esses casos são a mesma coisa: o cadastro de
 * armazenamento daquela empresa precisa de conserto, repetir não resolve.
 */
export class StorageTargetError extends Error {
  readonly tenantId: string;

  constructor(message: string, tenantId: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'StorageTargetError';
    this.tenantId = tenantId;
  }
}
