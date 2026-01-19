import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import * as path from 'path';
import * as fs from 'fs';

import { loadConfig, getTargetGroupIds, Config } from './config';
import { MessageHandler } from './messageHandler';
import { logger } from './logger';

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
            dataPath: path.resolve(__dirname, '../auth_info')
        }),
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
                '--disable-gpu'
            ],
            handleSIGINT: false,
            protocolTimeout: 0, // Disable protocol timeout for accounts with many chats
        }
    });

    // Link client to message handler
    messageHandler.setClient(client);

    // QR Code display
    client.on('qr', (qr) => {
        logger.info('Scan the QR code below with your WhatsApp app:');
        console.log('\n');
        qrcode.generate(qr, { small: true });
        console.log('\n');
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
        logger.info('✅ WhatsApp GIS Listener is ready!');

        // List all groups for discovery
        try {
            logger.info('Searching for groups specified in config (this may take a while if you have many chats)...');
            const chats = await client.getChats();
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
    });

    client.on('disconnected', (reason) => {
        logger.warn({ reason }, 'Disconnected from WhatsApp');
    });

    // Handle incoming and outgoing messages (for discovery and processing)
    client.on('message_create', async (msg: Message) => {
        // In groups, msg.from is usually the group ID for incoming messages.
        // For outgoing messages, msg.to is the group ID.
        // We check both to find the group context.
        const chat = await msg.getChat();
        const groupId = chat.isGroup ? chat.id._serialized : null;

        if (groupId) {
            // Log for discovery
            logger.info({
                groupId,
                groupName: chat.name,
                fromMe: msg.fromMe,
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
