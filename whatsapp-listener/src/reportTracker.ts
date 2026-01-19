import { ParsedMessage, LocationData } from './messageHandler';
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
export const REPORT_START = 'תד';  // תחילת דיווח - Start Report
export const REPORT_END = 'סד';    // סוף דיווח - End Report

export type TimeoutEvent = 'warning' | 'closed';
export type TimeoutCallback = (report: ReportData, event: TimeoutEvent) => void;

export type ConfirmationType = 'start_new' | 'close_without_location';

export class ReportTracker {
    // Track active reports per sender (senderId -> ReportData)
    private activeReports: Map<string, ReportData> = new Map();
    // Track pending user confirmations per sender
    private pendingConfirmations: Map<string, ConfirmationType> = new Map();

    private timeoutSeconds: number;
    private gracePeriodSeconds: number = 60;
    private onTimeout?: TimeoutCallback;

    constructor(timeoutSeconds: number = 120, onTimeout?: TimeoutCallback) {
        this.timeoutSeconds = timeoutSeconds;
        this.onTimeout = onTimeout;
    }

    /**
     * Check if a message is a report command
     */
    isReportCommand(text: string | undefined): 'start' | 'end' | null {
        if (!text) return null;

        const trimmed = text.trim();
        if (trimmed === REPORT_START) return 'start';
        if (trimmed === REPORT_END) return 'end';
        return null;
    }

    /**
     * Start a new report for a sender
     */
    startReport(message: ParsedMessage, force: boolean = false): ReportData | null {
        // Prevent nested reports unless forced
        if (this.activeReports.has(message.senderId) && !force) {
            logger.warn({ senderId: message.senderId }, 'Attempted to start report but one is already active');
            return null;
        }

        // If forced, cancel the old report first
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

        // Store by sender ID (one active report per user)
        this.activeReports.set(message.senderId, report);
        this.clearPendingConfirmation(message.senderId);

        // Start initial timeout
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

            // Notify stage 1 (warning)
            if (this.onTimeout) {
                this.onTimeout(report, 'warning');
            }

            // Set final timeout for grace period
            report.timeoutHandle = setTimeout(() => {
                this.handleTimeoutStage2(senderId);
            }, this.gracePeriodSeconds * 1000);
        }
    }

    private handleTimeoutStage2(senderId: string) {
        const report = this.activeReports.get(senderId);
        if (report) {
            // Finalize report data
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

    /**
     * Add a message to an active report
     */
    addToReport(message: ParsedMessage): ReportData | null {
        const report = this.activeReports.get(message.senderId);

        if (!report) {
            // No active report for this sender
            return null;
        }

        // Add message to report
        report.messages.push(message);

        // If message has location, use it as the report location
        if (message.location) {
            report.location = message.location;
            logger.info({
                reportId: report.id,
                latitude: message.location.latitude,
                longitude: message.location.longitude
            }, 'Location added to report');
        }

        // Sliding timeout: reset timer on activity
        this.resetTimer(report);

        return report;
    }

    /**
     * End a report and return the completed data
     */
    endReport(message: ParsedMessage, force: boolean = false): ReportData | null {
        const report = this.activeReports.get(message.senderId);

        if (!report) {
            logger.warn({
                senderId: message.senderId
            }, 'Attempted to end report but no active report found');
            return null;
        }

        // Check if report has location (Validation)
        if (!report.location && !force) {
            logger.warn({ reportId: report.id }, 'Attempted to end report without location');
            return null; // Return null to indicate validation failure
        }

        // Clear timeout
        if (report.timeoutHandle) {
            clearTimeout(report.timeoutHandle);
        }

        // Remove from active reports
        this.activeReports.delete(message.senderId);
        this.clearPendingConfirmation(message.senderId);

        // Set end timestamp
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

    /**
     * Check if a sender has an active report
     */
    hasActiveReport(senderId: string): boolean {
        return this.activeReports.has(senderId);
    }

    /**
     * Get active report for a sender
     */
    getActiveReport(senderId: string): ReportData | undefined {
        return this.activeReports.get(senderId);
    }

    /**
     * Cancel an active report
     */
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

    // Confirmation logic
    setPendingConfirmation(senderId: string, type: ConfirmationType) {
        this.pendingConfirmations.set(senderId, type);
        // Auto-clear confirmation after 30 seconds if not used
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
