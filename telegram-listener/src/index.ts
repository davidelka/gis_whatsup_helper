import { Bot } from 'grammy';
import axios from 'axios';
import {
    loadConfig,
    getPythonServiceUrl,
    logger,
    PythonServiceClient,
    Config,
    TargetGroup,
} from '@gis-bot/shared';
import { TelegramMessageHandler } from './messageHandler';

/** Fire-and-forget POST auth state to management server */
function postAuth(baseUrl: string, data: Record<string, any>) {
    axios.post(`${baseUrl}/api/services/telegram/auth`, data, { timeout: 3000 }).catch(() => {});
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

    const token = config.telegram?.bot_token;
    if (!token || token === 'YOUR_BOT_TOKEN_HERE') {
        logger.error('Telegram bot_token not configured. Set it via the management UI or config.yaml');
        postAuth(pythonServiceUrl, { status: 'disconnected', error: 'no_token' });
        process.exit(1);
    }

    const pythonClient = new PythonServiceClient(pythonServiceUrl);

    // Fetch target groups from management server
    let targetGroups: TargetGroup[] = [];
    let targetGroupIds = new Set<string>();
    let allowDMs = config.telegram?.allow_direct_messages ?? false;

    try {
        targetGroups = await pythonClient.getTargetGroups('telegram');
        targetGroupIds = new Set(targetGroups.filter(g => g.is_active).map(g => g.group_id));
        logger.info({
            groupCount: targetGroupIds.size,
            groups: targetGroups.map(g => g.group_name),
            allowDMs
        }, 'Target groups loaded from management server');
    } catch (error: any) {
        logger.warn({ error: error.message }, 'Could not fetch groups from management server');
    }

    // Create bot
    const bot = new Bot(token);

    // Create message handler
    const messageHandler = new TelegramMessageHandler(
        bot,
        pythonClient,
        config.telegram?.report_timeout_seconds || 120
    );

    // Handle all message types
    bot.on('message', async (ctx) => {
        const chat = ctx.message.chat;
        const chatId = String(chat.id);

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
