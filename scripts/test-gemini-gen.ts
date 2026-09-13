import { GoogleGenAI } from '@google/genai';
import { config } from '../src/config.js';

async function testGen() {
  const ai = new GoogleGenAI({ apiKey: config.gemini.API_KEY });
  console.log('Testing generateContent with model gemini-3.6-flash...');
  
  const res = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: 'مرحبا، عرف بنفسك بكلمتين',
  });

  console.log('✅ Response:', res.text);
}

testGen().catch(console.error);
