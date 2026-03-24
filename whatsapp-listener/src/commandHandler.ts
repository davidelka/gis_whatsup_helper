import axios from 'axios';
import { Client, Message, MessageMedia } from 'whatsapp-web.js';
import { ReportTracker } from './reportTracker';
import { ParsedMessage } from './messageHandler';
import { logger } from './logger';

export type SlashCommand = 'help' | 'status' | 'cancel' | 'stats' | 'last' | 'quiet' | 'stop' | 'start' | 'export' | 'map' | 'pins' | 'html' | 'import';

const COMMAND_ALIASES: Record<string, SlashCommand> = {
    'help': 'help',
    'עזרה': 'help',
    'status': 'status',
    'סטטוס': 'status',
    'cancel': 'cancel',
    'ביטול': 'cancel',
    'stats': 'stats',
    'נתונים': 'stats',
    'last': 'last',
    'אחרון': 'last',
    'quiet': 'quiet',
    'שקט': 'quiet',
    'stop': 'stop',
    'עצור': 'stop',
    'start': 'start',
    'התחל': 'start',
    'export': 'export',
    'ייצוא': 'export',
    'map': 'map',
    'מפה': 'map',
    'pins': 'pins',
    'נקודות': 'pins',
    'html': 'html',
    'דף': 'html',
    'import': 'import',
    'יבוא': 'import',
};

export function parseSlashCommand(text: string | undefined): SlashCommand | null {
    if (!text) return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;
    const commandPart = trimmed.substring(1).split(/\s/)[0].toLowerCase();
    return COMMAND_ALIASES[commandPart] ?? null;
}

interface GroupMode {
    quiet: boolean;
    stopped: boolean;
}

export class CommandHandler {
    private reportTracker: ReportTracker;
    private pythonServiceUrl: string;
    private groupModes: Map<string, GroupMode> = new Map();
    private client?: Client;

    constructor(reportTracker: ReportTracker, pythonServiceUrl: string) {
        this.reportTracker = reportTracker;
        this.pythonServiceUrl = pythonServiceUrl;
    }

    setClient(client: Client) {
        this.client = client;
    }

    isGroupStopped(groupId: string): boolean {
        return this.groupModes.get(groupId)?.stopped ?? false;
    }

    isGroupQuiet(groupId: string): boolean {
        return this.groupModes.get(groupId)?.quiet ?? false;
    }

    private getOrCreateMode(groupId: string): GroupMode {
        let mode = this.groupModes.get(groupId);
        if (!mode) {
            mode = { quiet: false, stopped: false };
            this.groupModes.set(groupId, mode);
        }
        return mode;
    }

    async execute(
        command: SlashCommand,
        parsed: ParsedMessage,
        msg: Message,
        sendReply: (text: string) => Promise<void>
    ): Promise<void> {
        logger.info({ command, senderId: parsed.senderId, groupId: parsed.groupId }, 'Executing slash command');

        switch (command) {
            case 'help':
                await this.handleHelp(sendReply);
                break;
            case 'status':
                await this.handleStatus(parsed.senderId, sendReply);
                break;
            case 'cancel':
                await this.handleCancel(parsed.senderId, sendReply);
                break;
            case 'stats':
                await this.handleStats(sendReply);
                break;
            case 'last':
                await this.handleLast(parsed.senderId, sendReply);
                break;
            case 'quiet':
                await this.handleQuiet(parsed.groupId, sendReply);
                break;
            case 'stop':
                await this.handleStop(parsed.groupId, sendReply);
                break;
            case 'start':
                await this.handleStart(parsed.groupId, sendReply);
                break;
            case 'export':
                await this.handleExport(parsed, sendReply);
                break;
            case 'map':
                await this.handleMap(parsed, sendReply);
                break;
            case 'pins':
                await this.handlePins(parsed, sendReply);
                break;
            case 'html':
                await this.handleHtml(parsed, sendReply);
                break;
            case 'import':
                await this.handleImport(parsed, msg, sendReply);
                break;
        }
    }

    private async handleHelp(sendReply: (text: string) => Promise<void>): Promise<void> {
        const helpText = [
            '📋 *פקודות זמינות:*',
            '',
            '*/help* (*/עזרה*) — רשימת פקודות',
            '*/status* (*/סטטוס*) — מצב הדיווח הפעיל',
            '*/cancel* (*/ביטול*) — ביטול דיווח ללא שמירה',
            '*/stats* (*/נתונים*) — סטטיסטיקות המערכת',
            '*/last* (*/אחרון*) — סיכום הדיווח האחרון',
            '*/quiet* (*/שקט*) — מצב שקט (הפעלה/כיבוי)',
            '*/export* (*/ייצוא*) — ייצוא KML של דיווחי היום',
            '*/map* (*/מפה*) — תמונת מפה עם נקודות היום',
            '*/pins* (*/נקודות*) — קישורי Google Maps לכל מיקום',
            '*/html* (*/דף*) — מפה אינטראקטיבית (קובץ HTML)',
            '*/import* (*/יבוא*) — יבוא קובץ KML (השב על קובץ)',
            '*/stop* (*/עצור*) — השהיית הבוט בקבוצה',
            '*/start* (*/התחל*) — הפעלת הבוט מחדש',
            '',
            '📝 *דיווח:*',
            '*תד* — התחלת דיווח חדש',
            '*סד* — סיום דיווח (יש לצרף מיקום)',
        ].join('\n');

        await sendReply(helpText);
    }

    private async handleStatus(senderId: string, sendReply: (text: string) => Promise<void>): Promise<void> {
        const report = this.reportTracker.getActiveReport(senderId);

        if (!report) {
            await sendReply('ℹ️ *אין לך דיווח פעיל כרגע.*\nשלח "תד" כדי להתחיל דיווח.');
            return;
        }

        const elapsedSeconds = Math.floor(Date.now() / 1000) - report.startedAt;
        const minutes = Math.floor(elapsedSeconds / 60);
        const seconds = elapsedSeconds % 60;
        const elapsedStr = minutes > 0
            ? `${minutes} דקות ו-${seconds} שניות`
            : `${seconds} שניות`;

        const locationStatus = report.location ? '✅ יש מיקום' : '❌ חסר מיקום';
        const timerStatus = report.timerState === 'grace_period'
            ? '⚠️ תקופת חסד (עומד להיסגר!)'
            : '🟢 פעיל';

        const statusText = [
            '📊 *מצב דיווח נוכחי:*',
            '',
            `⏱️ זמן: ${elapsedStr}`,
            `💬 הודעות: ${report.messages.length}`,
            `📍 מיקום: ${locationStatus}`,
            `🔄 מצב: ${timerStatus}`,
        ].join('\n');

        await sendReply(statusText);
    }

    private async handleCancel(senderId: string, sendReply: (text: string) => Promise<void>): Promise<void> {
        const report = this.reportTracker.getActiveReport(senderId);

        if (!report) {
            await sendReply('ℹ️ *אין לך דיווח פעיל לביטול.*');
            return;
        }

        const messageCount = report.messages.length;
        this.reportTracker.cancelReport(senderId);

        await sendReply(`🚫 *הדיווח בוטל.*\n${messageCount} הודעות נמחקו ולא נשמרו.`);
    }

    private async handleStats(sendReply: (text: string) => Promise<void>): Promise<void> {
        try {
            const response = await axios.get(`${this.pythonServiceUrl}/stats`, { timeout: 5000 });
            const data = response.data;

            const statsText = [
                '📈 *סטטיסטיקות המערכת:*',
                '',
                `💬 הודעות: ${data.messages}`,
                `📍 מיקומים: ${data.locations}`,
                `📋 דיווחים: ${data.reports.total} (✅ ${data.reports.complete} תקינים, ⚠️ ${data.reports.invalid} ללא מיקום)`,
                `👥 קבוצות: ${data.groups?.length ?? 0}`,
            ].join('\n');

            await sendReply(statsText);
        } catch (error: any) {
            logger.error({ error: error.message }, 'Failed to fetch stats');
            await sendReply('❌ *שגיאה בטעינת נתונים.* השירות אינו זמין כרגע.');
        }
    }

    private async handleLast(senderId: string, sendReply: (text: string) => Promise<void>): Promise<void> {
        try {
            const response = await axios.get(`${this.pythonServiceUrl}/reports`, {
                params: { sender_id: senderId },
                timeout: 5000
            });

            const reports = response.data.reports;
            if (!reports || reports.length === 0) {
                await sendReply('ℹ️ *לא נמצאו דיווחים קודמים שלך.*');
                return;
            }

            const last = reports[0];
            const startDate = new Date(last.started_at);
            const dateStr = startDate.toLocaleDateString('he-IL');
            const timeStr = startDate.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
            const statusEmoji = last.status === 'complete' ? '✅' : '⚠️';
            const statusLabel = last.status === 'complete' ? 'תקין' : 'ללא מיקום';
            const locationStr = last.latitude && last.longitude
                ? `📍 ${last.latitude.toFixed(5)}, ${last.longitude.toFixed(5)}`
                : '📍 ללא מיקום';

            const lines = [
                '📋 *הדיווח האחרון שלך:*',
                '',
                `📅 תאריך: ${dateStr} ${timeStr}`,
                `${statusEmoji} סטטוס: ${statusLabel}`,
                `💬 הודעות: ${last.message_count}`,
                locationStr,
            ];

            if (last.location_name) {
                lines.push(`📌 ${last.location_name}`);
            }

            await sendReply(lines.join('\n'));
        } catch (error: any) {
            logger.error({ error: error.message }, 'Failed to fetch last report');
            await sendReply('❌ *שגיאה בטעינת הדיווח האחרון.* השירות אינו זמין כרגע.');
        }
    }

    private async handleQuiet(groupId: string, sendReply: (text: string) => Promise<void>): Promise<void> {
        const mode = this.getOrCreateMode(groupId);
        mode.quiet = !mode.quiet;

        if (mode.quiet) {
            await sendReply('🔇 *מצב שקט הופעל.*\nהבוט ימשיך לעבד הודעות אך לא ישלח תגובות.');
        } else {
            await sendReply('🔊 *מצב שקט כובה.*\nהבוט יחזור לשלוח תגובות.');
        }
    }

    private async handleStop(groupId: string, sendReply: (text: string) => Promise<void>): Promise<void> {
        const mode = this.getOrCreateMode(groupId);

        if (mode.stopped) {
            await sendReply('ℹ️ *הבוט כבר מושהה בקבוצה זו.*\nשלח /start להפעלה מחדש.');
            return;
        }

        mode.stopped = true;
        await sendReply('⏸️ *הבוט הושהה.*\nלא יתבצע עיבוד הודעות בקבוצה זו עד להפעלה מחדש (/start).');
    }

    private async handleStart(groupId: string, sendReply: (text: string) => Promise<void>): Promise<void> {
        const mode = this.getOrCreateMode(groupId);

        if (!mode.stopped) {
            await sendReply('ℹ️ *הבוט כבר פעיל בקבוצה זו.*');
            return;
        }

        mode.stopped = false;
        await sendReply('▶️ *הבוט הופעל מחדש.*\nעיבוד הודעות חזר לפעולה.');
    }

    private getTodayDate(): string {
        return new Date().toISOString().split('T')[0];
    }

    private getGroupFilterParams(parsed: ParsedMessage) {
        return { group: parsed.groupName, from_date: this.getTodayDate() };
    }

    private async handleExport(parsed: ParsedMessage, sendReply: (text: string) => Promise<void>): Promise<void> {
        if (!this.client) {
            await sendReply('❌ *שגיאה: הבוט לא מחובר.*');
            return;
        }

        const today = this.getTodayDate();

        try {
            await sendReply('⏳ *מייצא נתונים...*');

            const response = await axios.get(`${this.pythonServiceUrl}/export/kml`, {
                params: this.getGroupFilterParams(parsed),
                timeout: 15000,
                responseType: 'arraybuffer',
                validateStatus: (status) => status < 500,
            });

            if (response.status === 404) {
                await sendReply('ℹ️ *אין נתונים לייצוא להיום בקבוצה זו.*');
                return;
            }

            const base64Data = Buffer.from(response.data).toString('base64');
            const media = new MessageMedia(
                'application/vnd.google-earth.kml+xml',
                base64Data,
                `export_${today}.kml`
            );

            await this.client.sendMessage(parsed.groupId, media, { sendSeen: false });
            await sendReply(`✅ *קובץ KML נשלח* — דיווחי ${today} בקבוצה זו.`);
        } catch (error: any) {
            logger.error({ error: error.message, groupId: parsed.groupId }, 'Failed to export KML');
            if (error.code === 'ECONNREFUSED') {
                await sendReply('❌ *שגיאה בייצוא.* שירות העיבוד אינו זמין.');
            } else {
                await sendReply('❌ *שגיאה בייצוא קובץ KML.*');
            }
        }
    }

    private async handleMap(parsed: ParsedMessage, sendReply: (text: string) => Promise<void>): Promise<void> {
        if (!this.client) {
            await sendReply('❌ *שגיאה: הבוט לא מחובר.*');
            return;
        }

        try {
            await sendReply('⏳ *מייצר תמונת מפה...*');

            const response = await axios.get(`${this.pythonServiceUrl}/export/map-image`, {
                params: this.getGroupFilterParams(parsed),
                timeout: 20000,
                responseType: 'arraybuffer',
                validateStatus: (status) => status < 500,
            });

            if (response.status === 404) {
                await sendReply('ℹ️ *אין מיקומים להיום בקבוצה זו.*');
                return;
            }

            const base64Data = Buffer.from(response.data).toString('base64');
            const media = new MessageMedia('image/png', base64Data, `map_${this.getTodayDate()}.png`);

            await this.client.sendMessage(parsed.groupId, media, { sendSeen: false });
        } catch (error: any) {
            logger.error({ error: error.message, groupId: parsed.groupId }, 'Failed to generate map image');
            if (error.code === 'ECONNREFUSED') {
                await sendReply('❌ *שגיאה.* שירות העיבוד אינו זמין.');
            } else {
                await sendReply('❌ *שגיאה ביצירת תמונת המפה.*');
            }
        }
    }

    private async handlePins(parsed: ParsedMessage, sendReply: (text: string) => Promise<void>): Promise<void> {
        try {
            const response = await axios.get(`${this.pythonServiceUrl}/locations`, {
                params: this.getGroupFilterParams(parsed),
                timeout: 5000
            });

            const locations = response.data.locations;
            if (!locations || locations.length === 0) {
                await sendReply('ℹ️ *אין מיקומים להיום בקבוצה זו.*');
                return;
            }

            const lines = [`📍 *${locations.length} מיקומים מהיום:*`, ''];
            for (const loc of locations) {
                const name = loc.name || loc.sender_name || `מיקום ${loc.id}`;
                const time = loc.timestamp ? new Date(loc.timestamp).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '';
                const link = `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
                lines.push(`📌 *${name}* ${time}\n${link}`);
            }

            await sendReply(lines.join('\n'));
        } catch (error: any) {
            logger.error({ error: error.message }, 'Failed to fetch pins');
            if (error.code === 'ECONNREFUSED') {
                await sendReply('❌ *שגיאה.* שירות העיבוד אינו זמין.');
            } else {
                await sendReply('❌ *שגיאה בטעינת המיקומים.*');
            }
        }
    }

    private async handleHtml(parsed: ParsedMessage, sendReply: (text: string) => Promise<void>): Promise<void> {
        if (!this.client) {
            await sendReply('❌ *שגיאה: הבוט לא מחובר.*');
            return;
        }

        try {
            const response = await axios.get(`${this.pythonServiceUrl}/export/map-html`, {
                params: this.getGroupFilterParams(parsed),
                timeout: 10000,
                responseType: 'arraybuffer',
                validateStatus: (status) => status < 500,
            });

            if (response.status === 404) {
                await sendReply('ℹ️ *אין מיקומים להיום בקבוצה זו.*');
                return;
            }

            const base64Data = Buffer.from(response.data).toString('base64');
            const media = new MessageMedia(
                'text/html',
                base64Data,
                `map_${this.getTodayDate()}.html`
            );

            await this.client.sendMessage(parsed.groupId, media, { sendSeen: false });
            await sendReply('🗺️ *מפה אינטראקטיבית נשלחה.* פתח את הקובץ בדפדפן.');
        } catch (error: any) {
            logger.error({ error: error.message, groupId: parsed.groupId }, 'Failed to generate HTML map');
            if (error.code === 'ECONNREFUSED') {
                await sendReply('❌ *שגיאה.* שירות העיבוד אינו זמין.');
            } else {
                await sendReply('❌ *שגיאה ביצירת מפת HTML.*');
            }
        }
    }

    private async handleImport(parsed: ParsedMessage, msg: Message, sendReply: (text: string) => Promise<void>): Promise<void> {
        // Must be a reply to a file message
        if (!msg.hasQuotedMsg) {
            await sendReply('ℹ️ *השב על קובץ KML עם /import כדי לייבא אותו.*');
            return;
        }

        try {
            const quoted = await msg.getQuotedMessage();

            if (!quoted.hasMedia) {
                await sendReply('❌ *ההודעה שהשבת עליה אינה מכילה קובץ.*');
                return;
            }

            await sendReply('⏳ *מייבא קובץ KML...*');

            const media = await quoted.downloadMedia();
            if (!media || !media.data) {
                await sendReply('❌ *לא ניתן להוריד את הקובץ.*');
                return;
            }

            // Validate it looks like a KML file
            const filename = media.filename || 'import.kml';
            const isKml = filename.toLowerCase().endsWith('.kml') ||
                          media.mimetype?.includes('kml') ||
                          media.mimetype?.includes('xml');

            if (!isKml) {
                await sendReply('❌ *הקובץ אינו KML.* נא לשלוח קובץ בפורמט .kml');
                return;
            }

            const response = await axios.post(`${this.pythonServiceUrl}/import/kml`, {
                kml_data: media.data,
                filename,
                group_id: parsed.groupId,
                group_name: parsed.groupName,
                sender_id: parsed.senderId,
                sender_name: parsed.senderName,
            }, {
                timeout: 30000,
                headers: { 'Content-Type': 'application/json' },
            });

            const result = response.data;
            const parts = [`✅ *יבוא KML הושלם — ${filename}*`];
            if (result.points_imported > 0) {
                parts.push(`📍 נקודות: ${result.points_imported}`);
            }
            if (result.tracks_imported > 0) {
                parts.push(`🛤️ מסלולים: ${result.tracks_imported}`);
            }
            if (result.points_imported === 0 && result.tracks_imported === 0) {
                parts.push('⚠️ לא נמצאו נתונים גיאוגרפיים בקובץ.');
            }

            await sendReply(parts.join('\n'));
        } catch (error: any) {
            logger.error({ error: error.message, groupId: parsed.groupId }, 'Failed to import KML');
            if (error.code === 'ECONNREFUSED') {
                await sendReply('❌ *שגיאה.* שירות העיבוד אינו זמין.');
            } else {
                await sendReply('❌ *שגיאה ביבוא קובץ KML.*');
            }
        }
    }
}
