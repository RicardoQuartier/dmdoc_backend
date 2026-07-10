import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ArtisanCommand } from './types.js';

/**
 * Comando centralizador do backend DMDoc, inspirado no `php artisan` do
 * Laravel: reúne os scripts standalone do monorepo sob uma interface única.
 *
 * Uso: `pnpm run artisan <comando> [args...]` a partir da raiz do monorepo.
 * Sem argumentos (ou `--help`/`list`), lista os comandos disponíveis.
 *
 * Descoberta de comandos: lê todos os arquivos `src/commands/*.ts`, importa
 * dinamicamente cada um e valida que exportam `command: ArtisanCommand`.
 * Sem lib de CLI externa — parsing manual de `process.argv`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = path.join(__dirname, 'commands');

interface RegistryEntry {
  command: ArtisanCommand;
  file: string;
}

function isArtisanCommand(value: unknown): value is ArtisanCommand {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['name'] === 'string' &&
    candidate['name'].length > 0 &&
    typeof candidate['description'] === 'string' &&
    typeof candidate['run'] === 'function'
  );
}

/**
 * Lê `src/commands/*.ts`, importa cada arquivo dinamicamente e monta o
 * registro `name -> comando`. Falha alto e claro (lança) se um arquivo não
 * exportar `command` no formato esperado, ou se dois arquivos declararem o
 * mesmo `name` — ambos são erros de setup, não devem passar silenciosamente.
 */
async function discoverCommands(): Promise<Map<string, RegistryEntry>> {
  const files = readdirSync(COMMANDS_DIR).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
  );

  const registry = new Map<string, RegistryEntry>();

  for (const file of files) {
    const fullPath = path.join(COMMANDS_DIR, file);
    const mod = (await import(pathToFileURL(fullPath).href)) as Record<string, unknown>;
    const command = mod['command'];

    if (!isArtisanCommand(command)) {
      throw new Error(
        `Comando inválido em commands/${file}: exporte "export const command: ArtisanCommand = { name, description, run }".`,
      );
    }

    const existing = registry.get(command.name);
    if (existing !== undefined) {
      throw new Error(
        `Comando duplicado "${command.name}": definido em commands/${existing.file} e commands/${file}. Renomeie um dos dois.`,
      );
    }

    registry.set(command.name, { command, file });
  }

  return registry;
}

function printCommandList(registry: Map<string, RegistryEntry>): void {
  const commands = [...registry.values()]
    .map((entry) => entry.command)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (commands.length === 0) {
    console.log('Nenhum comando encontrado em src/commands.');
    return;
  }

  const maxNameLength = Math.max(...commands.map((cmd) => cmd.name.length));

  console.log('Comandos disponíveis:\n');
  for (const cmd of commands) {
    console.log(`  ${cmd.name.padEnd(maxNameLength + 2)}${cmd.description}`);
  }
}

/**
 * `pnpm run artisan` delega para `pnpm --filter @dmdoc/artisan start --`,
 * que por sua vez delega para o script `start` (`tsx src/index.ts`). O pnpm
 * repassa o `--` literal em cada nível dessa cadeia de delegação (mesmo sem
 * nenhum argumento extra do usuário), então o primeiro token de
 * `process.argv` acaba sendo sempre um `--` de artefato — não um argumento
 * real. Remove esse token solto antes de interpretar nome do comando/args.
 */
function stripDelegationSeparator(rawArgs: string[]): string[] {
  return rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
}

async function main(): Promise<void> {
  const [commandName, ...args] = stripDelegationSeparator(process.argv.slice(2));
  const registry = await discoverCommands();

  if (commandName === undefined || commandName === '--help' || commandName === 'list') {
    printCommandList(registry);
    return;
  }

  const entry = registry.get(commandName);
  if (entry === undefined) {
    const available = [...registry.keys()].sort((a, b) => a.localeCompare(b)).join(', ');
    console.error(
      `Comando "${commandName}" não encontrado. Comandos disponíveis: ${available || '(nenhum)'}`,
    );
    process.exitCode = 1;
    return;
  }

  try {
    await entry.command.run(args);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Erro ao executar "${commandName}": ${message}`);
    if (process.env['DEBUG'] !== undefined && err instanceof Error && err.stack !== undefined) {
      console.error(err.stack);
    }
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Falha inesperada no artisan: ${message}`);
  process.exitCode = 1;
});
