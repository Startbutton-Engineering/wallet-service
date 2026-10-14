export interface AppConfig {
  mongoUri: string;
  dbName: string;
  defaultTenantId: string
  apiKeys: string[];
  occMaxRetries: number;
  httpPort: number;
  serverEnv: 'staging' | 'production' | 'qa';
  reconciliation: {
    /** Run the daily reconciliation scheduler in this process. */
    enabled: boolean;
    /** Local time of the daily run, HH:mm in `timeZone`. */
    runAt: string;
    timeZone: string;
    pollIntervalMs: number;
  };
  slack: {
    enabled: boolean;
    ledgerIntegrityWebhookUrl: string;
  };
}
export const CONFIG = Symbol('APP_CONFIG')

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    mongoUri: env.MONGO_PATH || 'mongodb://localhost:27017',
    dbName: env.DB_NAME || 'ledger',
    defaultTenantId: env.DEFAULT_TENANT_ID ?? '',
    apiKeys: env.API_KEYS ? env.API_KEYS.split(',') : [],
    occMaxRetries: Number(env. OCC_MAX_RETRIES) || 3,
    httpPort: Number(env.HTTP_PORT ?? '3003'),
    serverEnv: env.SERVER_ENV as 'staging' | 'production' | 'qa' || 'development',
    reconciliation: {
      enabled: env.RECONCILIATION_ENABLED === 'true',
      runAt: env.RECONCILIATION_RUN_AT || '02:00',
      timeZone: env.RECONCILIATION_TIMEZONE || 'Africa/Lagos',
      pollIntervalMs: Number(env.RECONCILIATION_POLL_INTERVAL_MS) || 5 * 60 * 1000,
    },
    slack: {
      enabled: env.ENABLE_SLACK_NOTIFICATIONS === 'true',
      ledgerIntegrityWebhookUrl: env.SLACK_LEDGER_INTEGRITY_WEBHOOK_URL ?? '',
    },
  }
}