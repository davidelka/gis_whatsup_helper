import { Client, Message, MessageMedia } from 'whatsapp-web.js';
import { MessagingAdapter, MediaInfo } from '@gis-bot/shared';

export class WhatsAppAdapter implements MessagingAdapter {
    private client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    async sendTextMessage(chatId: string, text: string): Promise<void> {
        await this.client.sendMessage(chatId, text, { sendSeen: false });
    }

    async sendFileMessage(chatId: string, data: Buffer, filename: string, mimeType: string): Promise<void> {
        const base64Data = data.toString('base64');
        const media = new MessageMedia(mimeType, base64Data, filename);
        await this.client.sendMessage(chatId, media, { sendSeen: false });
    }

    async getQuotedMessageMedia(platformMsg: any): Promise<MediaInfo | null> {
        const msg = platformMsg as Message;

        if (!msg.hasQuotedMsg) {
            return null;
        }

        try {
            const quoted = await msg.getQuotedMessage();
            if (!quoted.hasMedia) {
                return null;
            }

            const media = await quoted.downloadMedia();
            if (!media || !media.data) {
                return null;
            }

            return {
                data: media.data,
                filename: media.filename || 'file',
                mimetype: media.mimetype || 'application/octet-stream',
            };
        } catch {
            return null;
        }
    }
}
