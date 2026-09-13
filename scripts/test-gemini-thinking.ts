import { GoogleGenAI } from '@google/genai';
import { config } from '../src/config.js';
import { TOOL_DECLARATIONS } from '../src/agent/tools.js';

async function testWithTools() {
  const ai = new GoogleGenAI({ apiKey: config.gemini.API_KEY });
  console.log('Testing generateContent with tools & systemInstruction...');

  try {
    const res = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: [{ role: 'user', parts: [{ text: 'مرحبا، كم اسعار الاشتراكات؟' }] }],
      config: {
        systemInstruction: 'أنت مساعد منصة مريح الذكي.',
        temperature: 0.7,
        maxOutputTokens: 1024,
        tools: TOOL_DECLARATIONS as any,
      },
    } as any);

    console.log('✅ Response:', res.text);
  } catch (err: any) {
    console.error('❌ Error with tools:', err.message || err);
  }
}

testWithTools();
