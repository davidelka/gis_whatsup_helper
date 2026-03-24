import { Context } from 'grammy';
import {
    ParsedMessage,
    LocationData,
    logger,
    ReportTracker,
    ReportData,
    TimeoutEvent,
    CommandHandler,
    parseSlashCommand,
    PythonServiceClient,
} from '@gis-bot/shared';
import { TelegramAdapter } from './telegramAdapter';
import { Bot } from 'grammy';

export class TelegramMessageHandler {
    private pythonClient: PythonServiceClient;
    private reportTracker: ReportTracker;
    private commandHandler: CommandHandler;
    private adapter: TelegramAdapter;
    private bot: Bot;

    constructor(bot: Bot, pythonClient: PythonServiceClient, timeoutSeconds: number) {
        this.bot = bot;
        this.pythonClient = pythonClient;
        this.adapter = new TelegramAdapter(bot);

        this.reportTracker = new ReportTracker(
            timeoutSeconds,
            this.handleReportTimeout.bind(this)
        );

        this.commandHandler = new CommandHandler(this.reportTracker, this.pythonClient);
        this.commandHandler.setAdapter(this.adapter);
    }

    isGroupStopped(groupId: string): boolean {
        return this.commandHandler.isGroupStopped(groupId);
    }

    private async handleReportTimeout(report: ReportData, event: TimeoutEvent) {
        const quiet = this.commandHandler.isGroupQuiet(report.groupId);
        const chatId = Number(report.groupId);

        try {
            if (event === 'warning') {
                logger.warn({ reportId: report.id }, 'Report inactivity warning');
                if (!quiet) {
                    const warningMsg = `\u26a0\ufe0f *\u05d3\u05d9\u05d5\u05d5\u05d7 \u05e9\u05dc ${report.senderName} \u05e2\u05d5\u05de\u05d3 \u05dc\u05d4\u05d9\u05e1\u05d2\u05e8*\n\u05dc\u05d0 \u05d6\u05d5\u05d4\u05ea\u05d4 \u05e4\u05e2\u05d9\u05dc\u05d5\u05ea \u05d1-2 \u05d4\u05d3\u05e7\u05d5\u05ea \u05d4\u05d0\u05d7\u05e8\u05d5\u05e0\u05d5\u05ea. \u05e9\u05dc\u05d7 \u05d4\u05d5\u05d3\u05e2\u05d4 \u05d0\u05d5 \u05de\u05d9\u05e7\u05d5\u05dd \u05ea\u05d5\u05da \u05d3\u05e7\u05d4 \u05db\u05d3\u05d9 \u05dc\u05d4\u05de\u05e9\u05d9\u05da \u05d0\u05ea \u05d4\u05d3\u05d9\u05d5\u05d5\u05d7.`;
                    await this.bot.api.sendMessage(chatId, warningMsg, { parse_mode: 'Markdown' });
                }
            } else if (event === 'closed') {
                logger.warn({ reportId: report.id }, 'Report inactivity closure');
                await this.pythonClient.forwardReport(report);
                if (!quiet) {
                    const statusText = report.location ? '' : ' (\u05dc\u05dc\u05d0 \u05de\u05d9\u05e7\u05d5\u05dd)';
                    const timeoutMsg = `\u26a0\ufe0f *\u05d3\u05d9\u05d5\u05d5\u05d7 \u05e0\u05e1\u05d2\u05e8 \u05d0\u05d5\u05d8\u05d5\u05de\u05d8\u05d9\u05ea*\n\u05d4\u05d3\u05d9\u05d5\u05d5\u05d7 \u05e9\u05dc ${report.senderName} \u05e0\u05e1\u05d2\u05e8 \u05e2\u05e7\u05d1 \u05d7\u05d5\u05e1\u05e8 \u05e4\u05e2\u05d9\u05dc\u05d5\u05ea \u05d5\u05e0\u05e9\u05de\u05e8 \u05d1\u05de\u05e2\u05e8\u05db\u05ea${statusText}.`;
                    await this.bot.api.sendMessage(chatId, timeoutMsg, { parse_mode: 'Markdown' });
                }
            }
        } catch (error) {
            logger.error({ error }, 'Failed to send timeout notification');
        }
    }

    async handleMessage(ctx: Context): Promise<void> {
        const msg = ctx.message;
        if (!msg) return;

        try {
            const parsed = await this.parseMessage(ctx);
            if (!parsed) return;

            // Link to active report if exists
            const activeReport = this.reportTracker.getActiveReport(parsed.senderId);
            if (activeReport) {
                parsed.reportId = activeReport.id;
            }

            logger.info({
                messageType: parsed.messageType,
                groupId: parsed.groupId,
                senderId: parsed.senderId,
                hasLocation: !!parsed.location,
                text: parsed.text?.substring(0, 50)
            }, 'Processing Telegram message');

            // Slash commands (always processed)
            const slashCommand = parseSlashCommand(parsed.text);
            if (slashCommand) {
                const sendReply = async (text: string) => {
                    await ctx.reply(text, { parse_mode: 'Markdown' });
                };
                await this.commandHandler.execute(slashCommand, parsed, msg, sendReply);
                return;
            }

            // If group is stopped, skip
            if (this.commandHandler.isGroupStopped(parsed.groupId)) {
                logger.debug({ groupId: parsed.groupId }, 'Group is stopped, skipping message');
                return;
            }

            // Report commands
            const reportCommand = this.reportTracker.isReportCommand(parsed.text);

            if (reportCommand === 'start') {
                const isPendingStart = this.reportTracker.getPendingConfirmation(parsed.senderId) === 'start_new';
                const report = this.reportTracker.startReport(parsed, isPendingStart);

                if (!report) {
                    this.reportTracker.setPendingConfirmation(parsed.senderId, 'start_new');
                    await this.sendReply(ctx, parsed.groupId, '\u26a0\ufe0f *\u05d9\u05e9 \u05dc\u05da \u05db\u05d1\u05e8 \u05d3\u05d9\u05d5\u05d5\u05d7 \u05e4\u05ea\u05d5\u05d7.*\n\u05e9\u05dc\u05d7 \u05e9\u05d5\u05d1 "\u05ea\u05d3" \u05db\u05d3\u05d9 \u05dc\u05d1\u05d8\u05dc \u05d0\u05ea \u05d4\u05d9\u05e9\u05df \u05d5\u05dc\u05d4\u05ea\u05d7\u05d9\u05dc \u05d7\u05d3\u05e9.');
                    return;
                }

                if (isPendingStart) {
                    await this.sendReply(ctx, parsed.groupId, '\u{1f504} *\u05d3\u05d9\u05d5\u05d5\u05d7 \u05e7\u05d5\u05d3\u05dd \u05d1\u05d5\u05d8\u05dc. \u05d4\u05ea\u05d7\u05d9\u05dc \u05d3\u05d9\u05d5\u05d5\u05d7 \u05d7\u05d3\u05e9.*');
                }
                return;
            }

            if (reportCommand === 'end') {
                const isPendingClose = this.reportTracker.getPendingConfirmation(parsed.senderId) === 'close_without_location';
                const report = this.reportTracker.endReport(parsed, isPendingClose);

                if (report) {
                    await this.pythonClient.forwardReport(report);
                    const replyText = !report.location
                        ? '\u26a0\ufe0f *\u05d4\u05d3\u05d9\u05d5\u05d5\u05d7 \u05e0\u05e9\u05dc\u05d7 \u05dc\u05dc\u05d0 \u05de\u05d9\u05e7\u05d5\u05dd.*'
                        : '\u2705 *\u05d4\u05d3\u05d9\u05d5\u05d5\u05d7 \u05e0\u05e9\u05dc\u05d7 \u05d1\u05d4\u05e6\u05dc\u05d7\u05d4!*';
                    await this.sendReply(ctx, parsed.groupId, replyText);
                } else {
                    if (!this.reportTracker.hasActiveReport(parsed.senderId)) {
                        await this.sendReply(ctx, parsed.groupId, '\u26a0\ufe0f *\u05d0\u05d9\u05df \u05dc\u05da \u05d3\u05d9\u05d5\u05d5\u05d7 \u05e4\u05ea\u05d5\u05d7 \u05db\u05e8\u05d2\u05e2.*\n\u05e9\u05dc\u05d7 "\u05ea\u05d3" \u05db\u05d3\u05d9 \u05dc\u05d4\u05ea\u05d7\u05d9\u05dc.');
                    } else {
                        this.reportTracker.setPendingConfirmation(parsed.senderId, 'close_without_location');
                        await this.sendReply(ctx, parsed.groupId, '\u26a0\ufe0f *\u05d7\u05e1\u05e8 \u05de\u05d9\u05e7\u05d5\u05dd \u05d1\u05d3\u05d9\u05d5\u05d5\u05d7!*\n\u05d0\u05e0\u05d0 \u05e9\u05dc\u05d7 \u05de\u05d9\u05e7\u05d5\u05dd (Location) \u05d0\u05d5 \u05e9\u05dc\u05d7 \u05e9\u05d5\u05d1 "\u05e1\u05d3" \u05dc\u05e1\u05d2\u05d9\u05e8\u05d4 \u05dc\u05dc\u05d0 \u05de\u05d9\u05e7\u05d5\u05dd.');
                    }
                }
                return;
            }

            // Active report - add message
            if (this.reportTracker.hasActiveReport(parsed.senderId)) {
                this.reportTracker.addToReport(parsed);
                logger.debug({ senderId: parsed.senderId, messageType: parsed.messageType }, 'Message added to active report');
                return;
            }

            // Regular message - forward
            await this.pythonClient.forwardMessage(parsed);

        } catch (error: any) {
            logger.error({ error: error.message, stack: error.stack }, 'Error handling Telegram message');
        }
    }

    private async sendReply(ctx: Context, groupId: string, text: string): Promise<void> {
        if (this.commandHandler.isGroupQuiet(groupId)) {
            logger.debug({ groupId }, 'Reply suppressed (quiet mode)');
            return;
        }
        await ctx.reply(text, { parse_mode: 'Markdown' });
    }

    private async parseMessage(ctx: Context): Promise<ParsedMessage | null> {
        const msg = ctx.message;
        if (!msg) return null;

        const chat = msg.chat;
        const from = msg.from;
        if (!from) return null;

        const chatId = String(chat.id);
        const senderId = `tg:${from.id}`;
        const senderName = from.first_name + (from.last_name ? ` ${from.last_name}` : '');
        const groupName = chat.type === 'private'
            ? `DM:${senderName}`
            : ('title' in chat ? chat.title || chatId : chatId);

        const parsed: ParsedMessage = {
            id: `tg_${msg.message_id}_${chatId}`,
            timestamp: msg.date,
            groupId: chatId,
            groupName: groupName,
            senderId: senderId,
            senderName: senderName,
            messageType: 'text',
            text: msg.text || msg.caption || '',
            source: 'telegram',
        };

        // Location
        if (msg.location) {
            parsed.messageType = 'location';
            parsed.location = {
                latitude: msg.location.latitude,
                longitude: msg.location.longitude,
            };
        }

        // Photo
        if (msg.photo && msg.photo.length > 0) {
            parsed.messageType = 'image';
            const largest = msg.photo[msg.photo.length - 1];

            try {
                const file = await this.bot.api.getFile(largest.file_id);
                const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
                const response = await fetch(url);
                const buffer = Buffer.from(await response.arrayBuffer());

                parsed.mediaType = 'image';
                parsed.mediaData = buffer.toString('base64');
                parsed.mediaFilename = `tg_${msg.message_id}.jpg`;
                parsed.caption = msg.caption || undefined;
            } catch (error) {
                logger.error({ error }, 'Failed to download Telegram photo');
            }
        }

        // Document
        if (msg.document) {
            parsed.messageType = 'document';
            parsed.mediaType = 'document';
            parsed.mediaFilename = msg.document.file_name || 'document';
            parsed.caption = msg.caption || undefined;
        }

        return parsed;
    }
}
