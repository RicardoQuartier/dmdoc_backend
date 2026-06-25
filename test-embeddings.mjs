import OpenAI from 'openai';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) { console.error('OPENAI_API_KEY não definida'); process.exit(1); }

const openai = new OpenAI({ apiKey });

const texts = [
  'teste de conexao simples',
  'segundo texto para verificar batch',
];

console.log(`Testando embeddings com ${texts.length} textos via SDK OpenAI...`);
const start = Date.now();

try {
  const result = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });

  const elapsed = Date.now() - start;
  console.log(`OK — ${result.data.length} embeddings em ${elapsed}ms`);
  console.log(`Dimensões: ${result.data[0].embedding.length}`);
  console.log(`Tokens usados: ${result.usage.total_tokens}`);
} catch (err) {
  const elapsed = Date.now() - start;
  console.error(`ERRO após ${elapsed}ms:`, err.message);
  console.error('Tipo:', err.constructor.name);
  if (err.code) console.error('Code:', err.code);
  process.exit(1);
}
