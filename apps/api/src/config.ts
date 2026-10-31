import { z } from 'zod';

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  DATABASE_PATH: z.string().min(1).default('./data/nomad.sqlite'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
});

export type AppConfig = {
  port: number;
  databasePath: string;
  webOrigin: string;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);

  return {
    port: parsed.PORT,
    databasePath: parsed.DATABASE_PATH,
    webOrigin: parsed.WEB_ORIGIN,
  };
}

