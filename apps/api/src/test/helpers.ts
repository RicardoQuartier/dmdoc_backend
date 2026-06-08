import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Db } from 'mongodb';
import { MongoDbClient } from '@dmdoc/db-mongo';
import { loadConfig, type Config } from '../config.js';
import { hashPassword } from '../auth/password.js';
import {
  USERS_COLLECTION,
  type UserDocument,
} from '../auth/user-store.js';

/**
 * Config hermética para testes — injeta segredos JWT e Mongo fixos, sem tocar
 * em `process.env` real. O `MONGO_URI`/`MONGO_DB` aqui são placeholders: os
 * testes injetam um `Db` real (memory-server) em `buildApp`, então a conexão
 * via config nunca é usada.
 */
export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MONGO_URI: 'mongodb://placeholder:27017',
    MONGO_DB: 'dmdoc_test',
    JWT_SECRET: 'test-access-secret',
    JWT_REFRESH_SECRET: 'test-refresh-secret',
    JWT_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '7d',
    ...overrides,
  });
}

export interface TestDb {
  mongo: MongoMemoryServer;
  client: MongoDbClient;
  db: Db;
  stop: () => Promise<void>;
}

/**
 * Sobe um MongoDB em memória e retorna o `Db` + um teardown.
 */
export async function startTestDb(): Promise<TestDb> {
  const mongo = await MongoMemoryServer.create();
  const client = await MongoDbClient.connect(mongo.getUri(), 'dmdoc_test');
  return {
    mongo,
    client,
    db: client.getDb(),
    stop: async () => {
      await client.close();
      await mongo.stop();
    },
  };
}

export interface SeedUserInput {
  id: string;
  tenantId: string | null;
  email: string;
  password: string;
  name?: string;
  role?: UserDocument['role'];
  active?: boolean;
}

/**
 * Insere um usuário de teste com hash argon2 REAL (não um placeholder), para
 * exercitar o caminho completo de verify no login.
 */
export async function seedUser(db: Db, input: SeedUserInput): Promise<UserDocument> {
  const doc: UserDocument & { deleted: boolean } = {
    id: input.id,
    tenantId: input.tenantId,
    email: input.email,
    passwordHash: await hashPassword(input.password),
    name: input.name ?? 'Usuário de Teste',
    role: input.role ?? 'TENANT_ADMIN',
    active: input.active ?? true,
    createdAt: new Date(),
    deleted: false,
  };
  await db.collection<UserDocument & { deleted: boolean }>(USERS_COLLECTION).insertOne(doc);
  const { deleted: _deleted, ...rest } = doc;
  return rest;
}
