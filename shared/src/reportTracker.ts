import { ParsedMessage, LocationData } from './types';
import { logger } from './logger';

export interface ReportData {
    id: string;
    groupId: string;
    groupName?: string;
    senderId: string;
    senderName?: string;
    startedAt: number;
    endedAt?: number;
    messages: ParsedMessage[];
    location?: LocationData;
    status: 'open' | 'complete' | 'invalid';
    timeoutHandle?: NodeJS.Timeout;
    timerState?: 'active' | 'grace_period';
}

// Report keywords (Hebrew)
export const REPORT_START = '\u05ea\u05d3';  // Start Report
export const REPORT_END = '\u05e1\u05d3';    // End Report

export type TimeoutEvent = 'warning' | 'closed';
export type TimeoutCallback = (report: ReportData, event: TimeoutEvent) => void;

export type ConfirmationType = 'start_new' | 'close_without_location';

export class ReportTracker {
    private activeReports: Map<string, ReportData> = new Map();
    private pendingConfirmations: Map<string, ConfirmationType> = new Map();

    private timeoutSeconds: number;
    private gracePeriodSeconds: number = 60;
    private onTimeout?: TimeoutCallback;

    constructor(timeoutSeconds: number = 120, onTimeout?: TimeoutCallback) {
        this.timeoutSeconds = timeoutSeconds;
        this.onTimeout = onTimeout;
    }

    isReportCommand(text: string | undefined): 'start' | 'end' | null {
        if (!text) return null;
        const trimmed = text.trim();
        if (trimmed === REPORT_START) return 'start';
        if (trimmed === REPORT_END) return 'end';
        return null;
    }

    startReport(message: ParsedMessage, force: boolean = false): ReportData | null {
        if (this.activeReports.has(message.senderId) && !force) {
            logger.warn({ senderId: message.senderId }, 'Attempted to start report but one is already active');
            return null;
        }

        if (force) {
            this.cancelReport(message.senderId);
        }

        const reportId = `report_${message.senderId}_${Date.now()}`;

        const report: ReportData = {
            id: reportId,
            groupId: message.groupId,
            groupName: message.groupName,
            senderId: message.senderId,
            senderName: message.senderName,
            startedAt: message.timestamp,
            messages: [],
            status: 'open',
            timerState: 'active'
        };

        this.activeReports.set(message.senderId, report);
        this.clearPendingConfirmation(message.senderId);
        this.resetTimer(report);

        logger.info({
            reportId,
            senderId: message.senderId,
            senderName: message.senderName,
            timeout: this.timeoutSeconds,
            forced: force
        }, 'Report started');

        return report;
    }

    private resetTimer(report: ReportData) {
        if (report.timeoutHandle) {
            clearTimeout(report.timeoutHandle);
        }

        if (this.timeoutSeconds > 0) {
            report.timerState = 'active';
            report.timeoutHandle = setTimeout(() => {
                this.handleTimeoutStage1(report.senderId);
            }, this.timeoutSeconds * 1000);
        }
    }

    private handleTimeoutStage1(senderId: string) {
        const report = this.activeReports.get(senderId);
        if (report) {
            logger.warn({ reportId: report.id, senderId }, 'Report inactivity timeout - entering grace period');

            report.timerState = 'grace_period';
            if (report.timeoutHandle) clearTimeout(report.timeoutHandle);

            if (this.onTimeout) {
                this.onTimeout(report, 'warning');
            }

            report.timeoutHandle = setTimeout(() => {
                this.handleTimeoutStage2(senderId);
            }, this.gracePeriodSeconds * 1000);
        }
    }

    private handleTimeoutStage2(senderId: string) {
        const report = this.activeReports.get(senderId);
        if (report) {
            report.endedAt = Math.floor(Date.now() / 1000);
            report.status = report.location ? 'complete' : 'invalid';

            this.activeReports.delete(senderId);
            this.clearPendingConfirmation(senderId);
            logger.warn({ reportId: report.id, senderId }, 'Report grace period expired - auto-closing and saving');

            if (this.onTimeout) {
                this.onTimeout(report, 'closed');
            }
        }
    }

    addToReport(message: ParsedMessage): ReportData | null {
        const report = this.activeReports.get(message.senderId);

        if (!report) {
            return null;
        }

        report.messages.push(message);

        if (message.location) {
            report.location = message.location;
            logger.info({
                reportId: report.id,
                latitude: message.location.latitude,
                longitude: message.location.longitude
            }, 'Location added to report');
        }

        this.resetTimer(report);
        return report;
    }

    endReport(message: ParsedMessage, force: boolean = false): ReportData | null {
        const report = this.activeReports.get(message.senderId);

        if (!report) {
            logger.warn({ senderId: message.senderId }, 'Attempted to end report but no active report found');
            return null;
        }

        if (!report.location && !force) {
            logger.warn({ reportId: report.id }, 'Attempted to end report without location');
            return null;
        }

        if (report.timeoutHandle) {
            clearTimeout(report.timeoutHandle);
        }

        this.activeReports.delete(message.senderId);
        this.clearPendingConfirmation(message.senderId);

        report.endedAt = message.timestamp;
        report.status = report.location ? 'complete' : 'invalid';

        logger.info({
            reportId: report.id,
            messageCount: report.messages.length,
            hasLocation: !!report.location,
            forced: force
        }, 'Report ended');

        return report;
    }

    hasActiveReport(senderId: string): boolean {
        return this.activeReports.has(senderId);
    }

    getActiveReport(senderId: string): ReportData | undefined {
        return this.activeReports.get(senderId);
    }

    cancelReport(senderId: string): void {
        const report = this.activeReports.get(senderId);
        if (report) {
            if (report.timeoutHandle) {
                clearTimeout(report.timeoutHandle);
            }
            this.activeReports.delete(senderId);
            this.clearPendingConfirmation(senderId);
            logger.info({ reportId: report.id }, 'Report cancelled');
        }
    }

    setPendingConfirmation(senderId: string, type: ConfirmationType) {
        this.pendingConfirmations.set(senderId, type);
        setTimeout(() => {
            if (this.pendingConfirmations.get(senderId) === type) {
                this.pendingConfirmations.delete(senderId);
            }
        }, 30000);
    }

    getPendingConfirmation(senderId: string): ConfirmationType | undefined {
        return this.pendingConfirmations.get(senderId);
    }

    clearPendingConfirmation(senderId: string) {
        this.pendingConfirmations.delete(senderId);
    }
}
