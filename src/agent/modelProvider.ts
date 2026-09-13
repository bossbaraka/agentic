/**
 * Model abstraction layer — model-agnostic, configurable.
 * Supports cheap model for classification, strong for reasoning.
 */

import { config } from '../config.js';
import { generateReply as generateGeminiReply, buildModelChain, type Turn } from './llm.js';
import type { ToolContext } from './tools-types.js';

export type ModelTier = 'FAST' | 'BALANCED' | 'STRONG';

export interface ModelConfig {
  provider: 'openai' | 'gemini';
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export function getModelConfig(tier: ModelTier): ModelConfig {
  const provider = config.llm.PROVIDER;
  if (provider === 'openai') {
    if (tier === 'FAST') {
      return {
        provider: 'openai',
        model: config.openai.FAST_MODEL,
        temperature: config.openai.TEMPERATURE,
        maxTokens: config.openai.MAX_TOKENS,
        timeoutMs: config.openai.TIMEOUT_MS,
      };
    }
    return {
      provider: 'openai',
      model: config.openai.MODEL,
      temperature: config.openai.TEMPERATURE,
      maxTokens: config.openai.MAX_TOKENS,
      timeoutMs: config.openai.TIMEOUT_MS,
    };
  } else {
    if (tier === 'FAST') {
      return {
        provider: 'gemini',
        model: config.gemini.FAST_MODEL,
        temperature: config.gemini.TEMPERATURE,
        maxTokens: config.gemini.MAX_OUTPUT_TOKENS,
        timeoutMs: config.gemini.TIMEOUT_MS,
      };
    }
    return {
      provider: 'gemini',
      model: config.gemini.MODEL,
      temperature: config.gemini.TEMPERATURE,
      maxTokens: config.gemini.MAX_OUTPUT_TOKENS,
      timeoutMs: config.gemini.TIMEOUT_MS,
    };
  }
}

export interface ModelCallInput {
  systemPrompt: string;
  turns: Turn[];
  toolsEnabled?: boolean;
  toolContext?: ToolContext;
  extraContext?: string;
  tier?: ModelTier;
}

export async function callModel(input: ModelCallInput) {
  // For now, delegate to existing generateReply which already handles provider abstraction
  // In future, we can route based on tier
  const tier = input.tier || 'BALANCED';
  const modelConfig = getModelConfig(tier);

  // The existing generateReply already uses config, but we pass through
  return generateGeminiReply({
    systemPrompt: input.systemPrompt,
    turns: input.turns,
    toolsEnabled: input.toolsEnabled ?? true,
    toolContext: input.toolContext || { sessionKey: 'unknown', customerName: 'unknown', channel: 'wa', language: 'ar' },
    extraContext: input.extraContext,
  });
}

export function modelChainInfo() {
  if (config.llm.PROVIDER === 'gemini') {
    return buildModelChain();
  }
  return [config.openai.MODEL, config.openai.FAST_MODEL];
}
