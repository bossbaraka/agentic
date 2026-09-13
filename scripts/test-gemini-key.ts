import { config } from '../src/config.js';

async function testGemini() {
  const key = config.gemini.API_KEY;
  console.log('Testing GEMINI_API_KEY:', key ? `${key.slice(0, 8)}...` : '(empty)');

  // Call List Models API on Google AI Studio
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
  const json = await res.json();

  if (!res.ok) {
    console.error('❌ Google Gemini API Error:', JSON.stringify(json));
  } else {
    console.log('✅ Success! Available models:', json.models?.map((m: any) => m.name));
  }
}

testGemini().catch(console.error);
