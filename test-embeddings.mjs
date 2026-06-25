import OpenAI from 'openai';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) { console.error('OPENAI_API_KEY não definida'); process.exit(1); }

async function testEmbeddings(label, clientOptions) {
  const openai = new OpenAI({ apiKey, ...clientOptions });
  const start = Date.now();
  try {
    const result = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: ['teste de conexao simples', 'segundo texto para verificar batch'],
    });
    console.log(`[${label}] OK — ${result.data.length} embeddings em ${Date.now() - start}ms, dim=${result.data[0].embedding.length}`);
    return true;
  } catch (err) {
    console.error(`[${label}] ERRO após ${Date.now() - start}ms: ${err.message} (${err.code ?? err.constructor.name})`);
    return false;
  }
}

console.log('--- Teste 1: sem Accept-Encoding (padrão) ---');
await testEmbeddings('padrão', {});

console.log('--- Teste 2: Accept-Encoding: identity (sem gzip) ---');
await testEmbeddings('identity', { defaultHeaders: { 'Accept-Encoding': 'identity' } });
