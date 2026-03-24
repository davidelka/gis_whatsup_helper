export interface LocationData {
    latitude: number;
    longitude: number;
    accuracy?: number;
    name?: string;
    address?: string;
    url?: string;
}

export interface ParsedMessage {
    id: string;
    timestamp: number;
    groupId: string;
    groupName?: string;
    senderId: string;
    senderName?: string;
    messageType: string;
    text?: string;
    location?: LocationData;
    mediaType?: string;
    mediaData?: string; // base64
    mediaFilename?: string;
    caption?: string;
    raw?: any;
    reportId?: string;
    source: 'whatsapp' | 'telegram';
}

export interface MediaInfo {
    data: string;       // base64
    filename: string;
    mimetype: string;
}

/**
 * Platform-agnostic messaging adapter.
 * Each listener (WhatsApp, Telegram) implements this interface.
 */
export interface MessagingAdapter {
    sendTextMessage(chatId: string, text: string): Promise<void>;
    sendFileMessage(chatId: string, data: Buffer, filename: string, mimeType: string): Promise<void>;
    getQuotedMessageMedia(platformMsg: any): Promise<MediaInfo | null>;
}
