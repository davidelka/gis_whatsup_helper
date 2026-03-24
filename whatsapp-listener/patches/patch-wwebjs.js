/**
 * Patches whatsapp-web.js to fix two known bugs:
 *
 * 1. Client.js: "ready event never fires" — AppState.hasSynced can already be
 *    true before the listener is registered, so the change event never fires.
 *    See: https://github.com/pedroslopez/whatsapp-web.js/issues/5758
 *
 * 2. Utils.js: "GroupMetadata.update is undefined" — the Comet Store injection
 *    does not expose GroupMetadata, causing getChat()/getChats() to crash for
 *    group chats (and silently dropping all incoming group messages).
 */
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Patch 1: Client.js — hasSynced ready-event fix
// ---------------------------------------------------------------------------
const clientPath = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');
let clientSrc = fs.readFileSync(clientPath, 'utf8');

const oldClientCode = `window.AuthStore.AppState.on('change:state', (_AppState, state) => { window.onAuthAppStateChangedEvent(state); });
            window.AuthStore.AppState.on('change:hasSynced', () => { window.onAppStateHasSyncedEvent(); });`;

const newClientCode = `const appState = window.AuthStore.AppState;
            if (appState.hasSynced) {
                window.onAppStateHasSyncedEvent();
            }
            appState.on('change:hasSynced', (_AppState, hasSynced) => {
                if (hasSynced) { window.onAppStateHasSyncedEvent(); }
            });
            appState.on('change:state', (_AppState, state) => { window.onAuthAppStateChangedEvent(state); });`;

if (clientSrc.includes(newClientCode)) {
    console.log('[patch] Client.js already patched, skipping.');
} else if (!clientSrc.includes(oldClientCode)) {
    console.error('[patch] Client.js: expected code block not found — patch may need updating.');
    process.exit(1);
} else {
    clientSrc = clientSrc.replace(oldClientCode, newClientCode);
    fs.writeFileSync(clientPath, clientSrc, 'utf8');
    console.log('[patch] Client.js patched (hasSynced ready-event fix).');
}

// ---------------------------------------------------------------------------
// Patch 2: Utils.js — guard GroupMetadata.update call
// ---------------------------------------------------------------------------
const utilsPath = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
let utilsSrc = fs.readFileSync(utilsPath, 'utf8');

const oldUtilsCode = `await window.Store.GroupMetadata.update(chatWid);`;
const newUtilsCode = `if (window.Store.GroupMetadata) { await window.Store.GroupMetadata.update(chatWid); }`;

if (utilsSrc.includes(newUtilsCode)) {
    console.log('[patch] Utils.js already patched, skipping.');
} else if (!utilsSrc.includes(oldUtilsCode)) {
    console.error('[patch] Utils.js: expected code block not found — patch may need updating.');
    process.exit(1);
} else {
    utilsSrc = utilsSrc.replace(oldUtilsCode, newUtilsCode);
    fs.writeFileSync(utilsPath, utilsSrc, 'utf8');
    console.log('[patch] Utils.js patched (GroupMetadata guard).');
}
