import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { AuthService, RequestUser } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  attachRealtimeTransportDiagnostics,
  realtimeDiagnostic,
} from '../realtime-diagnostics';
import {
  configuredWebOrigin,
  requestOriginMatches,
} from '../security/csrf-origin';
import { realtimeSessionRegistry } from '../auth/realtime-session-registry';

export type EventTaskChangeReason =
  | 'created'
  | 'updated'
  | 'moved'
  | 'reordered'
  | 'archived'
  | 'member-status-updated'
  | 'comment-added'
  | 'comment-archived'
  | 'attachment-added'
  | 'attachment-archived'
  | 'checklist-added'
  | 'checklist-updated'
  | 'checklist-toggled'
  | 'checklist-archived'
  | 'checklist-reordered';

export type EventTaskChangedPayload = {
  eventId: string;
  communityId: string;
  reason: EventTaskChangeReason;
  taskId?: string;
  changedAt: string;
};

type AuthenticatedSocket = Socket & {
  data: {
    user?: RequestUser;
    authentication?: Promise<RequestUser>;
    joinedEventTaskIds?: Set<string>;
  };
};

type EventTaskRoomPayload = {
  eventId?: unknown;
};

@WebSocketGateway({
  namespace: 'event-tasks',
  cors: {
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  },
  allowRequest: (request, callback) =>
    callback(
      null,
      requestOriginMatches(request.headers.origin, configuredWebOrigin()),
    ),
})
export class EventTasksRealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(EventTasksRealtimeGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: AuthenticatedSocket) {
    const sessionCookie = cookieValue(
      client.handshake.headers.cookie,
      this.auth.cookieName,
    );
    attachRealtimeTransportDiagnostics(this.logger, 'event-tasks', client);
    realtimeDiagnostic(
      this.logger,
      'event-tasks',
      client,
      'namespace-authentication-started',
      {
        cookiePresent: Boolean(sessionCookie),
      },
    );
    const authentication = this.auth.userFromCookie(sessionCookie);
    client.data.authentication = authentication;
    try {
      client.data.user = await authentication;
      realtimeSessionRegistry.register(`event-tasks:${client.id}`, {
        userId: client.data.user.id,
        sessionId: client.data.user.sessionId,
        disconnect: () => client.disconnect(true),
      });
      client.data.joinedEventTaskIds = new Set<string>();
      realtimeDiagnostic(
        this.logger,
        'event-tasks',
        client,
        'namespace-authentication-accepted',
      );
    } catch {
      realtimeDiagnostic(
        this.logger,
        'event-tasks',
        client,
        'namespace-authentication-rejected',
        {
          category: 'invalid-session',
        },
      );
      client.emit('event.tasks.error', { code: 'unauthorized' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    realtimeSessionRegistry.unregister(`event-tasks:${client.id}`);
  }

  @SubscribeMessage('event.tasks.join')
  async joinEventTasks(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: EventTaskRoomPayload,
  ) {
    const user = await this.userOrDisconnect(client);
    if (!user) return;
    const eventId = stringValue(payload?.eventId);
    if (!eventId)
      return client.emit('event.tasks.error', { code: 'invalid_payload' });

    const event = await this.prisma.event.findFirst({
      where: { id: eventId, communityId: user.communityId },
      select: { id: true },
    });
    if (!event)
      return client.emit('event.tasks.error', {
        code: 'access_denied',
        eventId,
      });

    await client.join(eventTaskRoom(user.communityId, eventId));
    (client.data.joinedEventTaskIds ??= new Set<string>()).add(eventId);
    client.emit('event.tasks.joined', { eventId });
  }

  @SubscribeMessage('event.tasks.leave')
  async leaveEventTasks(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: EventTaskRoomPayload,
  ) {
    const user = await this.userOrDisconnect(client);
    if (!user) return;
    const eventId = stringValue(payload?.eventId);
    if (!eventId) return;
    client.data.joinedEventTaskIds?.delete(eventId);
    await client.leave(eventTaskRoom(user.communityId, eventId));
  }

  emitTaskChanged(payload: EventTaskChangedPayload) {
    this.server
      .to(eventTaskRoom(payload.communityId, payload.eventId))
      .emit('event.tasks.changed', payload);
  }

  private async userOrDisconnect(client: AuthenticatedSocket) {
    const user = client.data.user;
    if (user) {
      try {
        const refreshed = await this.auth.revalidateUserSession(user);
        client.data.user = refreshed;
        return refreshed;
      } catch {
        client.data.user = undefined;
        client.data.authentication = undefined;
      }
    }
    try {
      const authenticatedUser = await client.data.authentication;
      if (authenticatedUser) {
        client.data.user = authenticatedUser;
        return authenticatedUser;
      }
    } catch {
      // The connection handler owns the authentication error response.
    }
    client.emit('event.tasks.error', { code: 'unauthorized' });
    client.disconnect(true);
    return null;
  }
}

function eventTaskRoom(communityId: string, eventId: string) {
  return `community:${communityId}:event:${eventId}:tasks`;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function cookieValue(header: string | undefined, name: string) {
  if (!header) return undefined;
  const prefix = `${name}=`;
  const cookie = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : undefined;
}
