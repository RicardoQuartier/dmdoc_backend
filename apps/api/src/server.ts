import { Queue } from 'bullmq';
import { buildApp } from './app.js';
import { getConfig } from './config.js';

/**
 * Entrypoint da API. Constrói a app e dá `listen`.
 * Em caso de falha no boot, loga e encerra com código de erro.
 */
async function main(): Promise<void> {
  const config = getConfig();

  // Fila BullMQ de processamento de documentos (spec §8).
  // O worker consome desta mesma fila via REDIS_URL.
  const queue = new Queue('document-processing', {
    connection: { url: config.REDIS_URL },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    },
  });

  const app = await buildApp({ config, queue });

  // Fecha a fila quando a app for encerrada (graceful shutdown)
  app.addHook('onClose', async () => {
    await queue.close();
  });

  try {
    await app.listen({ port: config.APP_PORT, host: '0.0.0.0' });
  } catch (error) {
    app.log.error({ err: error }, 'falha ao iniciar a API');
    process.exit(1);
  }
}

void main();
