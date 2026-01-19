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

export interface Config {
    whatsapp: {
        report_timeout_seconds: number;
        target_groups: GroupConfig[];
    };
    python_service: PythonServiceConfig;
    storage: StorageConfig;
    logging: LoggingConfig;
}

export function loadConfig(): Config {
    const configPath = path.resolve(__dirname, '../../config.yaml');

    if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
    }

    const configContent = fs.readFileSync(configPath, 'utf8');
    const config = yaml.load(configContent) as Config;

    return config;
}

export function getTargetGroupIds(config: Config): Set<string> {
    return new Set(config.whatsapp.target_groups.map(g => g.id));
}
