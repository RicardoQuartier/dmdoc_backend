/**
 * Prompt de geração de resposta RAG (Retrieval-Augmented Generation).
 *
 * Versão: rag-answer-v1
 *
 * O modelo recebe os trechos recuperados do acervo documental e deve:
 * 1. Responder em português usando SOMENTE as informações dos trechos.
 * 2. Citar explicitamente os documentos que embasaram cada afirmação.
 * 3. Admitir quando não encontrar a informação nos trechos fornecidos.
 *
 * Formato de citação esperado: [doc:UUID, pág:N] ou [doc:UUID] (sem página).
 * O serviço de busca faz o parsing dessas marcações para preencher `citations`.
 *
 * Spec §11.
 */
export const RAG_ANSWER_PROMPT = {
  version: 'rag-answer-v1',

  systemPrompt: `Você é um assistente de gestão documental. Responda perguntas com base EXCLUSIVAMENTE nos trechos de documentos fornecidos pelo usuário.

Regras obrigatórias:
1. Use APENAS as informações presentes nos trechos. Não invente nem complete com conhecimento externo.
2. Cite as fontes usando o formato exato: [doc:UUID, pág:N] após cada afirmação. Se não houver número de página, use apenas [doc:UUID].
3. Se os trechos não contiverem informação suficiente para responder, diga explicitamente: "Não encontrei informações suficientes nos documentos consultados para responder a esta pergunta."
4. Responda em português brasileiro, de forma clara e objetiva.
5. Se múltiplos trechos embasam a mesma afirmação, cite todos.`,

  /**
   * Monta a mensagem do usuário com os trechos recuperados e a query original.
   *
   * @param query  Pergunta original do usuário.
   * @param chunks Trechos recuperados pela busca híbrida.
   */
  buildUserMessage(
    query: string,
    chunks: Array<{
      documentId: string;
      pageNumber: number | null;
      text: string;
      chunkIndex: number;
    }>
  ): string {
    const trechosFormatados = chunks
      .map((c, i) => {
        const pageRef = c.pageNumber !== null ? `, pág:${c.pageNumber}` : '';
        return `[Trecho ${i + 1}] [doc:${c.documentId}${pageRef}]\n${c.text}`;
      })
      .join('\n\n---\n\n');

    return `Trechos de documentos:\n\n${trechosFormatados}\n\n---\n\nPergunta: ${query}`;
  },
} as const;
