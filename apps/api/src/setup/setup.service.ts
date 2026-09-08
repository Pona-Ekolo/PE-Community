import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { MembershipStatus, Prisma } from '@prisma/client';
import { randomUUID, timingSafeEqual } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  ALL_PERMISSIONS,
  ADMIN_PERMISSIONS,
  MEMBER_PERMISSIONS,
} from '../rbac/permissions';
import { ensureCommunityMessageTemplates } from '../message-templates';
import { ensureAutomationNotificationTemplates } from '../notification-templates';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from '../security/password.service';
import {
  avatarPublicUrl,
  avatarUploadDir,
  avatarUploadExtension,
  hasValidAvatarSignature,
  maxAvatarUploadSize,
  type AvatarUploadFile,
} from '../uploads';
import { SetupRequestDto } from './setup.dto';

const firstRunCommunityId = 'seed-community';
const firstRunOrganizationId = 'default-organization';
const languageOptions = ['en', 'fr'] as const;
const fallbackTimezones = [
  'UTC',
  'Africa/Kinshasa',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Europe/Paris',
  'Europe/London',
  'America/New_York',
  'America/Toronto',
];

@Injectable()
export class SetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  async status() {
    const [communityCount, privilegedMembershipCount, settings] =
      await Promise.all([
        this.prisma.community.count(),
        this.prisma.membership.count({
          where: {
            status: MembershipStatus.ACTIVE,
            role: { key: { in: ['owner', 'admin'] } },
          },
        }),
        this.prisma.communitySettings.findFirst({
          select: { defaultLanguage: true, timezone: true },
          orderBy: { communityId: 'asc' },
        }),
      ]);
    const initialized = communityCount > 0 && privilegedMembershipCount > 0;
    return {
      initialized,
      setupRequired: communityCount === 0 && privilegedMembershipCount === 0,
      defaultLanguage: settings?.defaultLanguage === 'fr' ? 'fr' : 'en',
      timezone: settings?.timezone ?? 'UTC',
    };
  }

  async initialize(input: SetupRequestDto, ownerAvatar?: AvatarUploadFile) {
    this.assertSetupToken(input.setupToken);
    const data = setupInput(input);
    const generatedAvatar = generatedOwnerAvatar(input);
    const ownerAvatarExtension = ownerAvatar
      ? validatedOwnerAvatarExtension(ownerAvatar)
      : null;
    const current = await this.status();
    if (current.initialized || !current.setupRequired)
      throw new ConflictException('Setup has already been completed.');

    let ownerAvatarPath: string | null = null;
    try {
      await this.prisma.$transaction(async (tx) => {
        const [communityCount, privilegedMembershipCount] = await Promise.all([
          tx.community.count(),
          tx.membership.count({
            where: {
              status: MembershipStatus.ACTIVE,
              role: { key: { in: ['owner', 'admin'] } },
            },
          }),
        ]);
        if (communityCount > 0 || privilegedMembershipCount > 0)
          throw new ConflictException('Setup has already been completed.');
        const existingOwnerEmail = await tx.user.findUnique({
          where: { email: data.ownerEmail },
          select: { id: true },
        });
        if (existingOwnerEmail)
          throw new ConflictException('Owner email is already in use.');

        for (const key of ALL_PERMISSIONS) {
          await tx.permission.upsert({
            where: { key },
            update: { label: permissionLabel(key) },
            create: { key, label: permissionLabel(key) },
          });
        }

        const organization = await tx.organization.upsert({
          where: { id: firstRunOrganizationId },
          update: { name: data.communityName },
          create: { id: firstRunOrganizationId, name: data.communityName },
        });
        const community = await tx.community.create({
          data: {
            id: firstRunCommunityId,
            name: data.communityName,
            slug: data.communitySlug,
            organizationId: organization.id,
          },
        });
        const [ownerRole, adminRole, memberRole] = await Promise.all([
          tx.role.create({
            data: { communityId: community.id, key: 'owner', name: 'Owner' },
          }),
          tx.role.create({
            data: { communityId: community.id, key: 'admin', name: 'Admin' },
          }),
          tx.role.create({
            data: { communityId: community.id, key: 'member', name: 'Member' },
          }),
        ]);
        const permissions = await tx.permission.findMany({
          where: { key: { in: ALL_PERMISSIONS } },
        });
        const permissionsByKey = new Map(
          permissions.map((permission) => [permission.key, permission.id]),
        );
        await tx.rolePermission.createMany({
          data: [
            ...ALL_PERMISSIONS.map((key) => ({
              roleId: ownerRole.id,
              permissionId: permissionsByKey.get(key)!,
            })),
            ...ADMIN_PERMISSIONS.map((key) => ({
              roleId: adminRole.id,
              permissionId: permissionsByKey.get(key)!,
            })),
            ...MEMBER_PERMISSIONS.map((key) => ({
              roleId: memberRole.id,
              permissionId: permissionsByKey.get(key)!,
            })),
          ],
        });

        const passwordHash = await this.passwords.hash(data.ownerPassword);
        const owner = await tx.user.create({
          data: {
            email: data.ownerEmail,
            name: data.ownerFullName,
            passwordHash,
            passwordChangedAt: new Date(),
            emailVerifiedAt: new Date(),
          },
        });
        const membership = await tx.membership.create({
          data: {
            userId: owner.id,
            communityId: community.id,
            roleId: ownerRole.id,
            status: MembershipStatus.ACTIVE,
          },
        });
        await tx.communitySettings.create({
          data: {
            communityId: community.id,
            defaultLanguage: data.defaultLanguage,
            timezone: data.timezone,
            registrationApprovalMode: 'portal_registration',
            memberDirectoryVisibility: 'members_only',
            supportContactEmail: data.ownerEmail,
            twoFactorEnabled: false,
            adminInAppAlertsEnabled: true,
            emailDeliveryIssueAlertsEnabled: true,
            registrationReviewAlertsEnabled: true,
            passportExpirationAdminAlertsEnabled: true,
            reminderRunSummaryAlertsEnabled: false,
          },
        });
        await tx.communityReminderSettings.create({
          data: { communityId: community.id },
        });
        await tx.communityEmailSettings.create({
          data: { communityId: community.id },
        });
        await tx.notificationPreference.create({
          data: {
            userId: owner.id,
            communityId: community.id,
            announcementNotifications: true,
            eventNotifications: true,
            birthdayReminderNotifications: true,
            passportExpirationRemindersEnabled: true,
          },
        });
        await ensureCommunityMessageTemplates(tx, community.id, community.name);
        await ensureAutomationNotificationTemplates(tx, community.id);
        await tx.auditLog.create({
          data: {
            communityId: community.id,
            actorUserId: owner.id,
            action: 'installation.initialized',
            targetType: 'Community',
            targetId: community.id,
            metadata: {
              defaultLanguage: data.defaultLanguage,
              timezone: data.timezone,
            },
          },
        });
        let avatarUrl: string | undefined;
        if (ownerAvatar && ownerAvatarExtension) {
          const uploadDir = avatarUploadDir();
          const filename = `${membership.id}-${randomUUID()}${ownerAvatarExtension}`;
          ownerAvatarPath = join(uploadDir, filename);
          await mkdir(uploadDir, { recursive: true });
          await writeFile(ownerAvatarPath, ownerAvatar.buffer);
          avatarUrl = avatarPublicUrl(filename);
        }
        await tx.memberProfile.create({
          data: {
            membershipId: membership.id,
            title: 'Owner',
            avatarUrl,
            dicebearStyle: avatarUrl
              ? undefined
              : generatedAvatar?.dicebearStyle,
            dicebearSeed: avatarUrl ? undefined : generatedAvatar?.dicebearSeed,
            socialLinks: {},
          },
        });
      });
    } catch (error) {
      if (ownerAvatarPath) await unlink(ownerAvatarPath).catch(() => undefined);
      if (error instanceof ConflictException) throw error;
      if (isUniqueConstraintError(error))
        throw new ConflictException('Setup has already been completed.');
      throw error;
    }

    return { ok: true };
  }

  private assertSetupToken(token?: string) {
    assertSetupToken(token);
  }
}

export function assertSetupToken(
  token?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const expected = environment.SETUP_TOKEN?.trim();
  if (!expected) {
    if (environment.NODE_ENV === 'production') {
      throw new ForbiddenException(
        'SETUP_TOKEN must be configured before first-run setup.',
      );
    }
    return;
  }
  if (!token || !safeTokenMatches(token, expected))
    throw new ForbiddenException('Setup token is required.');
}

function safeTokenMatches(supplied: string, expected: string) {
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}

function setupInput(input: SetupRequestDto) {
  const communityName = stringValue(input.communityName);
  const communitySlug = slugValue(input.communitySlug);
  const ownerFullName = stringValue(input.ownerFullName);
  const ownerEmail = emailValue(input.ownerEmail);
  const ownerPassword = stringValue(input.ownerPassword);
  const defaultLanguage = languageValue(input.defaultLanguage);
  const timezone = timezoneValue(input.timezone);
  if (!communityName)
    throw new BadRequestException('Community name is required.');
  if (!ownerFullName)
    throw new BadRequestException('Owner full name is required.');
  if (!ownerPassword || ownerPassword.length < 8)
    throw new BadRequestException('Password must be at least 8 characters.');
  return {
    communityName,
    communitySlug,
    ownerFullName,
    ownerEmail,
    ownerPassword,
    defaultLanguage,
    timezone,
  };
}

function generatedOwnerAvatar(input: SetupRequestDto) {
  const style = stringValue(input.ownerAvatarStyle);
  const seed = stringValue(input.ownerAvatarSeed);
  if (!style && !seed) return null;
  if (!['lorelei-neutral', 'notionists', 'personas'].includes(style) || !seed) {
    throw new BadRequestException('Invalid generated Owner avatar.');
  }
  return { dicebearStyle: style, dicebearSeed: seed.slice(0, 128) };
}

function validatedOwnerAvatarExtension(file: AvatarUploadFile) {
  const extension = avatarUploadExtension(file);
  if (!extension)
    throw new BadRequestException('Owner avatar must be JPEG, PNG, or WebP.');
  if (file.size > maxAvatarUploadSize)
    throw new BadRequestException('Owner avatar must be 5MB or smaller.');
  if (!hasValidAvatarSignature(file))
    throw new BadRequestException('Owner avatar image is invalid.');
  return extension;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function slugValue(value: unknown) {
  const normalized = stringValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(normalized))
    throw new BadRequestException('Invalid community slug.');
  return normalized;
}

function emailValue(value: unknown) {
  const email = stringValue(value).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new BadRequestException('Invalid email address.');
  return email;
}

function languageValue(value: unknown) {
  const language = stringValue(value);
  if (!languageOptions.includes(language as (typeof languageOptions)[number]))
    throw new BadRequestException('Unsupported default language.');
  return language;
}

function timezoneValue(value: unknown) {
  const timezone = stringValue(value);
  const supportedValuesOf = (
    Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }
  ).supportedValuesOf;
  const allowed = new Set([
    'UTC',
    ...(supportedValuesOf ? supportedValuesOf('timeZone') : fallbackTimezones),
  ]);
  if (!allowed.has(timezone))
    throw new BadRequestException('Unsupported timezone.');
  return timezone;
}

function permissionLabel(key: string) {
  return key
    .split('.')
    .map((part) => part.replace(/([A-Z])/g, ' $1'))
    .join(' ');
}

function isUniqueConstraintError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
