import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import * as path from 'path';
import * as fs from 'fs';

import { loadConfig, getTargetGroupIds, Config } from './config';
import { MessageHandler } from './messageHandler';
import { logger } from './logger';

/** Race a promise against a timeout. Rejects with Error on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        )
    ]);
}

async function startBot(): Promise<Client> {
    // Load configuration
    let config: Config;
    try {
        config = loadConfig();
        logger.info('Configuration loaded successfully');
    } catch (error) {
        logger.error({ error }, 'Failed to load configuration');
        process.exit(1);
    }

    const targetGroups = getTargetGroupIds(config);
    logger.info({
        groupCount: targetGroups.size,
        groups: config.whatsapp.target_groups.map(g => g.name)
    }, 'Target groups configured');

    // Create message handler
    const messageHandler = new MessageHandler(config);

    // Create WhatsApp client
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: 'gis-bot',
            dataPath: path.resolve(__dirname, '../auth_info'),
            // Recover from session lock conflicts (prevents silent hangs)
        }),
        webVersionCache: {
            type: 'none',
        },
        takeoverOnConflict: true,
        takeoverTimeoutMs: 10000,
        puppeteer: {
            executablePath: '/snap/bin/chromium',
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-extensions',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--mute-audio',
                '--disable-features=site-per-process',
                '--disable-gl-drawing-for-tests'
            ],
            handleSIGINT: false,
            protocolTimeout: 60000,        // 60s protocol timeout (was 0 = infinite, causing silent hangs)
        }
    });

    // Link client to message handler
    messageHandler.setClient(client);

    // Startup watchdog: if neither 'qr' nor 'ready' fires within 90s, bail out with a clear error
    let startupResolved = false;
    const startupWatchdog = setTimeout(() => {
        if (!startupResolved) {
            logger.error(
                'Startup watchdog: no QR or ready event within 90 seconds. ' +
                'Possible causes: stale auth_info session, lingering Chromium process, ' +
                'or whatsapp-web.js incompatibility with current WhatsApp Web version. ' +
                'Try: rm -rf auth_info/session && npm run dev'
            );
            process.exit(1);
        }
    }, 90000);

    // QR Code display
    client.on('qr', (qr) => {
        startupResolved = true;
        clearTimeout(startupWatchdog);
        logger.info('Scan the QR code below with your WhatsApp app:');
        console.log('\n');
        qrcode.generate(qr, { small: true });
        console.log('\n');
    });

    // Log loading screen progress (helps diagnose where it freezes)
    client.on('loading_screen', (percent, message) => {
        logger.info({ percent, message }, 'Loading WhatsApp Web...');
    });

    // Authentication
    client.on('authenticated', () => {
        logger.info('✅ Authenticated successfully!');
    });

    client.on('auth_failure', (msg) => {
        logger.error({ msg }, '❌ Authentication failure');
    });

    // Connection
    client.on('ready', async () => {
        startupResolved = true;
        clearTimeout(startupWatchdog);
        logger.info('✅ WhatsApp GIS Listener is ready!');

        // List all groups for discovery
        // Delay to let WhatsApp Web internal stores finish initializing
        await new Promise(resolve => setTimeout(resolve, 5000));
        try {
            logger.info('Searching for groups specified in config (this may take a while if you have many chats)...');
            const chats = await Promise.race([
                client.getChats(),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('getChats() timed out after 15s')), 15000)
                )
            ]);
            const allGroups = chats.filter(chat => chat.isGroup);

            logger.info('--- Group Discovery ---');
            for (const targetGroup of config.whatsapp.target_groups) {
                const foundGroup = allGroups.find(g => g.name === targetGroup.name);
                if (foundGroup) {
                    logger.info({
                        configName: targetGroup.name,
                        realName: foundGroup.name,
                        id: foundGroup.id._serialized
                    }, '✅ Group ID Found');
                } else {
                    logger.info({
                        configName: targetGroup.name
                    }, '❌ No such group found by name on WhatsApp');
                }
            }
            logger.info('-----------------------');
        } catch (error: any) {
            logger.warn({ error: error.message }, 'Could not list groups due to timeout. Fallback: Discovery via incoming messages is active.');
        }

        logger.info('Listening for messages from configured groups...');

        // Re-attach message listener on the current Store.Msg instance.
        // The library's attachEventListeners() runs before Store.Msg is finalized,
        // so its 'add' listener is on a stale collection reference.
        try {
            await (client as any).pupPage.evaluate(new Function(`
                window.Store.Msg.on('add', function(msg) {
                    if (msg.isNewMsg) {
                        if (msg.type === 'ciphertext') {
                            msg.once('change:type', function(_msg) {
                                window.onAddMessageEvent(window.WWebJS.getMessageModel(_msg));
                            });
                        } else {
                            window.onAddMessageEvent(window.WWebJS.getMessageModel(msg));
                        }
                    }
                });
            `));
            logger.info('Re-attached Store.Msg listener on final collection instance');
        } catch (e: any) {
            logger.error({ error: e.message }, 'Failed to re-attach Store.Msg listener');
        }
    });

    client.on('disconnected', (reason) => {
        logger.warn({ reason }, 'Disconnected from WhatsApp');
    });

    // Handle incoming and outgoing messages (for discovery and processing)
    client.on('message_create', async (msg: Message) => {
        // Log all incoming events (temporarily info-level for diagnostics)
        logger.info({
            fromMe: msg.fromMe,
            from: msg.from,
            type: msg.type,
            body: msg.body?.substring(0, 20)
        }, 'message_create event received');

        // In groups, msg.from is usually the group ID for incoming messages.
        // For outgoing messages, msg.to is the group ID.
        // We check both to find the group context.
        let chat;
        try {
            chat = await withTimeout(msg.getChat(), 8000, 'msg.getChat()');
        } catch (e: any) {
            logger.warn({ error: e.message, from: msg.from }, 'Skipping message: getChat() timed out or failed');
            return;
        }
        const groupId = chat.isGroup ? chat.id._serialized : null;

        if (groupId) {
            // Log for discovery
            logger.info({
                groupId,
                groupName: chat.name,
                messageType: msg.type,
                body: msg.body?.substring(0, 20)
            }, 'Group message detected');

            // Check if this group is one of our targets
            if (targetGroups.size > 0 && !targetGroups.has(groupId)) {
                // Not a target group, skip
                return;
            }

            // Map msg.from to the correct group ID for the handler if needed
            // But handleMessage should use the parsed object which we'll fix

            // Handle the message
            await messageHandler.handleMessage(msg);
        }
    });

    // Initialize client
    logger.info('🚀 Initializing WhatsApp Client (this may take a moment)...');
    client.initialize().catch((error) => {
        logger.error({
            error: error instanceof Error ? error.message : error,
            stack: error instanceof Error ? error.stack : undefined
        }, 'Failed to initialize client');
    });

    return client;
}

// Global variable for cleanup
let activeClient: Client | null = null;

// Handle graceful shutdown
const shutdown = async () => {
    logger.info('Shutting down gracefully...');
    if (activeClient) {
        try {
            await activeClient.destroy();
            logger.info('WhatsApp client destroyed.');
        } catch (error) {
            logger.error({ error }, 'Error destroying WhatsApp client');
        }
    }
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the bot
logger.info('🚀 Starting WhatsApp GIS Listener Bot...');
startBot().then(client => {
    activeClient = client;
}).catch((error) => {
    logger.error({ error }, 'Failed to start bot');
    process.exit(1);
});
