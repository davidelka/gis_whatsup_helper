export { Config, GroupConfig, PythonServiceConfig, StorageConfig, LoggingConfig, loadConfig } from '@gis-bot/shared';

import { Config } from '@gis-bot/shared';

export function getTargetGroupIds(config: Config): Set<string> {
    return new Set((config.whatsapp.target_groups || []).map(g => g.id));
}
