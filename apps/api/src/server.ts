import { buildApp } from './app.js';
import { getConfig } from './config.js';

/**
 * Entrypoint da API. Constrói a app e dá `listen`.
 * Em caso de falha no boot, loga e encerra com código de erro.
 */
async function main(): Promise<void> {
  const config = getConfig();
  const app = await buildApp({ config });

  try {
    await app.listen({ port: config.APP_PORT, host: '0.0.0.0' });
  } catch (error) {
    app.log.error({ err: error }, 'falha ao iniciar a API');
    process.exit(1);
  }
}

void main();
