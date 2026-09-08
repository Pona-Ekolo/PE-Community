import {
  Ack,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { HttpException, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { AuthService, RequestUser } from '../auth/auth.service';
import {
  attachRealtimeTransportDiagnostics,
  realtimeDiagnostic,
} from '../realtime-diagnostics';
import {
  configuredWebOrigin,
  requestOriginMatches,
} from '../security/csrf-origin';
import { ChatService } from './chat.service';
import { realtimeSessionRegistry } from '../auth/realtime-session-registry';

type AuthenticatedSocket = Socket & {
  data: {
    user?: RequestUser;
    authentication?: Promise<RequestUser>;
    joinedConversationIds?: Set<string>;
  };
};

type ConversationPayload = {
  conversationId?: unknown;
};

type SendMessagePayload = ConversationPayload & {
  encryptedPayload?: unknown;
  encryptionNonce?: unknown;
  encryptionAlgorithmVersion?: unknown;
  encryptionKeyVersion?: unknown;
  senderKeyVersionId?: unknown;
  recipientKeyVersionId?: unknown;
};

type SendMessageAck = (response: { message?: unknown; error?: string }) => void;

type SeenPayload = ConversationPayload & {
  messageId?: unknown;
};

type MessageActionPayload = SeenPayload;

type EditMessagePayload = MessageActionPayload & {
  encryptedPayload?: unknown;
  encryptionNonce?: unknown;
  encryptionAlgorithmVersion?: unknown;
  encryptionKeyVersion?: unknown;
  senderKeyVersionId?: unknown;
  recipientKeyVersionId?: unknown;
};

type ReactionPayload = MessageActionPayload & {
  emoji?: unknown;
};

@WebSocketGateway({
  namespace: 'chat',
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
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  private readonly userSockets = new Map<string, Set<string>>();
  private readonly typingTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly auth: AuthService,
    private readonly chat: ChatService,
  ) {}

  async handleConnection(client: AuthenticatedSocket) {
    const sessionCookie = cookieValue(
      client.handshake.headers.cookie,
      this.auth.cookieName,
    );
    attachRealtimeTransportDiagnostics(this.logger, 'chat', client);
    realtimeDiagnostic(
      this.logger,
      'chat',
      client,
      'namespace-authentication-started',
      {
        cookiePresent: Boolean(sessionCookie),
      },
    );
    const authentication = this.auth.userFromCookie(sessionCookie);
    client.data.authentication = authentication;
    try {
      const user = await authentication;
      client.data.user = user;
      realtimeSessionRegistry.register(`chat:${client.id}`, {
        userId: user.id,
        sessionId: user.sessionId,
        disconnect: () => client.disconnect(true),
      });
      client.data.joinedConversationIds = new Set<string>();
      const sockets = this.userSockets.get(user.id) ?? new Set<string>();
      sockets.add(client.id);
      this.userSockets.set(user.id, sockets);
      realtimeDiagnostic(
        this.logger,
        'chat',
        client,
        'namespace-authentication-accepted',
      );
    } catch {
      realtimeDiagnostic(
        this.logger,
        'chat',
        client,
        'namespace-authentication-rejected',
        {
          category: 'invalid-session',
        },
      );
      client.emit('chat:error', {
        code: 'unauthorized',
        message: 'Authentication required.',
      });
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: AuthenticatedSocket) {
    realtimeSessionRegistry.unregister(`chat:${client.id}`);
    const user = client.data.user;
    if (!user) return;
    let lastSeenAt: Date | null = null;
    const sockets = this.userSockets.get(user.id);
    if (sockets) {
      sockets.delete(client.id);
      if (sockets.size === 0) {
        this.userSockets.delete(user.id);
        lastSeenAt = new Date();
        try {
          await this.chat.markPresenceSeen(user, lastSeenAt);
        } catch {
          // Realtime offline propagation should still happen if last-seen persistence has a transient failure.
        }
      }
    }
    for (const conversationId of client.data.joinedConversationIds ?? []) {
      this.clearTyping(client.id, conversationId);
      if (!this.userSockets.has(user.id)) {
        this.server
          .to(conversationRoom(conversationId))
          .emit('presence:update', {
            conversationId,
            userId: user.id,
            isOnline: false,
            lastSeenAt: (lastSeenAt ?? new Date()).toISOString(),
          });
      }
    }
  }

  @SubscribeMessage('chat:conversation:join')
  async joinConversation(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: ConversationPayload,
  ) {
    const user = await this.userOrDisconnect(client);
    if (!user) return;
    const conversationId = stringValue(payload?.conversationId);
    if (!conversationId)
      return this.safeError(
        client,
        'invalid_payload',
        'Conversation is required.',
      );
    try {
      await this.chat.ensureParticipant(user, conversationId);
      await client.join(conversationRoom(conversationId));
      client.data.joinedConversationIds?.add(conversationId);
      const participantPresence = await this.chat.conversationPresenceSnapshot(
        user,
        conversationId,
      );
      participantPresence
        .filter((presence) => presence.userId !== user.id)
        .forEach((presence) => {
          const isOnline = this.userSockets.has(presence.userId);
          client.emit('presence:update', {
            conversationId,
            userId: presence.userId,
            isOnline,
            lastSeenAt: isOnline
              ? null
              : (presence.lastSeenAt?.toISOString() ?? null),
          });
        });
      client.emit('chat:conversation:joined', { conversationId });
      client.to(conversationRoom(conversationId)).emit('presence:update', {
        conversationId,
        userId: user.id,
        isOnline: true,
        lastSeenAt: null,
      });
    } catch {
      this.safeError(
        client,
        'access_denied',
        'Conversation access denied.',
        conversationId,
      );
    }
  }

  @SubscribeMessage('chat:conversation:leave')
  async leaveConversation(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: ConversationPayload,
  ) {
    const user = await this.userOrDisconnect(client);
    if (!user) return;
    const conversationId = stringValue(payload?.conversationId);
    if (!conversationId) return;
    this.clearTyping(client.id, conversationId);
    client.data.joinedConversationIds?.delete(conversationId);
    await client.leave(conversationRoom(conversationId));
    client.to(conversationRoom(conversationId)).emit('chat:typing:update', {
      conversationId,
      userId: user.id,
      isTyping: false,
    });
  }

  @SubscribeMessage('chat:message:send')
  async sendMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: SendMessagePayload,
    @Ack() ack?: SendMessageAck,
  ) {
    const user = await this.userOrDisconnect(client);
    if (!user) {
      ack?.({ error: 'unauthorized' });
      return;
    }
    const conversationId = stringValue(payload?.conversationId);
    if (!conversationId) {
      this.safeError(client, 'invalid_payload', 'Conversation is required.');
      ack?.({ error: 'invalid_payload' });
      return;
    }
    if (!client.data.joinedConversationIds?.has(conversationId)) {
      this.safeError(
        client,
        'conversation_not_joined',
        'Conversation is not connected.',
        conversationId,
      );
      ack?.({ error: 'conversation_not_joined' });
      return;
    }
    try {
      const { message } = await this.chat.createMessage(user, conversationId, {
        encryptedPayload: payload.encryptedPayload,
        encryptionNonce: payload.encryptionNonce,
        encryptionAlgorithmVersion: payload.encryptionAlgorithmVersion,
        encryptionKeyVersion: payload.encryptionKeyVersion,
        senderKeyVersionId: payload.senderKeyVersionId,
        recipientKeyVersionId: payload.recipientKeyVersionId,
      });
      this.server
        .to(conversationRoom(conversationId))
        .emit('chat:message:new', message);
      ack?.({ message });
    } catch (error) {
      const code = safeMessageSendErrorCode(error);
      this.safeError(
        client,
        'message_rejected',
        'Encrypted message could not be sent.',
      );
      ack?.({ error: code });
    }
  }

  @SubscribeMessage('chat:typing:start')
  async typingStart(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: ConversationPayload,
  ) {
    const user = await this.userOrDisconnect(client);
    if (!user) return;
    const conversationId = stringValue(payload?.conversationId);
    if (!conversationId) return;
    if (!client.data.joinedConversationIds?.has(conversationId)) {
      return this.safeError(
        client,
        'conversation_not_joined',
        'Conversation is not connected.',
        conversationId,
      );
    }
    try {
      await this.chat.ensureParticipant(user, conversationId);
      client.to(conversationRoom(conversationId)).emit('chat:typing:update', {
        conversationId,
        userId: user.id,
        isTyping: true,
      });
      this.scheduleTypingStop(client, conversationId);
    } catch {
      this.safeError(
        client,
        'access_denied',
        'Conversation access denied.',
        conversationId,
      );
    }
  }

  @SubscribeMessage('chat:typing:stop')
  async typingStop(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: ConversationPayload,
  ) {
    const user = await this.userOrDisconnect(client);
    if (!user) return;
    const conversationId = stringValue(payload?.conversationId);
    if (!conversationId) return;
    if (!client.data.joinedConversationIds?.has(conversationId)) return;
    try {
      await this.chat.ensureParticipant(user, conversationId);
      this.clearTyping(client.id, conversationId);
      client.to(conversationRoom(conversationId)).emit('chat:typing:update', {
        conversationId,
        userId: user.id,
        isTyping: false,
      });
    } catch {
      this.safeError(client, 'access_denied', 'Conversation access denied.');
    }
  }

  @SubscribeMessage('chat:message:seen')
  async messageSeen(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: SeenPayload,
  ) {
    const user = await this.userOrDisconnect(client);
    if (!user) return;
    const conversationId = stringValue(payload?.conversationId);
    if (!conversationId)
      return this.safeError(
        client,
        'invalid_payload',
        'Conversation is required.',
      );
    if (!client.data.joinedConversationIds?.has(conversationId)) {
      return this.safeError(
        client,
        'conversation_not_joined',
        'Conversation is not connected.',
        conversationId,
      );
    }
    try {
      const seen = await this.chat.markSeen(user, conversationId);
      this.server
        .to(conversationRoom(conversationId))
        .emit('chat:message:seen', {
          ...seen,
          messageId: stringValue(payload.messageId) || null,
        });
    } catch {
      this.safeError(client, 'access_denied', 'Conversation access denied.');
    }
  }

  @SubscribeMessage('chat:message:delivered')
  async messageDelivered(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: SeenPayload,
  ) {
    const user = await this.userOrDisconnect(client);
    if (!user) return;
    const conversationId = stringValue(payload?.conversationId);
    const messageId = stringValue(payload?.messageId);
    if (!conversationId || !messageId)
      return this.safeError(
        client,
        'invalid_payload',
        'Conversation and message are required.',
      );
    if (!client.data.joinedConversationIds?.has(conversationId)) {
      return this.safeError(
        client,
        'conversation_not_joined',
        'Conversation is not connected.',
        conversationId,
      );
    }
    try {
      const delivered = await this.chat.markDelivered(
        user,
        conversationId,
        messageId,
      );
      this.server
        .to(conversationRoom(conversationId))
        .emit('chat:message:delivered', delivered);
    } catch {
      this.safeError(client, 'access_denied', 'Conversation access denied.');
    }
  }

  @SubscribeMessage('chat:message:delete-for-everyone')
  async deleteMessageForEveryone(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: MessageActionPayload,
  ) {
    const user = await this.userOrDisconnect(client);
    if (!user) return;
    const conversationId = stringValue(payload?.conversationId);
    const messageId = stringValue(payload?.messageId);
    if (!conversationId || !messageId)
      return this.safeError(
        client,
        'invalid_payload',
        'Conversation and message are required.',
      );
    if (!client.data.joinedConversationIds?.has(conversationId)) {
      return this.safeError(
        client,
        'conversation_not_joined',
        'Conversation is not connected.',
        conversationId,
      );
    }
    try {
      const { message } = await this.chat.deleteMessageForEveryone(
        user,
        conversationId,
        messageId,
      );
      this.server
        .to(conversationRoom(conversationId))
        .emit('chat:message:deleted', message);
    } catch {
      this.safeError(
        client,
        'message_delete_rejected',
        'Message could not be deleted.',
      );
    }
  }

  @SubscribeMessage('chat:message:edit')
  async editMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: EditMessagePayload,
    @Ack() ack?: (response: { message?: unknown; error?: string }) => void,
  ) {
    const user = await this.userOrDisconnect(client);
    if (!user) return;
    const conversationId = stringValue(payload?.conversationId);
    const messageId = stringValue(payload?.messageId);
    if (!conversationId || !messageId) {
      ack?.({ error: 'invalid_payload' });
      return this.safeError(
        client,
        'invalid_payload',
        'Conversation and message are required.',
      );
    }
    if (!client.data.joinedConversationIds?.has(conversationId)) {
      ack?.({ error: 'conversation_not_joined' });
      return this.safeError(
        client,
        'conversation_not_joined',
        'Conversation is not connected.',
        conversationId,
      );
    }
    try {
      const { message } = await this.chat.editMessage(
        user,
        conversationId,
        messageId,
        {
          encryptedPayload: payload.encryptedPayload,
          encryptionNonce: payload.encryptionNonce,
          encryptionAlgorithmVersion: payload.encryptionAlgorithmVersion,
          encryptionKeyVersion: payload.encryptionKeyVersion,
          senderKeyVersionId: payload.senderKeyVersionId,
          recipientKeyVersionId: payload.recipientKeyVersionId,
        },
      );
      this.server
        .to(conversationRoom(conversationId))
        .emit('chat:message:edited', message);
      ack?.({ message });
    } catch {
      ack?.({ error: 'message_edit_rejected' });
      this.safeError(
        client,
        'message_edit_rejected',
        'Message could not be edited.',
      );
    }
  }

  @SubscribeMessage('chat:message:reaction')
  async setMessageReaction(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() payload: ReactionPayload,
    @Ack() ack?: (response: { reaction?: unknown; error?: string }) => void,
  ) {
    const user = await this.userOrDisconnect(client);
    if (!user) return;
    const conversationId = stringValue(payload?.conversationId);
    const messageId = stringValue(payload?.messageId);
    if (!conversationId || !messageId) {
      ack?.({ error: 'invalid_payload' });
      return this.safeError(
        client,
        'invalid_payload',
        'Conversation and message are required.',
      );
    }
    if (!client.data.joinedConversationIds?.has(conversationId)) {
      ack?.({ error: 'conversation_not_joined' });
      return this.safeError(
        client,
        'conversation_not_joined',
        'Conversation is not connected.',
        conversationId,
      );
    }
    try {
      const reaction = await this.chat.setMessageReaction(
        user,
        conversationId,
        messageId,
        { emoji: payload.emoji },
      );
      this.server
        .to(conversationRoom(conversationId))
        .emit('chat:message:reaction', reaction);
      ack?.({ reaction });
    } catch {
      ack?.({ error: 'message_reaction_rejected' });
      this.safeError(
        client,
        'message_reaction_rejected',
        'Reaction could not be saved.',
      );
    }
  }

  private scheduleTypingStop(
    client: AuthenticatedSocket,
    conversationId: string,
  ) {
    this.clearTyping(client.id, conversationId);
    const key = typingKey(client.id, conversationId);
    this.typingTimers.set(
      key,
      setTimeout(() => {
        const user = client.data.user;
        if (!user) return;
        this.typingTimers.delete(key);
        client.to(conversationRoom(conversationId)).emit('chat:typing:update', {
          conversationId,
          userId: user.id,
          isTyping: false,
        });
      }, 5000),
    );
  }

  private clearTyping(socketId: string, conversationId: string) {
    const key = typingKey(socketId, conversationId);
    const timer = this.typingTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.typingTimers.delete(key);
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
      // The connection handler owns the authentication rejection response.
    }
    realtimeDiagnostic(
      this.logger,
      'chat',
      client,
      'server-disconnect-requested',
      {
        category: 'authentication-rejected',
      },
    );
    this.safeError(client, 'unauthorized', 'Authentication required.');
    client.disconnect(true);
    return null;
  }

  private safeError(
    client: Socket,
    code: string,
    message: string,
    conversationId?: string,
  ) {
    client.emit('chat:error', { code, message, conversationId });
  }
}

function conversationRoom(conversationId: string) {
  return `chat:conversation:${conversationId}`;
}

function typingKey(socketId: string, conversationId: string) {
  return `${socketId}:${conversationId}`;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeMessageSendErrorCode(error: unknown) {
  if (!(error instanceof HttpException)) return 'message_rejected';
  const response = error.getResponse();
  const message =
    typeof response === 'string'
      ? response
      : response && typeof response === 'object' && 'message' in response
        ? (response as { message?: unknown }).message
        : undefined;
  const code = Array.isArray(message) ? message[0] : message;
  return typeof code === 'string' && /^CHAT_[A-Z0-9_]+$/.test(code)
    ? code
    : 'message_rejected';
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
