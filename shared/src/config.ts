import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface GroupConfig {
    name: string;
    id: string;
}

export interface PythonServiceConfig {
    host: string;
    port: number;
}

export interface StorageConfig {
    database: string;
    export_dir: string;
}

export interface LoggingConfig {
    level: string;
}

export interface WhatsAppConfig {
    report_timeout_seconds: number;
}

export interface TelegramConfig {
    report_timeout_seconds: number;
    allow_direct_messages: boolean;
}

export interface Config {
    whatsapp: WhatsAppConfig;
    telegram?: TelegramConfig;
    python_service: PythonServiceConfig;
    storage: StorageConfig;
    logging: LoggingConfig;
}

function findConfigFile(): string {
    const candidates = [
        path.resolve(process.cwd(), '../config.yaml'),
        path.resolve(process.cwd(), 'config.yaml'),
        path.resolve(__dirname, '../../../config.yaml'),
        path.resolve(__dirname, '../../config.yaml'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`Config file not found. Tried: ${candidates.join(', ')}`);
}

function findEnvFile(): string | null {
    const candidates = [
        path.resolve(process.cwd(), '../.env'),
        path.resolve(process.cwd(), '.env'),
        path.resolve(__dirname, '../../../.env'),
        path.resolve(__dirname, '../../.env'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

/** Load .env file into process.env (simple parser, no dependency needed) */
function loadEnvFile() {
    const envPath = findEnvFile();
    if (!envPath) return;

    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;
        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(eqIndex + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
}

export function loadConfig(configDir?: string): Config {
    // Load .env first so env vars are available
    loadEnvFile();

    const configPath = configDir
        ? path.resolve(configDir, 'config.yaml')
        : findConfigFile();

    if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
    }

    const configContent = fs.readFileSync(configPath, 'utf8');
    const config = yaml.load(configContent) as Config;

    return config;
}

export function getTelegramToken(): string | undefined {
    return process.env.TELEGRAM_BOT_TOKEN;
}

export function getApiKey(): string | undefined {
    return process.env.API_KEY;
}

export function getPythonServiceUrl(config: Config): string {
    return `http://${config.python_service.host}:${config.python_service.port}`;
}
