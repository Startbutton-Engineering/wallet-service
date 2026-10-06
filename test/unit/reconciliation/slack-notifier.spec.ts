import { SlackNotifier } from '../../../src/reconciliation/alerts/slack-notifier';
import { LedgerAlert } from '../../../src/reconciliation/alerts/ledger-alert';
import { AppConfig, loadConfig } from '../../../src/config';

const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/ledger-integrity';

function notifierWith(env: Record<string, string>): SlackNotifier {
  return new SlackNotifier(loadConfig(env as NodeJS.ProcessEnv) as AppConfig);
}

const enabled = { ENABLE_SLACK_NOTIFICATIONS: 'true', SLACK_LEDGER_INTEGRITY_WEBHOOK_URL: WEBHOOK };

const mismatch = (kind: LedgerAlert['kind']): LedgerAlert => ({
  kind,
  key: 'recon:mismatch:acme:6ac3c8c51ab36ca74d28442c',
  title: 'Ledger balance mismatch',
  fields: { Tenant: 'acme', Difference: '1' },
});

describe('SlackNotifier', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  function sentBody(): { text: string; attachments: { color: string; blocks: Record<string, unknown>[] }[] } {
    const [, init] = fetchMock.mock.calls[0];
    return JSON.parse(init.body);
  }

  it('pages the dedicated channel with an @channel mention, in red', async () => {
    await notifierWith(enabled).send(mismatch('page'));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(WEBHOOK);
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } });
    const body = sentBody();
    expect(body.text).toBe('<!channel> 🚨 Ledger balance mismatch');
    expect(body.attachments[0].color).toBe('#e74c3c');
    expect(body.attachments[0].blocks).toEqual([
      { type: 'header', text: { type: 'plain_text', text: '🚨 Ledger balance mismatch', emoji: true } },
      { type: 'divider' },
      { type: 'section', fields: [{ type: 'mrkdwn', text: '*Tenant*\nacme' }, { type: 'mrkdwn', text: '*Difference*\n1' }] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Alert key: `recon:mismatch:acme:6ac3c8c51ab36ca74d28442c`' }] },
    ]);
  });

  it('repeats the mention on a reminder, in amber', async () => {
    await notifierWith(enabled).send(mismatch('reminder'));

    expect(sentBody().text).toBe('<!channel> ⏰ Still open: Ledger balance mismatch');
    expect(sentBody().attachments[0].color).toBe('#f39c12');
  });

  it('announces a resolution without paging anyone, in green', async () => {
    await notifierWith(enabled).send(mismatch('resolved'));

    expect(sentBody().text).toBe('✅ Resolved: Ledger balance mismatch');
    expect(sentBody().attachments[0].color).toBe('#2EB67D');
  });

  it('sends nothing while Slack notifications are disabled', async () => {
    await notifierWith({ SLACK_LEDGER_INTEGRITY_WEBHOOK_URL: WEBHOOK }).send(mismatch('page'));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when Slack rejects the alert, so it is retried rather than lost', async () => {
    fetchMock.mockResolvedValue(new Response('invalid_token', { status: 403 }));

    await expect(notifierWith(enabled).send(mismatch('page'))).rejects.toThrow('Slack webhook responded 403: invalid_token');
  });

  it('throws when Slack cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(notifierWith(enabled).send(mismatch('page'))).rejects.toThrow('fetch failed');
  });

  it('throws when enabled without a webhook URL, instead of silently paging nobody', async () => {
    await expect(notifierWith({ ENABLE_SLACK_NOTIFICATIONS: 'true' }).send(mismatch('page'))).rejects.toThrow(
      'SLACK_LEDGER_INTEGRITY_WEBHOOK_URL is not set',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
