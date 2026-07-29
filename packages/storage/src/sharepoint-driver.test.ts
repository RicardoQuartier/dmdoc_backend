import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  StorageAuthError,
  StorageConfigError,
  StorageError,
  StorageInvalidKeyError,
  StorageNotFoundError,
  StorageRateLimitError,
} from './errors.js';
import {
  createSharePointDriver,
  type FetchLike,
  type SharePointConfig,
} from './sharepoint-driver.js';

/**
 * Testes do driver SharePoint.
 *
 * Todo o HTTP é mockado por um `fetch` injetado — nenhum socket é aberto e
 * nenhuma credencial real é necessária. O relógio e o `sleep` também são
 * injetados, então expiry de token e backoff de retry são verificados sem
 * esperar tempo real.
 *
 * O que estes testes NÃO cobrem (bloco B da T-139, precisa de credencial do
 * cliente): o comportamento real do Graph — formato exato da uploadUrl, headers
 * da URL pré-autenticada e latência.
 */

const START_MS = Date.UTC(2026, 6, 29, 12, 0, 0);

const BASE_CONFIG: SharePointConfig = {
  azureTenantId: 'aad-tenant-id',
  clientId: 'client-id',
  clientSecret: 'segredo-do-cliente',
  siteId: 'site-1',
  driveId: 'drive-1',
  rootFolder: 'DMDoc',
  // Nos testes nenhuma tentativa extra: fetch inesperado deve falhar na hora,
  // não virar três repetições de erro confuso. Os testes de retry sobrescrevem.
  maxRetries: 0,
  requestTimeoutMs: 1_000,
};

const KEY = 'tenants/t1/documents/abc123/nota fiscal.pdf';
const ENCODED_ITEM_URL =
  'https://graph.microsoft.com/v1.0/drives/drive-1/root:/DMDoc/tenants/t1/documents/abc123/nota%20fiscal.pdf';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function tokenResponse(expiresIn = 3600): Response {
  return jsonResponse({
    token_type: 'Bearer',
    expires_in: expiresIn,
    access_token: 'token-abc',
  });
}

function createHarness(overrides: Partial<SharePointConfig> = {}) {
  const calls: RecordedCall[] = [];
  const queue: Array<Response | Error> = [];
  const sleeps: number[] = [];
  let clock = START_MS;

  const fetchMock: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body: init?.body,
    });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`fetch inesperado: ${init?.method ?? 'GET'} ${url}`);
    }
    if (next instanceof Error) throw next;
    return next;
  };

  const driver = createSharePointDriver(
    { ...BASE_CONFIG, ...overrides },
    {
      fetch: fetchMock,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    }
  );

  return {
    driver,
    calls,
    sleeps,
    enqueue: (...responses: Array<Response | Error>) => queue.push(...responses),
    advanceMs: (ms: number) => {
      clock += ms;
    },
  };
}

// ── Autenticação ────────────────────────────────────────────────────────────

describe('SharePointDriver — autenticação app-only', () => {
  it('pede o token com client_credentials no diretório configurado', async () => {
    const h = createHarness();
    h.enqueue(tokenResponse(), new Response(null, { status: 204 }));

    await h.driver.delete(KEY);

    const tokenCall = h.calls[0];
    expect(tokenCall?.url).toBe(
      'https://login.microsoftonline.com/aad-tenant-id/oauth2/v2.0/token'
    );
    expect(tokenCall?.method).toBe('POST');
    expect(tokenCall?.headers['content-type']).toBe('application/x-www-form-urlencoded');

    const params = new URLSearchParams(tokenCall?.body as string);
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('scope')).toBe('https://graph.microsoft.com/.default');
    expect(params.get('client_id')).toBe('client-id');
    expect(params.get('client_secret')).toBe('segredo-do-cliente');

    expect(h.calls[1]?.headers['authorization']).toBe('Bearer token-abc');
  });

  it('reaproveita o token cacheado entre operações', async () => {
    const h = createHarness();
    h.enqueue(
      tokenResponse(),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 })
    );

    await h.driver.delete(KEY);
    await h.driver.delete(KEY);

    expect(h.calls.filter((c) => c.url.includes('oauth2/v2.0/token'))).toHaveLength(1);
  });

  it('renova o token depois do expiry, com folga de 5 min', async () => {
    const h = createHarness();
    h.enqueue(tokenResponse(3600), new Response(null, { status: 204 }));
    await h.driver.delete(KEY);

    // 3600 - 300 de folga = 3300 s de validade. Um segundo depois disso o
    // token precisa ser renovado.
    h.advanceMs(3_301_000);
    h.enqueue(tokenResponse(3600), new Response(null, { status: 204 }));
    await h.driver.delete(KEY);

    expect(h.calls.filter((c) => c.url.includes('oauth2/v2.0/token'))).toHaveLength(2);
  });

  it('não renova o token enquanto ele está dentro da folga', async () => {
    const h = createHarness();
    h.enqueue(tokenResponse(3600), new Response(null, { status: 204 }));
    await h.driver.delete(KEY);

    h.advanceMs(3_299_000);
    h.enqueue(new Response(null, { status: 204 }));
    await h.driver.delete(KEY);

    expect(h.calls.filter((c) => c.url.includes('oauth2/v2.0/token'))).toHaveLength(1);
  });

  it('operações concorrentes compartilham uma única requisição de token', async () => {
    const h = createHarness();
    h.enqueue(
      tokenResponse(),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 })
    );

    await Promise.all([h.driver.delete(KEY), h.driver.delete(KEY), h.driver.delete(KEY)]);

    expect(h.calls.filter((c) => c.url.includes('oauth2/v2.0/token'))).toHaveLength(1);
  });

  it('credencial inválida vira StorageAuthError com a mensagem do Entra ID', async () => {
    const h = createHarness();
    h.enqueue(
      jsonResponse(
        {
          error: 'invalid_client',
          error_description:
            'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: 123\r\nCorrelation ID: 456',
        },
        { status: 401 }
      )
    );

    const erro = await h.driver.delete(KEY).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(StorageAuthError);
    const authError = erro as StorageAuthError;
    expect(authError.message).toContain('AADSTS7000215');
    expect(authError.providerCode).toBe('invalid_client');
    expect(authError.status).toBe(401);
    // Trace/correlation id sobram na descrição; a primeira linha é o que resolve.
    expect(authError.message).not.toContain('Correlation ID');
    // O segredo jamais pode vazar em mensagem de erro.
    expect(authError.message).not.toContain('segredo-do-cliente');
  });

  it('resposta de token sem access_token vira StorageAuthError', async () => {
    const h = createHarness();
    h.enqueue(jsonResponse({ token_type: 'Bearer', expires_in: 3600 }));

    await expect(h.driver.delete(KEY)).rejects.toBeInstanceOf(StorageAuthError);
  });

  it('403 do Graph aponta a permissão que falta', async () => {
    const h = createHarness();
    h.enqueue(
      tokenResponse(),
      jsonResponse(
        { error: { code: 'accessDenied', message: 'Access denied' } },
        { status: 403 }
      )
    );

    const erro = (await h.driver.delete(KEY).catch((e: unknown) => e)) as StorageAuthError;

    expect(erro).toBeInstanceOf(StorageAuthError);
    expect(erro.message).toContain('Sites.ReadWrite.All');
    expect(erro.providerCode).toBe('accessDenied');
  });
});

// ── put ≤ 4 MB ──────────────────────────────────────────────────────────────

describe('SharePointDriver.put — upload simples', () => {
  it('envia PUT em /content no caminho da chave, com replace explícito', async () => {
    const h = createHarness();
    h.enqueue(tokenResponse(), jsonResponse({ id: 'item-1' }, { status: 201 }));

    const buffer = Buffer.from('conteudo do pdf');
    await h.driver.put({ key: KEY, buffer, mimeType: 'application/pdf' });

    const put = h.calls[1];
    expect(put?.method).toBe('PUT');
    expect(put?.url).toBe(
      `${ENCODED_ITEM_URL}:/content?%40microsoft.graph.conflictBehavior=replace`
    );
    expect(put?.headers['content-type']).toBe('application/pdf');
    expect(put?.body).toEqual(buffer);
  });

  it('sem rootFolder, a chave é o caminho a partir da raiz do drive', async () => {
    const h = createHarness({ rootFolder: undefined });
    h.enqueue(tokenResponse(), jsonResponse({ id: 'item-1' }, { status: 201 }));

    await h.driver.put({ key: 'tenants/t1/a.pdf', buffer: Buffer.from('x'), mimeType: 'x/y' });

    expect(h.calls[1]?.url).toContain(
      'https://graph.microsoft.com/v1.0/drives/drive-1/root:/tenants/t1/a.pdf:/content'
    );
  });

  it('recusa localmente chave com caractere proibido pelo SharePoint', async () => {
    const h = createHarness();

    const erro = (await h.driver
      .put({
        key: 'tenants/t1/documents/h/relatorio 1:2.pdf',
        buffer: Buffer.from('x'),
        mimeType: 'application/pdf',
      })
      .catch((e: unknown) => e)) as StorageInvalidKeyError;

    expect(erro).toBeInstanceOf(StorageInvalidKeyError);
    // Falha determinística: nem o token chega a ser pedido.
    expect(h.calls).toHaveLength(0);
  });

  it('recusa chave com segmento vazio', async () => {
    const h = createHarness();

    await expect(
      h.driver.put({ key: 'tenants//a.pdf', buffer: Buffer.from('x'), mimeType: 'x/y' })
    ).rejects.toBeInstanceOf(StorageInvalidKeyError);
  });

  it('erro inesperado do Graph vira StorageError com status e código', async () => {
    const h = createHarness();
    h.enqueue(
      tokenResponse(),
      jsonResponse(
        {
          error: {
            code: 'invalidRequest',
            message: 'Bad request',
            innerError: { 'request-id': 'req-9' },
          },
        },
        { status: 400 }
      )
    );

    const erro = (await h.driver
      .put({ key: KEY, buffer: Buffer.from('x'), mimeType: 'application/pdf' })
      .catch((e: unknown) => e)) as StorageError;

    expect(erro).toBeInstanceOf(StorageError);
    expect(erro).not.toBeInstanceOf(StorageAuthError);
    expect(erro.status).toBe(400);
    expect(erro.providerCode).toBe('invalidRequest');
    expect(erro.requestId).toBe('req-9');
  });
});

// ── put > 4 MB ──────────────────────────────────────────────────────────────

const CHUNK_UNIT = 320 * 1024;

describe('SharePointDriver.put — upload session', () => {
  it('cria a sessão e envia chunks múltiplos de 320 KiB, sem Authorization', async () => {
    const chunkBytes = 2 * CHUNK_UNIT;
    const h = createHarness({ uploadChunkBytes: chunkBytes });

    // 4 MiB + 1 byte: um byte acima do limite do PUT simples. Conteúdo
    // aleatório para que a remontagem dos chunks só passe se as fatias
    // estiverem na ordem e nos offsets certos.
    const total = 4 * 1024 * 1024 + 1;
    const buffer = randomBytes(total);

    const chunkCount = Math.ceil(total / chunkBytes);
    h.enqueue(
      tokenResponse(),
      jsonResponse({ uploadUrl: 'https://upload.sharepoint.com/sess?guid=1' })
    );
    for (let i = 0; i < chunkCount - 1; i += 1) {
      h.enqueue(jsonResponse({ nextExpectedRanges: ['x'] }, { status: 202 }));
    }
    h.enqueue(jsonResponse({ id: 'item-1' }, { status: 201 }));

    await h.driver.put({ key: KEY, buffer, mimeType: 'application/pdf' });

    const session = h.calls[1];
    expect(session?.method).toBe('POST');
    expect(session?.url).toBe(`${ENCODED_ITEM_URL}:/createUploadSession`);
    expect(JSON.parse(session?.body as string)).toEqual({
      item: { '@microsoft.graph.conflictBehavior': 'replace' },
    });

    const chunks = h.calls.slice(2);
    expect(chunks).toHaveLength(chunkCount);

    const enviado: Buffer[] = [];
    chunks.forEach((call, index) => {
      expect(call.method).toBe('PUT');
      expect(call.url).toBe('https://upload.sharepoint.com/sess?guid=1');
      // A uploadUrl já é pré-autenticada; mandar Bearer nela é 401 na certa.
      expect(call.headers['authorization']).toBeUndefined();

      const body = call.body as Buffer;
      const start = index * chunkBytes;
      const end = Math.min(start + chunkBytes, total);
      expect(call.headers['content-range']).toBe(`bytes ${start}-${end - 1}/${total}`);
      // Regra do Graph: todo chunk menos o último é múltiplo de 320 KiB.
      if (index < chunkCount - 1) expect(body.byteLength % CHUNK_UNIT).toBe(0);
      enviado.push(body);
    });

    // Integridade: os chunks remontam exatamente o arquivo original.
    // `Buffer.compare` em vez de `toEqual` — a comparação profunda do vitest em
    // 4 MiB leva segundos e não acrescenta nada.
    expect(Buffer.compare(Buffer.concat(enviado), buffer)).toBe(0);
  });

  it('cancela a sessão quando um chunk falha e propaga o erro original', async () => {
    const chunkBytes = 8 * CHUNK_UNIT;
    const h = createHarness({ uploadChunkBytes: chunkBytes });
    const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);

    h.enqueue(
      tokenResponse(),
      jsonResponse({ uploadUrl: 'https://upload.sharepoint.com/sess?guid=2' }),
      jsonResponse({ error: { code: 'invalidRange', message: 'Bad range' } }, { status: 416 }),
      new Response(null, { status: 204 }) // cancelamento da sessão
    );

    const erro = (await h.driver
      .put({ key: KEY, buffer, mimeType: 'application/pdf' })
      .catch((e: unknown) => e)) as StorageError;

    expect(erro).toBeInstanceOf(StorageError);
    expect(erro.status).toBe(416);

    const cancel = h.calls[3];
    expect(cancel?.method).toBe('DELETE');
    expect(cancel?.url).toBe('https://upload.sharepoint.com/sess?guid=2');
  });

  it('sessão sem uploadUrl vira StorageError', async () => {
    const h = createHarness();
    h.enqueue(
      tokenResponse(),
      jsonResponse({ expirationDateTime: '2026-07-29T13:00:00Z' }),
      new Response(null, { status: 204 })
    );

    await expect(
      h.driver.put({
        key: KEY,
        buffer: Buffer.alloc(4 * 1024 * 1024 + 1),
        mimeType: 'application/pdf',
      })
    ).rejects.toBeInstanceOf(StorageError);
  });

  it('chunk configurado fora da grade de 320 KiB é recusado na construção', () => {
    expect(() => createHarness({ uploadChunkBytes: 1_000_000 })).toThrow(StorageConfigError);
  });
});

// ── get / getDownloadUrl ────────────────────────────────────────────────────

describe('SharePointDriver.get', () => {
  it('baixa o conteúdo do item como Buffer', async () => {
    const h = createHarness();
    h.enqueue(tokenResponse(), new Response(Buffer.from([1, 2, 3])));

    const buffer = await h.driver.get(KEY);

    expect(h.calls[1]?.url).toBe(`${ENCODED_ITEM_URL}:/content`);
    expect(buffer).toEqual(Buffer.from([1, 2, 3]));
  });

  it('404 vira StorageNotFoundError com a chave na mensagem', async () => {
    const h = createHarness();
    h.enqueue(
      tokenResponse(),
      jsonResponse({ error: { code: 'itemNotFound' } }, { status: 404 })
    );

    const erro = (await h.driver.get(KEY).catch((e: unknown) => e)) as StorageNotFoundError;

    expect(erro).toBeInstanceOf(StorageNotFoundError);
    expect(erro.message).toContain(KEY);
  });
});

describe('SharePointDriver.getDownloadUrl', () => {
  it('devolve a URL pré-autenticada do Graph', async () => {
    const h = createHarness();
    h.enqueue(
      tokenResponse(),
      jsonResponse({
        id: 'item-1',
        '@microsoft.graph.downloadUrl': 'https://contoso.sharepoint.com/_layouts/15/download.aspx?x=1',
      })
    );

    const url = await h.driver.getDownloadUrl(KEY, {
      expiresInSeconds: 300,
      audience: 'browser',
    });

    expect(h.calls[1]?.method).toBe('GET');
    expect(h.calls[1]?.url).toBe(ENCODED_ITEM_URL);
    expect(url).toBe('https://contoso.sharepoint.com/_layouts/15/download.aspx?x=1');
  });

  it('a audiência não muda a URL — ela é pública nos dois casos', async () => {
    const h = createHarness();
    const item = {
      '@microsoft.graph.downloadUrl': 'https://contoso.sharepoint.com/download?x=1',
    };
    h.enqueue(tokenResponse(), jsonResponse(item), jsonResponse(item));

    const browser = await h.driver.getDownloadUrl(KEY, {
      expiresInSeconds: 300,
      audience: 'browser',
    });
    const internal = await h.driver.getDownloadUrl(KEY, {
      expiresInSeconds: 300,
      audience: 'internal',
    });

    expect(browser).toBe(internal);
  });

  it('item sem downloadUrl vira StorageError', async () => {
    const h = createHarness();
    h.enqueue(tokenResponse(), jsonResponse({ id: 'item-1', folder: { childCount: 0 } }));

    await expect(
      h.driver.getDownloadUrl(KEY, { expiresInSeconds: 300, audience: 'browser' })
    ).rejects.toBeInstanceOf(StorageError);
  });

  it('404 vira StorageNotFoundError', async () => {
    const h = createHarness();
    h.enqueue(tokenResponse(), jsonResponse({ error: { code: 'itemNotFound' } }, { status: 404 }));

    await expect(
      h.driver.getDownloadUrl(KEY, { expiresInSeconds: 300, audience: 'browser' })
    ).rejects.toBeInstanceOf(StorageNotFoundError);
  });
});

// ── delete / deletePrefix ───────────────────────────────────────────────────

describe('SharePointDriver.delete', () => {
  it('apaga o item pelo caminho', async () => {
    const h = createHarness();
    h.enqueue(tokenResponse(), new Response(null, { status: 204 }));

    await h.driver.delete(KEY);

    expect(h.calls[1]?.method).toBe('DELETE');
    expect(h.calls[1]?.url).toBe(ENCODED_ITEM_URL);
  });

  it('item inexistente é no-op — exclusão é idempotente', async () => {
    const h = createHarness();
    h.enqueue(tokenResponse(), jsonResponse({ error: { code: 'itemNotFound' } }, { status: 404 }));

    await expect(h.driver.delete(KEY)).resolves.toBeUndefined();
  });
});

describe('SharePointDriver.deletePrefix', () => {
  it('apaga a pasta do prefixo de uma vez, sem listar itens', async () => {
    const h = createHarness();
    h.enqueue(tokenResponse(), new Response(null, { status: 204 }));

    await h.driver.deletePrefix('tenants/t1/');

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.method).toBe('DELETE');
    expect(h.calls[1]?.url).toBe(
      'https://graph.microsoft.com/v1.0/drives/drive-1/root:/DMDoc/tenants/t1'
    );
  });

  it('prefixo sem pasta correspondente é no-op', async () => {
    const h = createHarness();
    h.enqueue(tokenResponse(), jsonResponse({ error: { code: 'itemNotFound' } }, { status: 404 }));

    await expect(h.driver.deletePrefix('tenants/nunca-enviou/')).resolves.toBeUndefined();
  });

  it('prefixo vazio é recusado — apagaria a biblioteca inteira do cliente', async () => {
    const h = createHarness();

    await expect(h.driver.deletePrefix('')).rejects.toBeInstanceOf(StorageInvalidKeyError);
    expect(h.calls).toHaveLength(0);
  });
});

// ── Retry ───────────────────────────────────────────────────────────────────

describe('SharePointDriver — throttling do Graph', () => {
  it('429 com Retry-After em segundos: espera o pedido e repete', async () => {
    const h = createHarness({ maxRetries: 3 });
    h.enqueue(
      tokenResponse(),
      new Response('{}', { status: 429, headers: { 'retry-after': '7' } }),
      new Response(null, { status: 204 })
    );

    await h.driver.delete(KEY);

    expect(h.sleeps).toEqual([7000]);
    expect(h.calls).toHaveLength(3);
  });

  it('503 com Retry-After em data HTTP: converte para segundos', async () => {
    const h = createHarness({ maxRetries: 3 });
    h.enqueue(
      tokenResponse(),
      new Response('{}', {
        status: 503,
        headers: { 'retry-after': new Date(START_MS + 30_000).toUTCString() },
      }),
      new Response(null, { status: 204 })
    );

    await h.driver.delete(KEY);

    expect(h.sleeps).toEqual([30_000]);
  });

  it('sem Retry-After, usa backoff exponencial', async () => {
    const h = createHarness({ maxRetries: 3 });
    h.enqueue(
      tokenResponse(),
      new Response('{}', { status: 503 }),
      new Response('{}', { status: 503 }),
      new Response(null, { status: 204 })
    );

    await h.driver.delete(KEY);

    expect(h.sleeps).toEqual([1000, 2000]);
  });

  it('tentativas esgotadas viram StorageRateLimitError com o Retry-After', async () => {
    const h = createHarness({ maxRetries: 2 });
    h.enqueue(
      tokenResponse(),
      new Response('{}', { status: 429, headers: { 'retry-after': '3' } }),
      new Response('{}', { status: 429, headers: { 'retry-after': '3' } }),
      new Response(
        JSON.stringify({ error: { code: 'activityLimitReached', message: 'Throttled' } }),
        { status: 429, headers: { 'retry-after': '5' } }
      )
    );

    const erro = (await h.driver.delete(KEY).catch((e: unknown) => e)) as StorageRateLimitError;

    expect(erro).toBeInstanceOf(StorageRateLimitError);
    expect(erro.retryAfterSeconds).toBe(5);
    expect(erro.providerCode).toBe('activityLimitReached');
    expect(erro.message).toContain('3 tentativas');
    expect(h.sleeps).toEqual([3000, 3000]);
  });

  it('o token também respeita o throttling do Entra ID', async () => {
    const h = createHarness({ maxRetries: 1 });
    h.enqueue(
      new Response('{}', { status: 429, headers: { 'retry-after': '2' } }),
      tokenResponse(),
      new Response(null, { status: 204 })
    );

    await h.driver.delete(KEY);

    expect(h.sleeps).toEqual([2000]);
  });

  it('falha de rede é repetida e, esgotada, vira StorageError sem vazar a query da uploadUrl', async () => {
    const h = createHarness({ maxRetries: 1 });
    h.enqueue(new Error('ECONNRESET'), new Error('ECONNRESET'));

    const erro = (await h.driver.delete(KEY).catch((e: unknown) => e)) as StorageError;

    expect(erro).toBeInstanceOf(StorageError);
    expect(erro.message).toContain('falha de rede');
    expect(erro.message).not.toContain('client_secret');
    expect(h.sleeps).toEqual([1000]);
  });

  it('400 não é repetido — erro determinístico não melhora com insistência', async () => {
    const h = createHarness({ maxRetries: 3 });
    h.enqueue(tokenResponse(), jsonResponse({ error: { code: 'invalidRequest' } }, { status: 400 }));

    await expect(h.driver.delete(KEY)).rejects.toBeInstanceOf(StorageError);
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([]);
  });
});

// ── Configuração ────────────────────────────────────────────────────────────

describe('SharePointDriver — configuração', () => {
  it('exige os campos obrigatórios', () => {
    expect(() => createHarness({ driveId: '' })).toThrow(StorageConfigError);
    expect(() => createHarness({ clientSecret: '   ' })).toThrow(StorageConfigError);
  });

  it('recusa rootFolder com caractere proibido no cadastro, não a cada upload', () => {
    expect(() => createHarness({ rootFolder: 'DM:Doc' })).toThrow(StorageConfigError);
  });

  it('normaliza barras sobrando no rootFolder', async () => {
    const h = createHarness({ rootFolder: '/DMDoc/acervo/' });
    h.enqueue(tokenResponse(), new Response(null, { status: 204 }));

    await h.driver.delete('tenants/t1/a.pdf');

    expect(h.calls[1]?.url).toBe(
      'https://graph.microsoft.com/v1.0/drives/drive-1/root:/DMDoc/acervo/tenants/t1/a.pdf'
    );
  });

  it('expõe o provider correto', () => {
    const h = createHarness();
    expect(h.driver.provider).toBe('sharepoint');
  });
});
