export const LEDGER_ALERT_NOTIFIER = Symbol('LEDGER_ALERT_NOTIFIER');

/** `page` opens an alert, `reminder` repeats a still-open one, `resolved` closes it. */
export type LedgerAlertKind = 'page' | 'reminder' | 'resolved';

export interface LedgerAlert {
  kind: LedgerAlertKind;
  key: string;
  title: string;
  fields: Record<string, string>;
}

/** The paging boundary. Implementations must throw when an alert was not delivered. */
export interface LedgerAlertNotifier {
  send(alert: LedgerAlert): Promise<void>;
}
