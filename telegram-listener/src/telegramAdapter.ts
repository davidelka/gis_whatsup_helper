import { Bot, InputFile } from 'grammy';
import { MessagingAdapter, MediaInfo } from '@gis-bot/shared';
import type { Message } from 'grammy/types';

export class TelegramAdapter implements MessagingAdapter {
    private bot: Bot;

    constructor(bot: Bot) {
        this.bot = bot;
    }

    async sendTextMessage(chatId: string, text: string): Promise<void> {
        await this.bot.api.sendMessage(Number(chatId), text, { parse_mode: 'Markdown' });
    }

    async sendFileMessage(chatId: string, data: Buffer, filename: string, mimeType: string): Promise<void> {
        const file = new InputFile(data, filename);
        if (mimeType.startsWith('image/')) {
            await this.bot.api.sendPhoto(Number(chatId), file);
        } else {
            await this.bot.api.sendDocument(Number(chatId), file);
        }
    }

    async getQuotedMessageMedia(platformMsg: any): Promise<MediaInfo | null> {
        const msg = platformMsg as Message;

        if (!msg.reply_to_message) {
            return null;
        }

        const replied = msg.reply_to_message;
        let fileId: string | undefined;
        let filename = 'file';
        let mimetype = 'application/octet-stream';

        if (replied.document) {
            fileId = replied.document.file_id;
            filename = replied.document.file_name || 'document';
            mimetype = replied.document.mime_type || mimetype;
        } else if (replied.photo && replied.photo.length > 0) {
            const largest = replied.photo[replied.photo.length - 1];
            fileId = largest.file_id;
            filename = 'photo.jpg';
            mimetype = 'image/jpeg';
        }

        if (!fileId) {
            return null;
        }

        try {
            const file = await this.bot.api.getFile(fileId);
            const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
            const response = await fetch(url);
            const buffer = Buffer.from(await response.arrayBuffer());

            return {
                data: buffer.toString('base64'),
                filename,
                mimetype,
            };
        } catch {
            return null;
        }
    }
}
