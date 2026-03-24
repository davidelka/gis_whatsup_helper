import { Bot } from 'grammy';
import {
    loadConfig,
    getPythonServiceUrl,
    logger,
    PythonServiceClient,
    Config,
    TargetGroup,
} from '@gis-bot/shared';
import { TelegramMessageHandler } from './messageHandler';

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

    if (!config.telegram?.bot_token) {
        logger.error('Telegram bot_token not configured in config.yaml');
        process.exit(1);
    }

    const pythonServiceUrl = getPythonServiceUrl(config);
    const pythonClient = new PythonServiceClient(pythonServiceUrl);

    // Fetch target groups from management server
    let targetGroups: TargetGroup[] = [];
    let targetGroupIds = new Set<string>();
    let allowDMs = config.telegram.allow_direct_messages ?? false;

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
    const bot = new Bot(config.telegram.bot_token);

    // Create message handler
    const messageHandler = new TelegramMessageHandler(
        bot,
        pythonClient,
        config.telegram.report_timeout_seconds || 120
    );

    // Handle all message types
    bot.on('message', async (ctx) => {
        const chat = ctx.message.chat;
        const chatId = String(chat.id);

        // Filter: only process messages from configured groups or DMs
        if (chat.type === 'private') {
            if (!allowDMs) {
                logger.debug({ chatId, from: ctx.message.from?.first_name }, 'DM ignored (not enabled)');
                return;
            }
        } else {
            // Group/supergroup message
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
    });

    // Start polling
    logger.info('Starting Telegram bot (long polling)...');
    bot.start({
        onStart: (info) => {
            logger.info({ username: info.username }, 'Telegram bot is running!');
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
