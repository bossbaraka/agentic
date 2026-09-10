import { config } from '../src/config.js';
import { startKeepAlive, stopKeepAlive } from '../src/lib/keepalive.js';

console.log('🧪 فحص إعدادات Keep-Alive:');
console.log('  - KEEP_ALIVE_ENABLED:', config.server.KEEP_ALIVE_ENABLED);
console.log('  - KEEP_ALIVE_INTERVAL_MINUTES:', config.server.KEEP_ALIVE_INTERVAL_MINUTES);
console.log('  - RENDER_EXTERNAL_URL:', config.server.RENDER_EXTERNAL_URL || '(فارغ - يُحقن تلقائياً في Render)');

// تجربة تشغيل وإيقاف بدون أخطاء
startKeepAlive();
stopKeepAlive();

console.log('✅ اختبار Keep-Alive نجح بالكامل دون أي أخطاء.');
