/**
 * Contrato de um comando artisan.
 *
 * Cada arquivo em `src/commands/*.ts` exporta uma constante nomeada
 * `command` conforme esta interface (sem default export — convenção DMDoc).
 * O dispatcher (`src/index.ts`) descobre e valida esses arquivos em tempo
 * de execução.
 */
export interface ArtisanCommand {
  /** Nome usado para invocar o comando (ex.: "db:seed"). Deve ser único. */
  name: string;
  /** Descrição curta exibida na listagem de comandos. */
  description: string;
  /** Executa o comando. Recebe os argumentos posicionais repassados após o nome. */
  run(args: string[]): Promise<void>;
}
