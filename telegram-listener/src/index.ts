import { Bot } from 'grammy';
import axios from 'axios';
import {
    loadConfig,
    getPythonServiceUrl,
    getTelegramToken,
    getApiKey,
    logger,
    PythonServiceClient,
    Config,
    TargetGroup,
} from '@gis-bot/shared';
import { TelegramMessageHandler } from './messageHandler';

/** Fire-and-forget POST auth state to management server */
function postAuth(baseUrl: string, data: Record<string, any>) {
    const headers: Record<string, string> = {};
    const key = getApiKey();
    if (key) headers['X-API-Key'] = key;
    axios.post(`${baseUrl}/api/services/telegram/auth`, data, { timeout: 3000, headers }).catch(() => {});
}

async function startBot() {
    // Load configuration
    let config: Config;
    try {
        config = loadConfig();
        logger.info('Configuration loaded successfully');
    } catch (error) {
        logger.error({ error }, 'Failed to load configuration');
        process.exit(1);
    }

    const pythonServiceUrl = getPythonServiceUrl(config);

    const token = getTelegramToken();
    if (!token || token === 'YOUR_BOT_TOKEN_HERE') {
        logger.error('TELEGRAM_BOT_TOKEN not set. Set it via the management UI or .env file');
        postAuth(pythonServiceUrl, { status: 'disconnected', error: 'no_token' });
        process.exit(1);
    }

    const pythonClient = new PythonServiceClient(pythonServiceUrl, getApiKey());

    // Fetch target groups from management server
    let targetGroupIds = new Set<string>();
    let allowDMs = config.telegram?.allow_direct_messages ?? false;

    async function refreshTargetGroups() {
        try {
            const groups = await pythonClient.getTargetGroups('telegram');
            targetGroupIds = new Set(groups.filter(g => g.is_active).map(g => g.group_id));
            logger.debug({ groupCount: targetGroupIds.size }, 'Target groups refreshed');
        } catch (error: any) {
            logger.warn({ error: error.message }, 'Could not fetch groups from management server');
        }
    }

    await refreshTargetGroups();
    // Refresh groups every 60 seconds
    setInterval(refreshTargetGroups, 60000);

    // Create bot
    const bot = new Bot(token);

    // Create message handler
    const messageHandler = new TelegramMessageHandler(
        bot,
        pythonClient,
        config.telegram?.report_timeout_seconds || 120
    );

    // Handle all message types
    // Track discovered groups so the UI can show them
    const discoveredGroupIds = new Set<string>();

    bot.on('message', async (ctx) => {
        const chat = ctx.message.chat;
        const chatId = String(chat.id);

        // Report new groups to management server for discovery
        if (chat.type !== 'private' && !discoveredGroupIds.has(chatId)) {
            discoveredGroupIds.add(chatId);
            const groupName = 'title' in chat ? chat.title || chatId : chatId;
            const discHeaders: Record<string, string> = {};
            const discKey = getApiKey();
            if (discKey) discHeaders['X-API-Key'] = discKey;
            axios.post(`${pythonServiceUrl}/api/services/telegram/discovered-groups`, {
                group: { id: chatId, name: groupName }
            }, { timeout: 3000, headers: discHeaders }).then(() => {
                logger.info({ chatId, groupName }, 'Discovered group reported to management server');
            }).catch((err: any) => {
                logger.warn({ chatId, error: err.message }, 'Failed to report discovered group');
            });
        }

        if (chat.type === 'private') {
            if (!allowDMs) {
                logger.debug({ chatId, from: ctx.message.from?.first_name }, 'DM ignored (not enabled)');
                return;
            }
        } else {
            if (targetGroupIds.size > 0 && !targetGroupIds.has(chatId)) {
                logger.debug({ chatId, chatName: 'title' in chat ? chat.title : chatId }, 'Message from non-target group, skipping');
                return;
            }
        }

        await messageHandler.handleMessage(ctx);
    });

    // Error handler
    bot.catch((err) => {
        logger.error({ error: err.message, stack: err.stack }, 'Bot error');
        postAuth(pythonServiceUrl, { status: 'auth_failure' });
    });

    // Start polling
    logger.info('Starting Telegram bot (long polling)...');
    bot.start({
        onStart: (info) => {
            logger.info({ username: info.username }, 'Telegram bot is running!');
            postAuth(pythonServiceUrl, { status: 'authenticated', bot_username: info.username });
        },
    });

    return bot;
}

let activeBot: Bot | null = null;

const shutdown = async () => {
    logger.info('Shutting down Telegram bot...');
    if (activeBot) {
        activeBot.stop();
        logger.info('Telegram bot stopped.');
    }
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

logger.info('Starting Telegram GIS Listener Bot...');
startBot().then(bot => {
    activeBot = bot;
}).catch((error) => {
    logger.error({ error }, 'Failed to start Telegram bot');
    process.exit(1);
});
