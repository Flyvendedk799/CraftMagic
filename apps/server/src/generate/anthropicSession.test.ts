/**
 * The Anthropic session's conversation bookkeeping.
 *
 * Everything here is about one rule the API enforces absolutely: a message following an
 * assistant turn that made tool calls must answer **every** call in that turn, in that one
 * message. Break it and the request is refused with
 *
 *   messages.2: `tool_use` ids were found without `tool_result` blocks immediately after
 *
 * which is a confusing thing to be told when your own tool was called and you replied to it.
 * The session held a single tool id, which was correct for as long as the model returned one
 * block and became a failed generation the first time it returned four.
 *
 * The client is a stub, because the thing under test is the shape of the messages we build —
 * which is exactly what a live call hides behind a 400.
 */

import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { anthropicProvider, TOOL_NAME, type ProviderSession } from './providers.js';

type Block = Anthropic.ContentBlock;

/** Records what it was sent and replays scripted assistant turns. */
function stub(turns: Block[][]) {
  const sent: Anthropic.MessageCreateParams[] = [];
  let turn = 0;
  const client = {
    messages: {
      stream(params: Anthropic.MessageCreateParams) {
        sent.push(structuredClone(params));
        const content = turns[Math.min(turn++, turns.length - 1)]!;
        return {
          on() {},
          async finalMessage() {
            return {
              content,
              usage: { input_tokens: 1, output_tokens: 1 },
              stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
            };
          },
        };
      },
    },
  };
  const session: ProviderSession = anthropicProvider('sk-test', client as unknown as Anthropic).session({
    model: 'claude-sonnet-5',
    system: 'sys',
    schema: {},
    maxTokens: 100,
  });
  return { session, sent };
}

const toolUse = (id: string, name = TOOL_NAME): Block =>
  ({ type: 'tool_use', id, name, input: { version: 1 } }) as unknown as Block;

const prose = (value: string): Block =>
  ({ type: 'text', text: value, citations: [] }) as unknown as Block;

/** Run one emit and one repair over a scripted first turn, and return the repair request. */
async function repairAfter(turn: Block[]): Promise<Anthropic.MessageCreateParams> {
  const { session, sent } = stub([turn, [toolUse('second')]]);
  await session.emit('build a hut');
  await session.repair('component 3 is invalid');
  return sent[1]!;
}

describe('the request', () => {
  it('asks for one tool call per turn', async () => {
    // Cheaper than coping with several: the program is a single object, so a second copy was
    // never wanted — and a turn with four calls in it is what produced the 400.
    const { session, sent } = stub([[toolUse('a')]]);
    await session.emit('build a hut');
    expect(sent[0]!.tool_choice).toEqual({
      type: 'tool',
      name: TOOL_NAME,
      disable_parallel_tool_use: true,
    });
  });
});

describe('the repair round', () => {
  it('answers every tool call in the turn, not just the one it read', async () => {
    // The regression. Four calls, one answer, and the API refuses the whole request.
    const request = await repairAfter([toolUse('a'), toolUse('b'), toolUse('c'), toolUse('d')]);
    const replies = request.messages[2]!.content as Anthropic.ToolResultBlockParam[];

    expect(replies.map((r) => r.tool_use_id)).toEqual(['a', 'b', 'c', 'd']);
    // The first carries the real feedback; the rest are told the truth, which is that nothing
    // read them.
    expect(replies[0]!.content).toBe('component 3 is invalid');
    expect(String(replies[1]!.content)).toMatch(/only the first program/i);
  });

  it('answers calls to tools we never registered, because the rule is about ids', async () => {
    const request = await repairAfter([toolUse('ours'), toolUse('stray', 'some_other_tool')]);
    const replies = request.messages[2]!.content as Anthropic.ToolResultBlockParam[];
    expect(replies.map((r) => r.tool_use_id)).toEqual(['ours', 'stray']);
  });

  it('still answers the single-call case exactly as before', async () => {
    const request = await repairAfter([toolUse('only')]);
    const replies = request.messages[2]!.content as Anthropic.ToolResultBlockParam[];
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ tool_use_id: 'only', is_error: true });
  });

  it('sends prose back as prose when the model made no tool call at all', async () => {
    // A tool_result here would itself be invalid, so the problems go back as a plain message.
    const request = await repairAfter([prose('I would rather not.')]);
    expect(request.messages[2]).toEqual({ role: 'user', content: 'component 3 is invalid' });
  });
});
