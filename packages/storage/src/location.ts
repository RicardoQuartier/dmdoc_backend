import type { S3Config } from './s3-driver.js';

/**
 * Identidade FÍSICA de um destino de armazenamento.
 *
 * ## Por que isto existe
 *
 * Duas configurações DIFERENTES podem apontar para o MESMO lugar. O caso real e
 * nada exótico é a rotação de credencial: um `PUT` com uma access key nova cria
 * uma linha nova em `tenant_storage_configs` (as linhas são imutáveis) para o
 * mesmo bucket. O acervo antigo continua apontando para a configuração anterior
 * até a migração comutá-lo.
 *
 * Duas operações destrutivas dependem de saber disso:
 *
 * - **`cleanup-source`** (T-141): varrer "o destino anterior" com um
 *   `deletePrefix` quando ele é fisicamente o mesmo bucket do destino ativo
 *   apagaria exatamente os arquivos que a migração acabou de gravar.
 * - **purga de empresa** (T-142): a varredura levanta TODAS as configurações do
 *   tenant; sem esta comparação, uma empresa que só rotacionou credencial teria
 *   o mesmo bucket varrido duas ou três vezes.
 *
 * ## Por que não é `sameStorageConfig`
 *
 * Aquela função (`apps/api/src/lib/storage-admin.ts`) compara o jsonb INTEIRO,
 * inclusive `accessKeyId` — e diria "diferentes" para duas credenciais do mesmo
 * bucket, que é justamente o caso perigoso. Ela serve à idempotência do `PUT`,
 * não à identidade do lugar.
 *
 * ## Por que mora em `@dmdoc/storage`, e não na app
 *
 * Saber o que é um "lugar físico" é conhecimento de storage: endpoint + bucket
 * no S3, site + drive + pasta raiz no SharePoint. Nasceu em `apps/api` porque só
 * a rota de limpeza precisava dela; com a purga de empresa no worker (T-142) o
 * segundo consumidor apareceu, e duas cópias divergiriam no dia em que um
 * provider novo entrasse.
 *
 * ## O que entra na identidade
 *
 * - **S3**: endpoint (ou `aws`, quando é a AWS pública) + bucket. A região fica
 *   de fora de propósito: o mesmo bucket declarado com regiões diferentes é o
 *   mesmo bucket, e nomes de bucket são únicos dentro de um endpoint.
 * - **SharePoint**: site + drive + pasta raiz. Duas configurações no mesmo drive
 *   com pastas raiz diferentes são lugares diferentes; com a mesma pasta, o
 *   mesmo lugar.
 *
 * `provider` e `credentials_source` chegam como `string` (e não como união
 * fechada) porque a entrada é uma linha CRUA do banco: um valor inesperado tem
 * de produzir uma chave qualquer — nunca uma exceção, e nunca colidir com a
 * chave da plataforma.
 */
export function storageLocationKey(
  provider: string,
  credentialsSource: string,
  config: unknown,
  platformS3Config: S3Config
): string {
  if (provider === 's3' && credentialsSource === 'platform') {
    return s3LocationKey(platformS3Config.endpoint, platformS3Config.bucket);
  }

  const fields =
    config !== null && typeof config === 'object' ? (config as Record<string, unknown>) : {};
  const text = (field: string): string =>
    typeof fields[field] === 'string' ? (fields[field] as string) : '';

  if (provider === 'sharepoint') {
    return ['sharepoint', text('siteId'), text('driveId'), text('rootFolder')].join('|');
  }

  return s3LocationKey(text('endpoint') === '' ? undefined : text('endpoint'), text('bucket'));
}

/** Endpoint normalizado (sem barra final, minúsculo) + bucket. */
function s3LocationKey(endpoint: string | undefined, bucket: string): string {
  const host = (endpoint ?? 'aws').toLowerCase().replace(/\/+$/, '');
  return ['s3', host, bucket].join('|');
}
