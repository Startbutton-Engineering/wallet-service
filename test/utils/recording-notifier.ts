import { LedgerAlert, LedgerAlertNotifier } from "../../src/reconciliation/alerts/ledger-alert";

/** Stands in for Slack at the alert boundary and keeps every alert it was asked to send. */
export class RecordingNotifier implements LedgerAlertNotifier {
  readonly sent: LedgerAlert[] = [];
  private failuresLeft = 0;

  /** Make the next `count` sends throw, as an unreachable Slack webhook would. */
  failNext(count = 1): void {
    this.failuresLeft = count;
  }

  async send(alert: LedgerAlert): Promise<void> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error('Slack unreachable');
    }
    this.sent.push(alert);
  }

  reset(): void {
    this.sent.length = 0;
    this.failuresLeft = 0;
  }
}
