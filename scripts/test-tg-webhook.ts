import { config } from '../src/config.js';

async function checkTelegram() {
  const token = config.telegram.BOT_TOKEN;
  console.log('Testing Telegram Bot Token:', token.slice(0, 10) + '...');

  // 1. Get Me
  const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const me = await meRes.json();
  console.log('BotInfo (getMe):', me);

  // 2. Get Webhook Info
  const whRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const wh = await whRes.json();
  console.log('WebhookInfo:', wh);

  // If webhook is active, delete it so getUpdates polling works!
  if (wh.result?.url) {
    console.log('⚠️ Webhook is active (url:', wh.result.url, '). Deleting webhook so Polling works...');
    const delRes = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
    const del = await delRes.json();
    console.log('deleteWebhook result:', del);
  } else {
    console.log('✅ No active Webhook registered. Polling should work!');
  }
}

checkTelegram().catch(console.error);
