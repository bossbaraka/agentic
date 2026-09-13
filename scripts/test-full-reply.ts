import { generateReply } from '../src/agent/llm.js';
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';

async function testFull() {
  console.log('Testing full generateReply flow...');

  const systemPrompt = buildSystemPrompt({
    mode: 'hybrid',
    customerName: 'أحمد',
    customerNumber: 'tg:123',
    sessionLanguage: 'ar',
    summary: '',
    toolsEnabled: true,
  });

  const reply = await generateReply({
    systemPrompt,
    turns: [{ role: 'user', text: 'بكم الاشتراك بالخطة الاحترافية؟' }],
    toolsEnabled: true,
    toolContext: { sessionKey: 'tg:123', customerName: 'أحمد' },
  });

  console.log('✅ Full generateReply Success!');
  console.log('Model:', reply.model);
  console.log('Parts:', reply.parts);
}

testFull().catch(console.error);
