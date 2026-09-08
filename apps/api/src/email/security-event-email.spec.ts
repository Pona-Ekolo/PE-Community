import assert from 'node:assert/strict';
import test from 'node:test';
import { EmailService } from './email.service';

test('security event email uses the requested recipient, includes required context, and escapes a passkey name', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const service = securityEmailService('en', 'PASSKEY_ADDED', {
    passkeyName: '<img src=x onerror=alert(1)>',
  });
  (
    service as unknown as {
      queueCampaign: (input: Record<string, unknown>) => Promise<object>;
    }
  ).queueCampaign = async (input) => {
    captured.push(input);
    return { id: 'campaign-1' };
  };

  await service.queueSecurityEventEmail('event-1', 'previous@example.test');

  const campaign = captured[0];
  const recipients = campaign.recipients as Array<{ email: string }>;
  assert.equal(recipients[0].email, 'previous@example.test');
  assert.match(String(campaign.textBody), /Browser: Chrome/);
  assert.match(String(campaign.textBody), /Operating system: Windows/);
  assert.match(String(campaign.textBody), /IP address: 203\.0\.113\.42/);
  assert.match(String(campaign.textBody), /Country: Philippines/);
  assert.doesNotMatch(String(campaign.htmlBody), /<img src=x/);
  assert.doesNotMatch(
    String(campaign.htmlBody),
    /credential|public key|session-1/i,
  );
  await closeEmailQueue(service);
});

test('new sign-in email uses the canonical English shell, escaped context, and text alternative', async () => {
  let campaign: Record<string, unknown> | undefined;
  const service = securityEmailService(
    'en',
    'LOGIN_NEW_SESSION',
    null,
    'Canada',
    { browser: '<img src=x onerror=alert(1)>' },
  );
  (
    service as unknown as {
      queueCampaign: (input: Record<string, unknown>) => Promise<object>;
    }
  ).queueCampaign = async (input) => {
    campaign = input;
    return { id: 'campaign-1' };
  };

  await service.queueSecurityEventEmail('event-1');

  assert.equal(campaign?.subject, 'New sign-in to your account');
  assert.match(String(campaign?.htmlBody), /<!doctype html>/i);
  assert.match(String(campaign?.htmlBody), /class="email-shell"/);
  assert.match(String(campaign?.htmlBody), /class="email-card"/);
  assert.match(String(campaign?.htmlBody), /class="email-footer"/);
  assert.match(String(campaign?.htmlBody), /Account security/);
  assert.match(String(campaign?.htmlBody), /New sign-in to your account/);
  assert.match(String(campaign?.htmlBody), /IP address: 203\.0\.113\.42/);
  assert.match(String(campaign?.htmlBody), /Country: Canada/);
  assert.doesNotMatch(
    String(campaign?.htmlBody),
    /<img src=x|localhost|undefined|null/,
  );
  assert.doesNotMatch(String(campaign?.htmlBody), /class="email-button"/);
  assert.match(String(campaign?.textBody), /New sign-in to your account/);
  assert.match(
    String(campaign?.textBody),
    /Browser: <img src=x onerror=alert\(1\)>/,
  );
  assert.match(String(campaign?.textBody), /This is an automated message/);
  await closeEmailQueue(service);
});

test('new sign-in email uses the canonical French shell and localized security context', async () => {
  let campaign: Record<string, unknown> | undefined;
  const service = securityEmailService(
    'fr',
    'LOGIN_NEW_SESSION',
    null,
    'France',
  );
  (
    service as unknown as {
      queueCampaign: (input: Record<string, unknown>) => Promise<object>;
    }
  ).queueCampaign = async (input) => {
    campaign = input;
    return { id: 'campaign-1' };
  };

  await service.queueSecurityEventEmail('event-1');

  assert.equal(campaign?.subject, 'Nouvelle connexion à votre compte');
  assert.match(String(campaign?.htmlBody), /class="email-shell"/);
  assert.match(String(campaign?.htmlBody), /Sécurité du compte/);
  assert.match(String(campaign?.htmlBody), /Nouvelle connexion à votre compte/);
  assert.match(String(campaign?.htmlBody), /Navigateur: Chrome/);
  assert.match(String(campaign?.htmlBody), /Pays: France/);
  assert.match(String(campaign?.textBody), /Ceci est un message automatique/);
  assert.doesNotMatch(
    String(campaign?.htmlBody),
    /New sign-in to your account|Account security/,
  );
  await closeEmailQueue(service);
});

test('French security email renders equivalent context and Unknown country', async () => {
  let campaign: Record<string, unknown> | undefined;
  const service = securityEmailService(
    'fr',
    'PASSWORD_CHANGED',
    null,
    'Unknown',
  );
  (
    service as unknown as {
      queueCampaign: (input: Record<string, unknown>) => Promise<object>;
    }
  ).queueCampaign = async (input) => {
    campaign = input;
    return { id: 'campaign-1' };
  };

  await service.queueSecurityEventEmail('event-1');

  assert.match(
    String(campaign?.textBody),
    /Navigateur : Chrome|Navigateur: Chrome/,
  );
  assert.match(
    String(campaign?.textBody),
    /Adresse IP : 203\.0\.113\.42|Adresse IP: 203\.0\.113\.42/,
  );
  assert.match(String(campaign?.textBody), /Pays : Unknown|Pays: Unknown/);
  await closeEmailQueue(service);
});

test('failed-attempt email bounds and renders recent source IP and country rows', async () => {
  let campaign: Record<string, unknown> | undefined;
  const sources = Array.from({ length: 8 }, (_, index) => ({
    ipAddress: `198.51.100.${index + 1}`,
    countryName: index % 2 ? 'France' : 'Unknown',
  }));
  const service = securityEmailService('en', 'LOGIN_FAILED_ALERT', {
    attemptCount: 8,
    sources,
  });
  (
    service as unknown as {
      queueCampaign: (input: Record<string, unknown>) => Promise<object>;
    }
  ).queueCampaign = async (input) => {
    campaign = input;
    return { id: 'campaign-1' };
  };

  await service.queueSecurityEventEmail('event-1');

  assert.match(String(campaign?.textBody), /Recent sources:/);
  assert.match(String(campaign?.textBody), /198\.51\.100\.1 — Unknown/);
  assert.doesNotMatch(String(campaign?.textBody), /198\.51\.100\.6/);
  await closeEmailQueue(service);
});

test('an existing event campaign is reused as the idempotency boundary', async () => {
  let eventLookup = false;
  const prisma = {
    emailCampaign: {
      findFirst: async () => ({
        id: 'campaign-existing',
        status: 'QUEUED',
        metadata: { locale: 'en' },
        recipients: [],
      }),
    },
    securityEvent: {
      findUnique: async () => {
        eventLookup = true;
        return null;
      },
    },
  };
  const service = new EmailService(prisma as never);
  const result = await service.queueSecurityEventEmail('event-1');
  assert.equal(result.id, 'campaign-existing');
  assert.equal(eventLookup, false);
  await closeEmailQueue(service);
});

function securityEmailService(
  locale: 'en' | 'fr',
  eventType: string,
  metadata: Record<string, unknown> | null,
  countryName = 'Philippines',
  eventOverrides: Partial<
    Record<'browser' | 'operatingSystem' | 'ipAddress' | 'countryName', string>
  > = {},
) {
  const prisma = {
    emailCampaign: { findFirst: async () => null },
    securityEvent: {
      findUnique: async () => ({
        id: 'event-1',
        communityId: 'community-1',
        userId: 'user-1',
        eventType,
        occurredAt: new Date('2026-08-30T02:42:00.000Z'),
        browser: 'Chrome',
        operatingSystem: 'Windows',
        ipAddress: '203.0.113.42',
        countryName,
        ...eventOverrides,
        metadata,
        user: { id: 'user-1', email: 'current@example.test', name: 'Member' },
        community: {
          name: 'PE Community',
          settings: { defaultLanguage: locale, timezone: 'UTC' },
        },
      }),
    },
  };
  return new EmailService(prisma as never);
}

function closeEmailQueue(service: EmailService) {
  return (
    service as unknown as { queue: { close: () => Promise<void> } }
  ).queue.close();
}
