import { ReportTracker } from './reportTracker';
import { ParsedMessage, MessagingAdapter } from './types';
import { PythonServiceClient } from './pythonServiceClient';
import { logger } from './logger';

export type SlashCommand = 'help' | 'status' | 'cancel' | 'stats' | 'last' | 'quiet' | 'stop' | 'start' | 'export' | 'map' | 'pins' | 'html' | 'import';

const COMMAND_ALIASES: Record<string, SlashCommand> = {
    'help': 'help',
    '\u05e2\u05d6\u05e8\u05d4': 'help',
    'status': 'status',
    '\u05e1\u05d8\u05d8\u05d5\u05e1': 'status',
    'cancel': 'cancel',
    '\u05d1\u05d9\u05d8\u05d5\u05dc': 'cancel',
    'stats': 'stats',
    '\u05e0\u05ea\u05d5\u05e0\u05d9\u05dd': 'stats',
    'last': 'last',
    '\u05d0\u05d7\u05e8\u05d5\u05df': 'last',
    'quiet': 'quiet',
    '\u05e9\u05e7\u05d8': 'quiet',
    'stop': 'stop',
    '\u05e2\u05e6\u05d5\u05e8': 'stop',
    'start': 'start',
    '\u05d4\u05ea\u05d7\u05dc': 'start',
    'export': 'export',
    '\u05d9\u05d9\u05e6\u05d5\u05d0': 'export',
    'map': 'map',
    '\u05de\u05e4\u05d4': 'map',
    'pins': 'pins',
    '\u05e0\u05e7\u05d5\u05d3\u05d5\u05ea': 'pins',
    'html': 'html',
    '\u05d3\u05e3': 'html',
    'import': 'import',
    '\u05d9\u05d1\u05d5\u05d0': 'import',
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
    private client: PythonServiceClient;
    private groupModes: Map<string, GroupMode> = new Map();
    private adapter?: MessagingAdapter;

    constructor(reportTracker: ReportTracker, pythonServiceClient: PythonServiceClient) {
        this.reportTracker = reportTracker;
        this.client = pythonServiceClient;
    }

    setAdapter(adapter: MessagingAdapter) {
        this.adapter = adapter;
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
        platformMsg: any,
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
                await this.handleImport(parsed, platformMsg, sendReply);
                break;
        }
    }

    private async handleHelp(sendReply: (text: string) => Promise<void>): Promise<void> {
        const helpText = [
            '\u{1f4cb} *\u05e4\u05e7\u05d5\u05d3\u05d5\u05ea \u05d6\u05de\u05d9\u05e0\u05d5\u05ea:*',
            '',
            '*/help* (*/\u05e2\u05d6\u05e8\u05d4*) \u2014 \u05e8\u05e9\u05d9\u05de\u05ea \u05e4\u05e7\u05d5\u05d3\u05d5\u05ea',
            '*/status* (*/\u05e1\u05d8\u05d8\u05d5\u05e1*) \u2014 \u05de\u05e6\u05d1 \u05d4\u05d3\u05d9\u05d5\u05d5\u05d7 \u05d4\u05e4\u05e2\u05d9\u05dc',
            '*/cancel* (*/\u05d1\u05d9\u05d8\u05d5\u05dc*) \u2014 \u05d1\u05d9\u05d8\u05d5\u05dc \u05d3\u05d9\u05d5\u05d5\u05d7 \u05dc\u05dc\u05d0 \u05e9\u05de\u05d9\u05e8\u05d4',
            '*/stats* (*/\u05e0\u05ea\u05d5\u05e0\u05d9\u05dd*) \u2014 \u05e1\u05d8\u05d8\u05d9\u05e1\u05d8\u05d9\u05e7\u05d5\u05ea \u05d4\u05de\u05e2\u05e8\u05db\u05ea',
            '*/last* (*/\u05d0\u05d7\u05e8\u05d5\u05df*) \u2014 \u05e1\u05d9\u05db\u05d5\u05dd \u05d4\u05d3\u05d9\u05d5\u05d5\u05d7 \u05d4\u05d0\u05d7\u05e8\u05d5\u05df',
            '*/quiet* (*/\u05e9\u05e7\u05d8*) \u2014 \u05de\u05e6\u05d1 \u05e9\u05e7\u05d8 (\u05d4\u05e4\u05e2\u05dc\u05d4/\u05db\u05d9\u05d1\u05d5\u05d9)',
            '*/export* (*/\u05d9\u05d9\u05e6\u05d5\u05d0*) \u2014 \u05d9\u05d9\u05e6\u05d5\u05d0 KML \u05e9\u05dc \u05d3\u05d9\u05d5\u05d5\u05d7\u05d9 \u05d4\u05d9\u05d5\u05dd',
            '*/map* (*/\u05de\u05e4\u05d4*) \u2014 \u05ea\u05de\u05d5\u05e0\u05ea \u05de\u05e4\u05d4 (street/satellite/topo/dark/terrain)',
            '*/pins* (*/\u05e0\u05e7\u05d5\u05d3\u05d5\u05ea*) \u2014 \u05e7\u05d9\u05e9\u05d5\u05e8\u05d9 Google Maps \u05dc\u05db\u05dc \u05de\u05d9\u05e7\u05d5\u05dd',
            '*/html* (*/\u05d3\u05e3*) \u2014 \u05de\u05e4\u05d4 \u05d0\u05d9\u05e0\u05d8\u05e8\u05d0\u05e7\u05d8\u05d9\u05d1\u05d9\u05ea (\u05e7\u05d5\u05d1\u05e5 HTML)',
            '*/import* (*/\u05d9\u05d1\u05d5\u05d0*) \u2014 \u05d9\u05d1\u05d5\u05d0 \u05e7\u05d5\u05d1\u05e5 KML (\u05d4\u05e9\u05d1 \u05e2\u05dc \u05e7\u05d5\u05d1\u05e5)',
            '*/stop* (*/\u05e2\u05e6\u05d5\u05e8*) \u2014 \u05d4\u05e9\u05d4\u05d9\u05d9\u05ea \u05d4\u05d1\u05d5\u05d8 \u05d1\u05e7\u05d1\u05d5\u05e6\u05d4',
            '*/start* (*/\u05d4\u05ea\u05d7\u05dc*) \u2014 \u05d4\u05e4\u05e2\u05dc\u05ea \u05d4\u05d1\u05d5\u05d8 \u05de\u05d7\u05d3\u05e9',
            '',
            '\u{1f4dd} *\u05d3\u05d9\u05d5\u05d5\u05d7:*',
            '*\u05ea\u05d3* \u2014 \u05d4\u05ea\u05d7\u05dc\u05ea \u05d3\u05d9\u05d5\u05d5\u05d7 \u05d7\u05d3\u05e9',
            '*\u05e1\u05d3* \u2014 \u05e1\u05d9\u05d5\u05dd \u05d3\u05d9\u05d5\u05d5\u05d7 (\u05d9\u05e9 \u05dc\u05e6\u05e8\u05e3 \u05de\u05d9\u05e7\u05d5\u05dd)',
        ].join('\n');

        await sendReply(helpText);
    }

    private async handleStatus(senderId: string, sendReply: (text: string) => Promise<void>): Promise<void> {
        const report = this.reportTracker.getActiveReport(senderId);

        if (!report) {
            await sendReply('\u2139\ufe0f *\u05d0\u05d9\u05df \u05dc\u05da \u05d3\u05d9\u05d5\u05d5\u05d7 \u05e4\u05e2\u05d9\u05dc \u05db\u05e8\u05d2\u05e2.*\n\u05e9\u05dc\u05d7 "\u05ea\u05d3" \u05db\u05d3\u05d9 \u05dc\u05d4\u05ea\u05d7\u05d9\u05dc \u05d3\u05d9\u05d5\u05d5\u05d7.');
            return;
        }

        const elapsedSeconds = Math.floor(Date.now() / 1000) - report.startedAt;
        const minutes = Math.floor(elapsedSeconds / 60);
        const seconds = elapsedSeconds % 60;
        const elapsedStr = minutes > 0
            ? `${minutes} \u05d3\u05e7\u05d5\u05ea \u05d5-${seconds} \u05e9\u05e0\u05d9\u05d5\u05ea`
            : `${seconds} \u05e9\u05e0\u05d9\u05d5\u05ea`;

        const locationStatus = report.location ? '\u2705 \u05d9\u05e9 \u05de\u05d9\u05e7\u05d5\u05dd' : '\u274c \u05d7\u05e1\u05e8 \u05de\u05d9\u05e7\u05d5\u05dd';
        const timerStatus = report.timerState === 'grace_period'
            ? '\u26a0\ufe0f \u05ea\u05e7\u05d5\u05e4\u05ea \u05d7\u05e1\u05d3 (\u05e2\u05d5\u05de\u05d3 \u05dc\u05d4\u05d9\u05e1\u05d2\u05e8!)'
            : '\u{1f7e2} \u05e4\u05e2\u05d9\u05dc';

        const statusText = [
            '\u{1f4ca} *\u05de\u05e6\u05d1 \u05d3\u05d9\u05d5\u05d5\u05d7 \u05e0\u05d5\u05db\u05d7\u05d9:*',
            '',
            `\u23f1\ufe0f \u05d6\u05de\u05df: ${elapsedStr}`,
            `\u{1f4ac} \u05d4\u05d5\u05d3\u05e2\u05d5\u05ea: ${report.messages.length}`,
            `\u{1f4cd} \u05de\u05d9\u05e7\u05d5\u05dd: ${locationStatus}`,
            `\u{1f504} \u05de\u05e6\u05d1: ${timerStatus}`,
        ].join('\n');

        await sendReply(statusText);
    }

    private async handleCancel(senderId: string, sendReply: (text: string) => Promise<void>): Promise<void> {
        const report = this.reportTracker.getActiveReport(senderId);

        if (!report) {
            await sendReply('\u2139\ufe0f *\u05d0\u05d9\u05df \u05dc\u05da \u05d3\u05d9\u05d5\u05d5\u05d7 \u05e4\u05e2\u05d9\u05dc \u05dc\u05d1\u05d9\u05d8\u05d5\u05dc.*');
            return;
        }

        const messageCount = report.messages.length;
        this.reportTracker.cancelReport(senderId);

        await sendReply(`\u{1f6ab} *\u05d4\u05d3\u05d9\u05d5\u05d5\u05d7 \u05d1\u05d5\u05d8\u05dc.*\n${messageCount} \u05d4\u05d5\u05d3\u05e2\u05d5\u05ea \u05e0\u05de\u05d7\u05e7\u05d5 \u05d5\u05dc\u05d0 \u05e0\u05e9\u05de\u05e8\u05d5.`);
    }

    private async handleStats(sendReply: (text: string) => Promise<void>): Promise<void> {
        try {
            const data = await this.client.getStats();

            const statsText = [
                '\u{1f4c8} *\u05e1\u05d8\u05d8\u05d9\u05e1\u05d8\u05d9\u05e7\u05d5\u05ea \u05d4\u05de\u05e2\u05e8\u05db\u05ea:*',
                '',
                `\u{1f4ac} \u05d4\u05d5\u05d3\u05e2\u05d5\u05ea: ${data.messages}`,
                `\u{1f4cd} \u05de\u05d9\u05e7\u05d5\u05de\u05d9\u05dd: ${data.locations}`,
                `\u{1f4cb} \u05d3\u05d9\u05d5\u05d5\u05d7\u05d9\u05dd: ${data.reports.total} (\u2705 ${data.reports.complete} \u05ea\u05e7\u05d9\u05e0\u05d9\u05dd, \u26a0\ufe0f ${data.reports.invalid} \u05dc\u05dc\u05d0 \u05de\u05d9\u05e7\u05d5\u05dd)`,
                `\u{1f465} \u05e7\u05d1\u05d5\u05e6\u05d5\u05ea: ${data.groups?.length ?? 0}`,
            ].join('\n');

            await sendReply(statsText);
        } catch (error: any) {
            logger.error({ error: error.message }, 'Failed to fetch stats');
            await sendReply('\u274c *\u05e9\u05d2\u05d9\u05d0\u05d4 \u05d1\u05d8\u05e2\u05d9\u05e0\u05ea \u05e0\u05ea\u05d5\u05e0\u05d9\u05dd.* \u05d4\u05e9\u05d9\u05e8\u05d5\u05ea \u05d0\u05d9\u05e0\u05d5 \u05d6\u05de\u05d9\u05df \u05db\u05e8\u05d2\u05e2.');
        }
    }

    private async handleLast(senderId: string, sendReply: (text: string) => Promise<void>): Promise<void> {
        try {
            const data = await this.client.getReports({ sender_id: senderId });

            const reports = data.reports;
            if (!reports || reports.length === 0) {
                await sendReply('\u2139\ufe0f *\u05dc\u05d0 \u05e0\u05de\u05e6\u05d0\u05d5 \u05d3\u05d9\u05d5\u05d5\u05d7\u05d9\u05dd \u05e7\u05d5\u05d3\u05de\u05d9\u05dd \u05e9\u05dc\u05da.*');
                return;
            }

            const last = reports[0];
            const startDate = new Date(last.started_at);
            const dateStr = startDate.toLocaleDateString('he-IL');
            const timeStr = startDate.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
            const statusEmoji = last.status === 'complete' ? '\u2705' : '\u26a0\ufe0f';
            const statusLabel = last.status === 'complete' ? '\u05ea\u05e7\u05d9\u05df' : '\u05dc\u05dc\u05d0 \u05de\u05d9\u05e7\u05d5\u05dd';
            const locationStr = last.latitude && last.longitude
                ? `\u{1f4cd} ${last.latitude.toFixed(5)}, ${last.longitude.toFixed(5)}`
                : '\u{1f4cd} \u05dc\u05dc\u05d0 \u05de\u05d9\u05e7\u05d5\u05dd';

            const lines = [
                '\u{1f4cb} *\u05d4\u05d3\u05d9\u05d5\u05d5\u05d7 \u05d4\u05d0\u05d7\u05e8\u05d5\u05df \u05e9\u05dc\u05da:*',
                '',
                `\u{1f4c5} \u05ea\u05d0\u05e8\u05d9\u05da: ${dateStr} ${timeStr}`,
                `${statusEmoji} \u05e1\u05d8\u05d8\u05d5\u05e1: ${statusLabel}`,
                `\u{1f4ac} \u05d4\u05d5\u05d3\u05e2\u05d5\u05ea: ${last.message_count}`,
                locationStr,
            ];

            if (last.location_name) {
                lines.push(`\u{1f4cc} ${last.location_name}`);
            }

            await sendReply(lines.join('\n'));
        } catch (error: any) {
            logger.error({ error: error.message }, 'Failed to fetch last report');
            await sendReply('\u274c *\u05e9\u05d2\u05d9\u05d0\u05d4 \u05d1\u05d8\u05e2\u05d9\u05e0\u05ea \u05d4\u05d3\u05d9\u05d5\u05d5\u05d7 \u05d4\u05d0\u05d7\u05e8\u05d5\u05df.* \u05d4\u05e9\u05d9\u05e8\u05d5\u05ea \u05d0\u05d9\u05e0\u05d5 \u05d6\u05de\u05d9\u05df \u05db\u05e8\u05d2\u05e2.');
        }
    }

    private async handleQuiet(groupId: string, sendReply: (text: string) => Promise<void>): Promise<void> {
        const mode = this.getOrCreateMode(groupId);
        mode.quiet = !mode.quiet;

        if (mode.quiet) {
            await sendReply('\u{1f507} *\u05de\u05e6\u05d1 \u05e9\u05e7\u05d8 \u05d4\u05d5\u05e4\u05e2\u05dc.*\n\u05d4\u05d1\u05d5\u05d8 \u05d9\u05de\u05e9\u05d9\u05da \u05dc\u05e2\u05d1\u05d3 \u05d4\u05d5\u05d3\u05e2\u05d5\u05ea \u05d0\u05da \u05dc\u05d0 \u05d9\u05e9\u05dc\u05d7 \u05ea\u05d2\u05d5\u05d1\u05d5\u05ea.');
        } else {
            await sendReply('\u{1f50a} *\u05de\u05e6\u05d1 \u05e9\u05e7\u05d8 \u05db\u05d5\u05d1\u05d4.*\n\u05d4\u05d1\u05d5\u05d8 \u05d9\u05d7\u05d6\u05d5\u05e8 \u05dc\u05e9\u05dc\u05d5\u05d7 \u05ea\u05d2\u05d5\u05d1\u05d5\u05ea.');
        }
    }

    private async handleStop(groupId: string, sendReply: (text: string) => Promise<void>): Promise<void> {
        const mode = this.getOrCreateMode(groupId);

        if (mode.stopped) {
            await sendReply('\u2139\ufe0f *\u05d4\u05d1\u05d5\u05d8 \u05db\u05d1\u05e8 \u05de\u05d5\u05e9\u05d4\u05d4 \u05d1\u05e7\u05d1\u05d5\u05e6\u05d4 \u05d6\u05d5.*\n\u05e9\u05dc\u05d7 /start \u05dc\u05d4\u05e4\u05e2\u05dc\u05d4 \u05de\u05d7\u05d3\u05e9.');
            return;
        }

        mode.stopped = true;
        await sendReply('\u23f8\ufe0f *\u05d4\u05d1\u05d5\u05d8 \u05d4\u05d5\u05e9\u05d4\u05d4.*\n\u05dc\u05d0 \u05d9\u05ea\u05d1\u05e6\u05e2 \u05e2\u05d9\u05d1\u05d5\u05d3 \u05d4\u05d5\u05d3\u05e2\u05d5\u05ea \u05d1\u05e7\u05d1\u05d5\u05e6\u05d4 \u05d6\u05d5 \u05e2\u05d3 \u05dc\u05d4\u05e4\u05e2\u05dc\u05d4 \u05de\u05d7\u05d3\u05e9 (/start).');
    }

    private async handleStart(groupId: string, sendReply: (text: string) => Promise<void>): Promise<void> {
        const mode = this.getOrCreateMode(groupId);

        if (!mode.stopped) {
            await sendReply('\u2139\ufe0f *\u05d4\u05d1\u05d5\u05d8 \u05db\u05d1\u05e8 \u05e4\u05e2\u05d9\u05dc \u05d1\u05e7\u05d1\u05d5\u05e6\u05d4 \u05d6\u05d5.*');
            return;
        }

        mode.stopped = false;
        await sendReply('\u25b6\ufe0f *\u05d4\u05d1\u05d5\u05d8 \u05d4\u05d5\u05e4\u05e2\u05dc \u05de\u05d7\u05d3\u05e9.*\n\u05e2\u05d9\u05d1\u05d5\u05d3 \u05d4\u05d5\u05d3\u05e2\u05d5\u05ea \u05d7\u05d6\u05e8 \u05dc\u05e4\u05e2\u05d5\u05dc\u05d4.');
    }

    private getTodayDate(): string {
        return new Date().toISOString().split('T')[0];
    }

    private getGroupFilterParams(parsed: ParsedMessage) {
        return { group: parsed.groupName || '', from_date: this.getTodayDate() };
    }

    private async handleExport(parsed: ParsedMessage, sendReply: (text: string) => Promise<void>): Promise<void> {
        if (!this.adapter) {
            await sendReply('\u274c *\u05e9\u05d2\u05d9\u05d0\u05d4: \u05d4\u05d1\u05d5\u05d8 \u05dc\u05d0 \u05de\u05d7\u05d5\u05d1\u05e8.*');
            return;
        }

        const today = this.getTodayDate();

        try {
            await sendReply('\u23f3 *\u05de\u05d9\u05d9\u05e6\u05d0 \u05e0\u05ea\u05d5\u05e0\u05d9\u05dd...*');

            const result = await this.client.exportFile('/export/kml', this.getGroupFilterParams(parsed));

            if (!result || result.status === 404) {
                await sendReply('\u2139\ufe0f *\u05d0\u05d9\u05df \u05e0\u05ea\u05d5\u05e0\u05d9\u05dd \u05dc\u05d9\u05d9\u05e6\u05d5\u05d0 \u05dc\u05d4\u05d9\u05d5\u05dd \u05d1\u05e7\u05d1\u05d5\u05e6\u05d4 \u05d6\u05d5.*');
                return;
            }

            await this.adapter.sendFileMessage(
                parsed.groupId,
                result.data,
                `export_${today}.kml`,
                'application/vnd.google-earth.kml+xml'
            );
            await sendReply(`\u2705 *\u05e7\u05d5\u05d1\u05e5 KML \u05e0\u05e9\u05dc\u05d7* \u2014 \u05d3\u05d9\u05d5\u05d5\u05d7\u05d9 ${today} \u05d1\u05e7\u05d1\u05d5\u05e6\u05d4 \u05d6\u05d5.`);
        } catch (error: any) {
            logger.error({ error: error.message, groupId: parsed.groupId }, 'Failed to export KML');
            if (error.code === 'ECONNREFUSED') {
                await sendReply('\u274c *\u05e9\u05d2\u05d9\u05d0\u05d4 \u05d1\u05d9\u05d9\u05e6\u05d5\u05d0.* \u05e9\u05d9\u05e8\u05d5\u05ea \u05d4\u05e2\u05d9\u05d1\u05d5\u05d3 \u05d0\u05d9\u05e0\u05d5 \u05d6\u05de\u05d9\u05df.');
            } else {
                await sendReply('\u274c *\u05e9\u05d2\u05d9\u05d0\u05d4 \u05d1\u05d9\u05d9\u05e6\u05d5\u05d0 \u05e7\u05d5\u05d1\u05e5 KML.*');
            }
        }
    }

    private static MAP_STYLE_ALIASES: Record<string, string> = {
        'street': 'street', '\u05e8\u05d7\u05d5\u05d1\u05d5\u05ea': 'street',
        'satellite': 'satellite', '\u05dc\u05d5\u05d5\u05d9\u05d9\u05df': 'satellite', 'sat': 'satellite',
        'topo': 'topo', '\u05d8\u05d5\u05e4\u05d5': 'topo',
        'dark': 'dark', '\u05db\u05d4\u05d4': 'dark',
        'terrain': 'terrain', '\u05e9\u05d8\u05d7': 'terrain',
    };

    private parseMapStyle(text: string | undefined): string {
        if (!text) return 'street';
        const parts = text.trim().split(/\s+/);
        if (parts.length < 2) return 'street';
        const arg = parts[1].toLowerCase();
        return CommandHandler.MAP_STYLE_ALIASES[arg] || 'street';
    }

    private async handleMap(parsed: ParsedMessage, sendReply: (text: string) => Promise<void>): Promise<void> {
        if (!this.adapter) {
            await sendReply('\u274c *\u05e9\u05d2\u05d9\u05d0\u05d4: \u05d4\u05d1\u05d5\u05d8 \u05dc\u05d0 \u05de\u05d7\u05d5\u05d1\u05e8.*');
            return;
        }

        const style = this.parseMapStyle(parsed.text);

        try {
            await sendReply(`\u23f3 *\u05de\u05d9\u05d9\u05e6\u05e8 \u05de\u05e4\u05d4 (${style})...*`);

            const params = { ...this.getGroupFilterParams(parsed), style };
            const result = await this.client.exportFile('/export/map-image', params);

            if (!result || result.status === 404) {
                await sendReply('\u2139\ufe0f *\u05d0\u05d9\u05df \u05de\u05d9\u05e7\u05d5\u05de\u05d9\u05dd \u05dc\u05d4\u05d9\u05d5\u05dd \u05d1\u05e7\u05d1\u05d5\u05e6\u05d4 \u05d6\u05d5.*');
                return;
            }

            await this.adapter.sendFileMessage(
                parsed.groupId,
                result.data,
                `map_${style}_${this.getTodayDate()}.png`,
                'image/png'
            );
        } catch (error: any) {
            logger.error({ error: error.message, groupId: parsed.groupId }, 'Failed to generate map image');
            if (error.code === 'ECONNREFUSED') {
                await sendReply('\u274c *\u05e9\u05d2\u05d9\u05d0\u05d4.* \u05e9\u05d9\u05e8\u05d5\u05ea \u05d4\u05e2\u05d9\u05d1\u05d5\u05d3 \u05d0\u05d9\u05e0\u05d5 \u05d6\u05de\u05d9\u05df.');
            } else {
                await sendReply('\u274c *\u05e9\u05d2\u05d9\u05d0\u05d4 \u05d1\u05d9\u05e6\u05d9\u05e8\u05ea \u05ea\u05de\u05d5\u05e0\u05ea \u05d4\u05de\u05e4\u05d4.*');
            }
        }
    }

    private async handlePins(parsed: ParsedMessage, sendReply: (text: string) => Promise<void>): Promise<void> {
        try {
            const data = await this.client.getLocations(this.getGroupFilterParams(parsed));

            const locations = data.locations;
            if (!locations || locations.length === 0) {
                await sendReply('\u2139\ufe0f *\u05d0\u05d9\u05df \u05de\u05d9\u05e7\u05d5\u05de\u05d9\u05dd \u05dc\u05d4\u05d9\u05d5\u05dd \u05d1\u05e7\u05d1\u05d5\u05e6\u05d4 \u05d6\u05d5.*');
                return;
            }

            const lines = [`\u{1f4cd} *${locations.length} \u05de\u05d9\u05e7\u05d5\u05de\u05d9\u05dd \u05de\u05d4\u05d9\u05d5\u05dd:*`, ''];
            for (const loc of locations) {
                const name = loc.name || loc.sender_name || `\u05de\u05d9\u05e7\u05d5\u05dd ${loc.id}`;
                const time = loc.timestamp ? new Date(loc.timestamp).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '';
                const link = `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
                lines.push(`\u{1f4cc} *${name}* ${time}\n${link}`);
            }

            await sendReply(lines.join('\n'));
        } catch (error: any) {
            logger.error({ error: error.message }, 'Failed to fetch pins');
            if (error.code === 'ECONNREFUSED') {
                await sendReply('\u274c *\u05e9\u05d2\u05d9\u05d0\u05d4.* \u05e9\u05d9\u05e8\u05d5\u05ea \u05d4\u05e2\u05d9\u05d1\u05d5\u05d3 \u05d0\u05d9\u05e0\u05d5 \u05d6\u05de\u05d9\u05df.');
            } else {
                await sendReply('\u274c *\u05e9\u05d2\u05d9\u05d0\u05d4 \u05d1\u05d8\u05e2\u05d9\u05e0\u05ea \u05d4\u05de\u05d9\u05e7\u05d5\u05de\u05d9\u05dd.*');
            }
        }
    }

    private async handleHtml(parsed: ParsedMessage, sendReply: (text: string) => Promise<void>): Promise<void> {
        if (!this.adapter) {
            await sendReply('\u274c *\u05e9\u05d2\u05d9\u05d0\u05d4: \u05d4\u05d1\u05d5\u05d8 \u05dc\u05d0 \u05de\u05d7\u05d5\u05d1\u05e8.*');
            return;
        }

        try {
            const result = await this.client.exportFile('/export/map-html', this.getGroupFilterParams(parsed));

            if (!result || result.status === 404) {
                await sendReply('\u2139\ufe0f *\u05d0\u05d9\u05df \u05de\u05d9\u05e7\u05d5\u05de\u05d9\u05dd \u05dc\u05d4\u05d9\u05d5\u05dd \u05d1\u05e7\u05d1\u05d5\u05e6\u05d4 \u05d6\u05d5.*');
                return;
            }

            await this.adapter.sendFileMessage(
                parsed.groupId,
                result.data,
                `map_${this.getTodayDate()}.html`,
                'text/html'
            );
            await sendReply('\u{1f5fa}\ufe0f *\u05de\u05e4\u05d4 \u05d0\u05d9\u05e0\u05d8\u05e8\u05d0\u05e7\u05d8\u05d9\u05d1\u05d9\u05ea \u05e0\u05e9\u05dc\u05d7\u05d4.* \u05e4\u05ea\u05d7 \u05d0\u05ea \u05d4\u05e7\u05d5\u05d1\u05e5 \u05d1\u05d3\u05e4\u05d3\u05e4\u05df.');
        } catch (error: any) {
            logger.error({ error: error.message, groupId: parsed.groupId }, 'Failed to generate HTML map');
            if (error.code === 'ECONNREFUSED') {
                await sendReply('\u274c *\u05e9\u05d2\u05d9\u05d0\u05d4.* \u05e9\u05d9\u05e8\u05d5\u05ea \u05d4\u05e2\u05d9\u05d1\u05d5\u05d3 \u05d0\u05d9\u05e0\u05d5 \u05d6\u05de\u05d9\u05df.');
            } else {
                await sendReply('\u274c *\u05e9\u05d2\u05d9\u05d0\u05d4 \u05d1\u05d9\u05e6\u05d9\u05e8\u05ea \u05de\u05e4\u05ea HTML.*');
            }
        }
    }

    private async handleImport(parsed: ParsedMessage, platformMsg: any, sendReply: (text: string) => Promise<void>): Promise<void> {
        if (!this.adapter) {
            await sendReply('\u274c *\u05e9\u05d2\u05d9\u05d0\u05d4: \u05d4\u05d1\u05d5\u05d8 \u05dc\u05d0 \u05de\u05d7\u05d5\u05d1\u05e8.*');
            return;
        }

        try {
            const media = await this.adapter.getQuotedMessageMedia(platformMsg);

            if (!media) {
                await sendReply('\u2139\ufe0f *\u05d4\u05e9\u05d1 \u05e2\u05dc \u05e7\u05d5\u05d1\u05e5 KML \u05e2\u05dd /import \u05db\u05d3\u05d9 \u05dc\u05d9\u05d9\u05d1\u05d0 \u05d0\u05d5\u05ea\u05d5.*');
                return;
            }

            const filename = media.filename || 'import.kml';
            const isKml = filename.toLowerCase().endsWith('.kml') ||
                          media.mimetype?.includes('kml') ||
                          media.mimetype?.includes('xml');

            if (!isKml) {
                await sendReply('\u274c *\u05d4\u05e7\u05d5\u05d1\u05e5 \u05d0\u05d9\u05e0\u05d5 KML.* \u05e0\u05d0 \u05dc\u05e9\u05dc\u05d5\u05d7 \u05e7\u05d5\u05d1\u05e5 \u05d1\u05e4\u05d5\u05e8\u05de\u05d8 .kml');
                return;
            }

            await sendReply('\u23f3 *\u05de\u05d9\u05d9\u05d1\u05d0 \u05e7\u05d5\u05d1\u05e5 KML...*');

            const result = await this.client.importKml({
                kml_data: media.data,
                filename,
                group_id: parsed.groupId,
                group_name: parsed.groupName,
                sender_id: parsed.senderId,
                sender_name: parsed.senderName,
            });

            const parts = [`\u2705 *\u05d9\u05d1\u05d5\u05d0 KML \u05d4\u05d5\u05e9\u05dc\u05dd \u2014 ${filename}*`];
            if (result.points_imported > 0) {
                parts.push(`\u{1f4cd} \u05e0\u05e7\u05d5\u05d3\u05d5\u05ea: ${result.points_imported}`);
            }
            if (result.tracks_imported > 0) {
                parts.push(`\u{1f6e4}\ufe0f \u05de\u05e1\u05dc\u05d5\u05dc\u05d9\u05dd: ${result.tracks_imported}`);
            }
            if (result.points_imported === 0 && result.tracks_imported === 0) {
                parts.push('\u26a0\ufe0f \u05dc\u05d0 \u05e0\u05de\u05e6\u05d0\u05d5 \u05e0\u05ea\u05d5\u05e0\u05d9\u05dd \u05d2\u05d9\u05d0\u05d5\u05d2\u05e8\u05e4\u05d9\u05d9\u05dd \u05d1\u05e7\u05d5\u05d1\u05e5.');
            }

            await sendReply(parts.join('\n'));
        } catch (error: any) {
            logger.error({ error: error.message, groupId: parsed.groupId }, 'Failed to import KML');
            if (error.code === 'ECONNREFUSED') {
                await sendReply('\u274c *\u05e9\u05d2\u05d9\u05d0\u05d4.* \u05e9\u05d9\u05e8\u05d5\u05ea \u05d4\u05e2\u05d9\u05d1\u05d5\u05d3 \u05d0\u05d9\u05e0\u05d5 \u05d6\u05de\u05d9\u05df.');
            } else {
                await sendReply('\u274c *\u05e9\u05d2\u05d9\u05d0\u05d4 \u05d1\u05d9\u05d1\u05d5\u05d0 \u05e7\u05d5\u05d1\u05e5 KML.*');
            }
        }
    }
}
