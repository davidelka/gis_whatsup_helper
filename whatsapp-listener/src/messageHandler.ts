import axios from 'axios';
import { Message, Client } from 'whatsapp-web.js';
import { Config } from './config';
import { logger } from './logger';
import { ReportTracker, ReportData, TimeoutEvent } from './reportTracker';

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
    reportId?: string; // Link to active report
}

export class MessageHandler {
    private config: Config;
    private pythonServiceUrl: string;
    private reportTracker: ReportTracker;
    private client?: Client;

    constructor(config: Config) {
        this.config = config;
        this.pythonServiceUrl = `http://${config.python_service.host}:${config.python_service.port}`;

        // Initialize ReportTracker with timeout from config
        this.reportTracker = new ReportTracker(
            config.whatsapp.report_timeout_seconds,
            this.handleReportTimeout.bind(this)
        );
    }

    setClient(client: Client) {
        this.client = client;
    }

    private async handleReportTimeout(report: ReportData, event: TimeoutEvent) {
        if (!this.client) return;

        try {
            if (event === 'warning') {
                logger.warn({ reportId: report.id }, 'Report inactivity warning - notifying group');
                const warningMsg = `⚠️ *דיווח של ${report.senderName} עומד להיסגר*\nלא זוהתה פעילות ב-2 הדקות האחרונות. שלח הודעה או מיקום תוך דקה כדי להמשיך את הדיווח.`;
                await this.client.sendMessage(report.groupId, warningMsg);
            } else if (event === 'closed') {
                logger.warn({ reportId: report.id }, 'Report inactivity closure - forwarding and notifying group');

                // Forward the report to Python service so it's not lost
                await this.forwardReportToPythonService(report);

                const statusText = report.location ? '' : ' (ללא מיקום)';
                const timeoutMsg = `⚠️ *דיווח נסגר אוטומטית*\nהדיווח של ${report.senderName} נסגר עקב חוסר פעילות ונשמר במערכת${statusText}.`;
                await this.client.sendMessage(report.groupId, timeoutMsg);
            }
        } catch (error) {
            logger.error({ error }, 'Failed to send timeout notification');
        }
    }

    async handleMessage(msg: Message): Promise<void> {
        try {
            const parsed = await this.parseMessage(msg);
            if (!parsed) {
                return;
            }

            // Check if user has an active report and link this message to it
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
            }, 'Processing message');

            // Check for report commands
            const reportCommand = this.reportTracker.isReportCommand(parsed.text);

            if (reportCommand === 'start') {
                const isPendingStart = this.reportTracker.getPendingConfirmation(parsed.senderId) === 'start_new';

                // Try to start report
                const report = this.reportTracker.startReport(parsed, isPendingStart);

                if (!report) {
                    // Report already open, ask for confirmation
                    this.reportTracker.setPendingConfirmation(parsed.senderId, 'start_new');
                    await msg.reply('⚠️ *יש לך כבר דיווח פתוח.*\nשלח שוב "תד" כדי לבטל את הישן ולהתחיל חדש.');
                    return;
                }

                if (isPendingStart) {
                    await msg.reply('🔄 *דיווח קודם בוטל. התחיל דיווח חדש.*');
                }
                // Don't forward the command itself
                return;
            }

            if (reportCommand === 'end') {
                const isPendingClose = this.reportTracker.getPendingConfirmation(parsed.senderId) === 'close_without_location';

                // Try to end the report
                const report = this.reportTracker.endReport(parsed, isPendingClose);

                if (report) {
                    await this.forwardReportToPythonService(report);
                    if (!report.location) {
                        await msg.reply('⚠️ *הדיווח נשלח ללא מיקום.*');
                    } else {
                        await msg.reply('✅ *הדיווח נשלח בהצלחה!*');
                    }
                } else {
                    // No active report or missing location (validation)
                    if (!this.reportTracker.hasActiveReport(parsed.senderId)) {
                        await msg.reply('⚠️ *אין לך דיווח פתוח כרגע.*\nשלח "תד" כדי להתחיל.');
                    } else {
                        // Missing location validation failure
                        this.reportTracker.setPendingConfirmation(parsed.senderId, 'close_without_location');
                        await msg.reply('⚠️ *חסר מיקום בדיווח!*\nאנא שלח מיקום (Location) או שלח שוב "סד" לסגירה ללא מיקום.');
                    }
                }
                return;
            }

            // Check if this message belongs to an active report
            if (this.reportTracker.hasActiveReport(parsed.senderId)) {
                // Add to report, don't forward individual messages
                this.reportTracker.addToReport(parsed);
                logger.debug({
                    senderId: parsed.senderId,
                    messageType: parsed.messageType,
                    hasLocation: !!parsed.location
                }, 'Message added to active report');
                return;
            }

            // Regular message - forward to Python service
            await this.forwardToPythonService(parsed);

        } catch (error) {
            logger.error({ error, messageId: msg.id.id }, 'Error handling message');
        }
    }

    private async parseMessage(msg: Message): Promise<ParsedMessage | null> {
        // whatsapp-web.js specific checks
        const chat = await msg.getChat();

        if (!chat.isGroup) {
            // Skip non-group messages
            return null;
        }

        const contact = await msg.getContact();

        const parsed: ParsedMessage = {
            id: msg.id.id,
            timestamp: msg.timestamp,
            groupId: chat.id._serialized,
            groupName: chat.name,
            senderId: msg.author || msg.from,
            senderName: contact.pushname || msg.author || msg.from,
            messageType: msg.type,
            text: msg.body,
        };

        // Extract location data
        if (msg.type === 'location' && msg.location) {
            parsed.location = {
                latitude: Number(msg.location.latitude),
                longitude: Number(msg.location.longitude),
                name: msg.location.name || undefined,
                address: msg.location.address || undefined,
            };
        }

        // Extract media info
        if (msg.hasMedia && msg.type === 'image') {
            try {
                const media = await msg.downloadMedia();
                if (media) {
                    parsed.mediaType = msg.type;
                    parsed.mediaData = media.data; // Base64 string
                    parsed.mediaFilename = media.filename || `${msg.id.id}.jpg`;
                    parsed.caption = msg.body;
                }
            } catch (error) {
                logger.error({ error, messageId: msg.id.id }, 'Failed to download media');
            }
        } else if (msg.hasMedia) {
            parsed.mediaType = msg.type;
            if (msg.type !== 'chat') {
                parsed.caption = msg.body;
            }
        }

        return parsed;
    }

    private async forwardToPythonService(message: ParsedMessage): Promise<void> {
        try {
            const response = await axios.post(`${this.pythonServiceUrl}/message`, message, {
                timeout: 5000,
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            logger.debug({
                status: response.status,
                messageId: message.id
            }, 'Message forwarded to Python service');

        } catch (error: any) {
            if (error.code === 'ECONNREFUSED') {
                logger.warn('Python service not available - message not forwarded');
            } else {
                logger.error({ error: error.message }, 'Failed to forward message to Python service');
            }
        }
    }

    private async forwardReportToPythonService(report: ReportData): Promise<void> {
        try {
            // Clean report data for JSON (remove timer handle)
            const cleanReport = { ...report };
            delete (cleanReport as any).timeoutHandle;

            const response = await axios.post(`${this.pythonServiceUrl}/report`, cleanReport, {
                timeout: 10000,
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            logger.info({
                status: response.status,
                reportId: report.id,
                reportStatus: report.status
            }, 'Report forwarded to Python service');

        } catch (error: any) {
            if (error.code === 'ECONNREFUSED') {
                logger.warn({ reportId: report.id }, 'Python service not available - report not forwarded');
            } else {
                logger.error({ error: error.message, reportId: report.id }, 'Failed to forward report to Python service');
            }
        }
    }
}
