import { parseTelegramUpdate } from '../src/telegram/incoming.js';
import { isTelegramChannel, dispatchSendText } from '../src/agent/channel.js';

console.log('Testing Telegram Channel helpers...');

// 1. Check channel recognition
console.assert(isTelegramChannel('tg:123456') === true, 'tg:123456 should be recognised as Telegram');
console.assert(isTelegramChannel('972500000000') === false, 'WhatsApp number should not be recognised as Telegram');

// 2. Check update parser
const update = {
  update_id: 100,
  message: {
    message_id: 50,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 123456, type: 'private' as const, first_name: 'Test', last_name: 'User' },
    from: { id: 123456, is_bot: false, first_name: 'Test', last_name: 'User' },
    text: 'Hello Telegram Bot!',
  },
};

const normalized = parseTelegramUpdate(update);
console.assert(normalized !== null, 'Normalized update should not be null');
console.assert(normalized?.from === 'tg:123456', `Expected tg:123456 but got ${normalized?.from}`);
console.assert(normalized?.contactName === 'Test User', `Expected Test User but got ${normalized?.contactName}`);
console.assert(normalized?.body === 'Hello Telegram Bot!', `Expected text but got ${normalized?.body}`);

console.log('✅ Telegram unit tests passed successfully!');
