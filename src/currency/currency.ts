export type CurrencyType = 'fiat' | 'crypto';

export interface Currency {
  code: string;
  scale: number;
  type: CurrencyType;
}

export const DEFAULT_CURRENCIES: Currency[] = [
  { code: 'USD', scale: 2, type: 'fiat' },
  { code: 'NGN', scale: 2, type: 'fiat' },
  { code: 'GHS', scale: 2, type: 'fiat' },
  { code: 'KES', scale: 2, type: 'fiat' },
  { code: 'ZAR', scale: 2, type: 'fiat' },
  { code: 'TZS', scale: 2, type: 'fiat' },
  { code: 'RWF', scale: 2, type: 'fiat' },
  { code: 'UGX', scale: 2, type: 'fiat' },
  { code: 'XOF', scale: 2, type: 'fiat' },
  { code: 'XAF', scale: 2, type: 'fiat' },
  { code: 'ZMW', scale: 2, type: 'fiat' },
  { code: 'GBP', scale: 2, type: 'fiat' },
  { code: 'USDT', scale: 10, type: 'crypto' },
  { code: 'USDC', scale: 10, type: 'crypto' }
]