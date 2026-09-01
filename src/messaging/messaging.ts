export interface DiscordChannelDestination {
  kind: "discord-channel";
  guildId: string;
  channelId: string;
}

export interface InboundAttachment {
  index: number;
  path: string;
  mediaType: string;
}

export interface InboundMessage {
  provider: "discord";
  destination: DiscordChannelDestination;
  messageId: string;
  senderId: string;
  occurredAt: string;
  text: string;
  attachments: InboundAttachment[];
}
