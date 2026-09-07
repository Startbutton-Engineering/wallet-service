export interface AppConfig {
  mongoUri: string;
  dbName: string;
  apiKeys: string[];
  occMaxRetries: number;
  httpPort: number;
  serverEnv: 'staging' | 'production' | 'qa';
}
export const CONFIG = Symbol('APP_CONFIG')

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    mongoUri: env.MONGO_PATH || 'mongodb://localhost:27017',
    dbName: env.DB_NAME || 'ledger',
    apiKeys: env.API_KEYS ? env.API_KEYS.split(',') : [],
    occMaxRetries: Number(env. OCC_MAX_RETRIES) || 3,
    httpPort: Number(env.HTTP_PORT ?? '3003'),
    serverEnv: env.SERVER_ENV as 'staging' | 'production' | 'qa' || 'development'
  }
}