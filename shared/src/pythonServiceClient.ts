import axios from 'axios';
import { ParsedMessage } from './types';
import { ReportData } from './reportTracker';
import { logger } from './logger';

export interface TargetGroup {
    id: number;
    platform: string;
    group_id: string;
    group_name: string;
    is_active: boolean;
    is_dm: boolean;
}

export class PythonServiceClient {
    private baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    async forwardMessage(message: ParsedMessage): Promise<void> {
        try {
            const response = await axios.post(`${this.baseUrl}/message`, message, {
                timeout: 5000,
                headers: { 'Content-Type': 'application/json' }
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

    async forwardReport(report: ReportData): Promise<void> {
        try {
            const cleanReport = { ...report };
            delete (cleanReport as any).timeoutHandle;

            const response = await axios.post(`${this.baseUrl}/report`, cleanReport, {
                timeout: 10000,
                headers: { 'Content-Type': 'application/json' }
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

    async getTargetGroups(platform: string): Promise<TargetGroup[]> {
        try {
            const response = await axios.get(`${this.baseUrl}/api/groups`, {
                params: { platform },
                timeout: 5000
            });
            return response.data.groups || [];
        } catch (error: any) {
            logger.error({ error: error.message, platform }, 'Failed to fetch target groups from management server');
            return [];
        }
    }

    async getStats(): Promise<any> {
        const response = await axios.get(`${this.baseUrl}/stats`, { timeout: 5000 });
        return response.data;
    }

    async getReports(params: Record<string, string>): Promise<any> {
        const response = await axios.get(`${this.baseUrl}/reports`, { params, timeout: 5000 });
        return response.data;
    }

    async getLocations(params: Record<string, string>): Promise<any> {
        const response = await axios.get(`${this.baseUrl}/locations`, { params, timeout: 5000 });
        return response.data;
    }

    async exportFile(endpoint: string, params: Record<string, string>): Promise<{ status: number; data: Buffer } | null> {
        try {
            const response = await axios.get(`${this.baseUrl}${endpoint}`, {
                params,
                timeout: 15000,
                responseType: 'arraybuffer',
                validateStatus: (status) => status < 500,
            });
            return { status: response.status, data: Buffer.from(response.data) };
        } catch (error: any) {
            logger.error({ error: error.message, endpoint }, 'Failed to fetch export');
            throw error;
        }
    }

    async importKml(data: Record<string, any>): Promise<any> {
        const response = await axios.post(`${this.baseUrl}/import/kml`, data, {
            timeout: 30000,
            headers: { 'Content-Type': 'application/json' },
        });
        return response.data;
    }
}
