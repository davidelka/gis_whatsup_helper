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
    target_groups: GroupConfig[];  // Legacy, migrated to DB on first run
}

export interface TelegramConfig {
    bot_token: string;
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

export function loadConfig(configDir?: string): Config {
    const configPath = configDir
        ? path.resolve(configDir, 'config.yaml')
        : path.resolve(__dirname, '../../../config.yaml');

    if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
    }

    const configContent = fs.readFileSync(configPath, 'utf8');
    const config = yaml.load(configContent) as Config;

    return config;
}

export function getPythonServiceUrl(config: Config): string {
    return `http://${config.python_service.host}:${config.python_service.port}`;
}
