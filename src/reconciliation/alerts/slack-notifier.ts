import { Inject, Injectable, Logger } from "@nestjs/common";
import { CONFIG } from "../../config";
import type { AppConfig } from "../../config";
import { LedgerAlert, LedgerAlertKind, LedgerAlertNotifier } from "./ledger-alert";

// Same palette as the back-end's SlackNotificationColor, so both services read alike in Slack.
const STYLE: Record<LedgerAlertKind, { color: string; prefix: string; mention: boolean }> = {
  page: { color: '#e74c3c', prefix: '🚨 ', mention: true },
  reminder: { color: '#f39c12', prefix: '⏰ Still open: ', mention: true },
  resolved: { color: '#2EB67D', prefix: '✅ Resolved: ', mention: false },
};

/**
 * Posts ledger integrity alerts to the dedicated Slack channel's incoming webhook. Unlike the
 * back-end's notifier it throws on failure: AlertService keeps the alert pending and retries.
 */
@Injectable()
export class SlackNotifier implements LedgerAlertNotifier {
  private readonly logger = new Logger(SlackNotifier.name);

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async send(alert: LedgerAlert): Promise<void> {
    const { enabled, ledgerIntegrityWebhookUrl } = this.config.slack;
    if (!enabled) {
      this.logger.log(`Slack notifications disabled; not sending ${alert.kind} for ${alert.key}`);
      return;
    }
    if (!ledgerIntegrityWebhookUrl) throw new Error('SLACK_LEDGER_INTEGRITY_WEBHOOK_URL is not set');

    const res = await fetch(ledgerIntegrityWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload(alert)),
    });
    if (!res.ok) throw new Error(`Slack webhook responded ${res.status}: ${await res.text()}`);
  }
}

function payload(alert: LedgerAlert) {
  const style = STYLE[alert.kind];
  const heading = `${style.prefix}${alert.title}`;
  return {
    // The mention must be in the top-level text: mentions inside attachments do not notify.
    text: style.mention ? `<!channel> ${heading}` : heading,
    attachments: [
      {
        color: style.color,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: heading, emoji: true } },
          { type: 'divider' },
          {
            type: 'section',
            fields: Object.entries(alert.fields).map(([name, value]) => ({ type: 'mrkdwn', text: `*${name}*\n${value}` })),
          },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `Alert key: \`${alert.key}\`` }] },
        ],
      },
    ],
  };
}
