import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import * as path from 'path';
import axios from 'axios';

import { loadConfig, getPythonServiceUrl, logger, PythonServiceClient, Config } from '@gis-bot/shared';
import { MessageHandler } from './messageHandler';

/** Fire-and-forget POST auth state to management server */
function postAuth(baseUrl: string, data: Record<string, any>) {
    axios.post(`${baseUrl}/api/services/whatsapp/auth`, data, { timeout: 3000 }).catch(() => {});
}

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

    const pythonServiceUrl = getPythonServiceUrl(config);
    const pythonClient = new PythonServiceClient(pythonServiceUrl);

    // Fetch target groups from management server
    let targetGroups = new Set<string>();
    try {
        const groups = await pythonClient.getTargetGroups('whatsapp');
        targetGroups = new Set(groups.filter(g => g.is_active).map(g => g.group_id));
        logger.info({ groupCount: targetGroups.size, groups: groups.map(g => g.group_name) }, 'Target groups loaded from management server');
    } catch (error: any) {
        logger.warn({ error: error.message }, 'Could not fetch groups from management server. No group filtering active.');
    }

    // Create message handler
    const messageHandler = new MessageHandler(config);

    // Create WhatsApp client
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: 'gis-bot',
            dataPath: path.resolve(__dirname, '../auth_info'),
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
            protocolTimeout: 60000,
        }
    });

    // Link client to message handler
    messageHandler.setClient(client);

    // Startup watchdog: if neither 'qr' nor 'ready' fires within 90s, bail out
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
    postAuth(pythonServiceUrl, { status: 'waiting_qr' });

    client.on('qr', (qr) => {
        startupResolved = true;
        clearTimeout(startupWatchdog);
        logger.info('QR code received — scan via management UI or below:');
        console.log('\n');
        qrcode.generate(qr, { small: true });
        console.log('\n');
        postAuth(pythonServiceUrl, { status: 'qr_ready', qr_data: qr });
    });

    // Log loading screen progress
    client.on('loading_screen', (percent, message) => {
        logger.info({ percent, message }, 'Loading WhatsApp Web...');
    });

    // Authentication
    client.on('authenticated', () => {
        logger.info('Authenticated successfully!');
        postAuth(pythonServiceUrl, { status: 'authenticated' });
    });

    client.on('auth_failure', (msg) => {
        logger.error({ msg }, 'Authentication failure');
        postAuth(pythonServiceUrl, { status: 'auth_failure' });
    });

    // Connection
    client.on('ready', async () => {
        startupResolved = true;
        postAuth(pythonServiceUrl, { status: 'authenticated' });
        clearTimeout(startupWatchdog);
        logger.info('WhatsApp GIS Listener is ready!');

        // Delay to let WhatsApp Web internal stores finish initializing
        await new Promise(resolve => setTimeout(resolve, 5000));
        try {
            logger.info('Searching for groups...');
            const chats = await Promise.race([
                client.getChats(),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('getChats() timed out after 15s')), 15000)
                )
            ]);
            const allGroups = chats.filter(chat => chat.isGroup);

            // Report all discovered groups to management server
            const discoveredGroups = allGroups.map(g => ({
                id: g.id._serialized,
                name: g.name,
            }));
            axios.post(`${pythonServiceUrl}/api/services/whatsapp/discovered-groups`, {
                groups: discoveredGroups
            }, { timeout: 5000 }).catch(() => {});

            logger.info({ count: allGroups.length }, 'Discovered groups reported to management server');

            // Log configured group status
            for (const gId of targetGroups) {
                const foundGroup = allGroups.find(g => g.id._serialized === gId);
                if (foundGroup) {
                    logger.info({ id: gId, name: foundGroup.name }, 'Configured group found');
                } else {
                    logger.warn({ id: gId }, 'Configured group not found on WhatsApp');
                }
            }
        } catch (error: any) {
            logger.warn({ error: error.message }, 'Could not list groups. Discovery via incoming messages is active.');
        }

        logger.info('Listening for messages from configured groups...');

        // Re-attach message listener on the current Store.Msg instance
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
        postAuth(pythonServiceUrl, { status: 'disconnected' });
    });

    // Handle incoming and outgoing messages
    client.on('message_create', async (msg: Message) => {
        logger.info({
            fromMe: msg.fromMe,
            from: msg.from,
            type: msg.type,
            body: msg.body?.substring(0, 20)
        }, 'message_create event received');

        let chat;
        try {
            chat = await withTimeout(msg.getChat(), 8000, 'msg.getChat()');
        } catch (e: any) {
            logger.warn({ error: e.message, from: msg.from }, 'Skipping message: getChat() timed out or failed');
            return;
        }
        const groupId = chat.isGroup ? chat.id._serialized : null;

        if (groupId) {
            logger.info({
                groupId,
                groupName: chat.name,
                messageType: msg.type,
                body: msg.body?.substring(0, 20)
            }, 'Group message detected');

            if (targetGroups.size > 0 && !targetGroups.has(groupId)) {
                return;
            }

            await messageHandler.handleMessage(msg);
        }
    });

    // Initialize client
    logger.info('Initializing WhatsApp Client...');
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
logger.info('Starting WhatsApp GIS Listener Bot...');
startBot().then(client => {
    activeClient = client;
}).catch((error) => {
    logger.error({ error }, 'Failed to start bot');
    process.exit(1);
});
