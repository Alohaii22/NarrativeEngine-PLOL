import { describe, it, expect } from 'vitest';
import {
    buildChatBody,
    claudeModelProfile,
    transformClaudeTools,
    ClaudeThinkingCollector,
    rememberClaudeThinking,
} from '../llmApiHelper';
import type { EndpointConfig } from '../../types';

const claude = (modelName: string): EndpointConfig => ({
    id: 'c',
    name: 'Claude',
    endpoint: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant-test',
    modelName,
    apiFormat: 'claude',
} as EndpointConfig);

const messages = [
    { role: 'system', content: 'You are the GM.' },
    { role: 'user', content: 'I open the door.' },
];

const openaiTool = {
    type: 'function',
    function: {
        name: 'query_campaign_lore',
        description: 'Search lore',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
};

describe('claudeModelProfile', () => {
    it.each([
        ['claude-3-5-sonnet-20241022', false, true],
        ['claude-sonnet-4-20250514', false, true],
        ['claude-sonnet-4-5-20250929', false, true],
        ['claude-haiku-4-5', false, true],
        ['claude-opus-4-6', true, true],
        ['claude-opus-4-7', true, false],
        ['claude-opus-5', true, false],
        ['claude-opus-5-5', true, false],
        ['claude-sonnet-5-5', true, false],
        ['claude-haiku-5-5', true, false],
        ['claude-fable-5-2', true, false],
        ['anthropic.claude-opus-5-5', true, false],
        ['some-unknown-model', false, true],
    ])('%s → adaptive=%s sampling=%s', (model, adaptive, sampling) => {
        const p = claudeModelProfile(model);
        expect(p.adaptiveThinking).toBe(adaptive);
        expect(p.acceptsSampling).toBe(sampling);
    });

    it('marks models where thinking cannot be disabled', () => {
        expect(claudeModelProfile('claude-opus-5-5').thinkingAlwaysOn).toBe(true);
        expect(claudeModelProfile('claude-fable-5-2').thinkingAlwaysOn).toBe(true);
        expect(claudeModelProfile('claude-opus-5').thinkingAlwaysOn).toBe(false);
        expect(claudeModelProfile('claude-opus-4-8').thinkingAlwaysOn).toBe(false);
    });
});

describe('buildChatBody — current Claude models', () => {
    it('uses adaptive thinking + effort, never budget_tokens', () => {
        const body = buildChatBody(claude('claude-opus-5-5'), messages, { thinkingEffort: 'high' });
        expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(body.output_config).toEqual({ effort: 'high' });
        expect(JSON.stringify(body)).not.toContain('budget_tokens');
    });

    it('drops temperature/top_p/top_k, which these models reject', () => {
        const body = buildChatBody(claude('claude-opus-5-5'), messages, {
            temperature: 0.9,
            sampling: { temperature: 0.8, top_p: 0.9, top_k: 40 },
        });
        expect(body.temperature).toBeUndefined();
        expect(body.top_p).toBeUndefined();
        expect(body.top_k).toBeUndefined();
    });

    it('maps "off" to low effort where thinking cannot be disabled', () => {
        const body = buildChatBody(claude('claude-opus-5-5'), messages, { thinkingEffort: 'off' });
        expect(body.thinking).toBeUndefined();
        expect(body.output_config).toEqual({ effort: 'low' });
    });

    it('keeps the legacy shape for older models', () => {
        const body = buildChatBody(claude('claude-sonnet-4-20250514'), messages, {
            thinkingEffort: 'medium',
            temperature: 0.7,
        });
        expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
        expect(body.temperature).toBe(0.7);
        expect(body.output_config).toBeUndefined();
    });

    it('converts OpenAI-style tools and disables parallel tool use', () => {
        const body = buildChatBody(claude('claude-opus-5-5'), messages, { tools: [openaiTool] });
        expect(body.tools).toEqual([{
            name: 'query_campaign_lore',
            description: 'Search lore',
            input_schema: openaiTool.function.parameters,
        }]);
        expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    });
});

describe('transformClaudeTools', () => {
    it('passes native Claude tools through unchanged', () => {
        const native = { name: 'roll', input_schema: { type: 'object', properties: {} } };
        expect(transformClaudeTools([native])).toEqual([native]);
    });
});

describe('Claude thinking continuity across a tool loop', () => {
    it('collects thinking + signature from stream events', () => {
        const c = new ClaudeThinkingCollector();
        c.push({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
        expect(c.push({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The door ' } })).toBe('The door ');
        c.push({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'is trapped.' } });
        c.push({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } });
        c.push({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'x' } });
        expect(c.result()).toEqual([{ type: 'thinking', thinking: 'The door is trapped.', signature: 'sig123' }]);
    });

    it('re-attaches thinking blocks to the in-flight tool turn only', () => {
        rememberClaudeThinking('toolu_old', [{ type: 'thinking', thinking: 'old', signature: 's-old' }]);
        rememberClaudeThinking('toolu_new', [{ type: 'thinking', thinking: 'new', signature: 's-new' }]);
        const toolCall = (id: string) => ({ id, type: 'function', function: { name: 'query_campaign_lore', arguments: '{"query":"door"}' } });
        const body = buildChatBody(claude('claude-opus-5-5'), [
            { role: 'system', content: 'GM' },
            { role: 'user', content: 'turn 1' },
            { role: 'assistant', content: '', tool_calls: [toolCall('toolu_old')] },
            { role: 'tool', content: 'lore', tool_call_id: 'toolu_old' },
            { role: 'assistant', content: 'done' },
            { role: 'user', content: 'turn 2' },
            { role: 'assistant', content: '', tool_calls: [toolCall('toolu_new')] },
            { role: 'tool', content: 'lore', tool_call_id: 'toolu_new' },
        ], { thinkingEffort: 'high' });
        const msgs = body.messages as { role: string; content: unknown }[];
        const oldTurn = msgs[1].content as { type: string }[];
        const newTurn = msgs[5].content as { type: string; signature?: string }[];
        expect(oldTurn[0].type).toBe('tool_use');
        expect(newTurn[0]).toEqual({ type: 'thinking', thinking: 'new', signature: 's-new' });
        expect(newTurn[1].type).toBe('tool_use');
    });
});
