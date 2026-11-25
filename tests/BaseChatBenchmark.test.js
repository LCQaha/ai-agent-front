import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BaseChatBenchmark from '../src/components/BaseChatBenchmark.vue';

enableAutoUnmount(afterEach);
afterEach(() => vi.unstubAllGlobals());

function mountBenchmark(fetch) {
  vi.stubGlobal('fetch', fetch);
  return mount(BaseChatBenchmark);
}

function reply(body) {
  return { ok: true, status: 200, json: async () => body };
}

function streamResponse(contentType = 'text/plain;charset=UTF-8') {
  let writer;
  const stream = new ReadableStream({
    start(controller) { writer = controller; },
  });
  const response = new Response(stream, { headers: { 'Content-Type': contentType } });
  return { writer, response };
}

function mode(panel, value) {
  return panel.get(`input[name="benchmark-mode"][value="${value}"]`);
}

function frame(event, data) {
  return `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
}

const encoder = new TextEncoder();

describe('BaseChat Benchmark', () => {
  it('displays streamed UTF-8 as it arrives and can switch back to the JSON endpoint', async () => {
    const { writer, response } = streamResponse();
    const fetch = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(reply({ message: '普通回答' }));
    const panel = mountBenchmark(fetch);
    const stream = mode(panel, 'stream');
    expect(mode(panel, 'complete').element.checked).toBe(true);
    await stream.setValue(true);
    await panel.get('textarea').setValue('自定义流式测试');
    await panel.get('form').trigger('submit');
    expect(stream.element.matches(':disabled')).toBe(true);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/ai/benchmark-stream');
    expect(options.method).toBe('POST');
    expect(new Headers(options.headers).get('Accept')).toBe('text/plain');
    expect(JSON.parse(options.body)).toEqual({ message: '自定义流式测试' });

    const first = encoder.encode('第一段');
    writer.enqueue(first.slice(0, 2));
    await flushPromises();
    expect(panel.text()).not.toContain('�');
    writer.enqueue(first.slice(2));
    await flushPromises();
    expect(panel.get('.markdown-message').text()).toBe('第一段');
    expect(stream.element.matches(':disabled')).toBe(true);
    writer.enqueue(encoder.encode(' 第二段'));
    writer.close();
    await flushPromises();
    expect(panel.get('.markdown-message').text()).toBe('第一段 第二段');
    expect(panel.get('[role="status"]').text()).toContain('已完成');
    expect(stream.element.matches(':disabled')).toBe(false);

    await mode(panel, 'complete').setValue(true);
    await panel.get('form').trigger('submit');
    await flushPromises();
    expect(fetch.mock.calls[1][0]).toBe('/api/ai/benchmark');
    expect(panel.get('.markdown-message').text()).toBe('普通回答');
  });

  it('preserves the partial answer and edited question when the stream is interrupted', async () => {
    const { writer, response } = streamResponse();
    const panel = mountBenchmark(vi.fn().mockResolvedValue(response));
    const stream = mode(panel, 'stream');
    await stream.setValue(true);
    await panel.get('textarea').setValue('解释流中断');
    await panel.get('form').trigger('submit');
    writer.enqueue(new TextEncoder().encode('已收到的文字'));
    await flushPromises();
    writer.error(new Error('connection dropped'));
    await flushPromises();

    expect(panel.get('.markdown-message').text()).toBe('已收到的文字');
    expect(panel.get('textarea').element.value).toBe('解释流中断');
    expect(panel.get('[role="alert"]').text()).not.toBe('');
    expect(panel.get('[role="status"]').text()).toContain('中断');
    expect(stream.element.matches(':disabled')).toBe(false);
  });

  it('shows SSE lifecycle events and appends only the text from complete delta frames', async () => {
    const { writer, response } = streamResponse('text/event-stream;charset=UTF-8');
    const fetch = vi.fn().mockResolvedValue(response);
    const panel = mountBenchmark(fetch);
    await mode(panel, 'events').setValue(true);
    await panel.get('textarea').setValue('解释事件流');
    await panel.get('form').trigger('submit');
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/ai/benchmark-event-stream');
    expect(options.method).toBe('POST');
    expect(new Headers(options.headers).get('Accept')).toBe('text/event-stream');
    expect(JSON.parse(options.body)).toEqual({ message: '解释事件流' });

    const status = panel.get('[role="status"]');
    writer.enqueue(encoder.encode(frame('turn.started', {})));
    await flushPromises();
    expect(status.text()).toContain('已开始');
    writer.enqueue(encoder.encode(frame('generation.started', {})));
    await flushPromises();
    expect(status.text()).toContain('正在生成');

    // Split the first Chinese character across reads, then send two frames in the same read.
    const delta = frame('answer.delta', { text: '第一段' });
    const split = encoder.encode(delta.slice(0, delta.indexOf('第'))).length + 1;
    const body = encoder.encode(delta + frame('answer.delta', { text: ' 第二段' }));
    writer.enqueue(body.slice(0, split));
    await flushPromises();
    expect(panel.text()).not.toContain('�');
    writer.enqueue(body.slice(split));
    await flushPromises();
    expect(panel.get('.markdown-message').text()).toBe('第一段 第二段');
    expect(status.text()).not.toContain('已完成');

    writer.enqueue(encoder.encode(frame('turn.finished', { status: 'completed' })));
    writer.close();
    await flushPromises();
    expect(status.text()).toContain('已完成');
    expect(panel.find('[role="alert"]').exists()).toBe(false);
  });

  it.each([
    ['a failed turn', frame('turn.finished', { status: 'failed' })],
    ['an unexpected end of stream', ''],
  ])('keeps partial SSE text on %s', async (_case, ending) => {
    const { writer, response } = streamResponse('text/event-stream');
    const panel = mountBenchmark(vi.fn().mockResolvedValue(response));
    await mode(panel, 'events').setValue(true);
    await panel.get('form').trigger('submit');
    writer.enqueue(encoder.encode(frame('turn.started', {}) + frame('generation.started', {})
      + frame('answer.delta', { text: '已收到的片段' }) + ending));
    writer.close();
    await flushPromises();

    expect(panel.get('.markdown-message').text()).toBe('已收到的片段');
    expect(panel.get('[role="alert"]').text()).not.toBe('');
    expect(panel.get('[role="status"]').text()).not.toContain('已完成');
    expect(mode(panel, 'events').element.matches(':disabled')).toBe(false);
  });

  it('uses the server completion status even when the SSE answer contains only whitespace', async () => {
    const { writer, response } = streamResponse('text/event-stream');
    const panel = mountBenchmark(vi.fn().mockResolvedValue(response));
    await mode(panel, 'events').setValue(true);
    await panel.get('form').trigger('submit');
    writer.enqueue(encoder.encode(frame('turn.started', {}) + frame('generation.started', {})
      + frame('answer.delta', { text: ' \n' }) + frame('turn.finished', { status: 'completed' })));
    writer.close();
    await flushPromises();
    expect(panel.get('[role="status"]').text()).toContain('已完成');
    expect(panel.find('[role="alert"]').exists()).toBe(false);
  });

  it('runs the edited prompt and sends independent requests on rerun', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(reply({ message: '第一轮回答', conversationId: null }))
      .mockResolvedValueOnce(reply({ message: '第二轮回答' }));
    const panel = mountBenchmark(fetch);
    const input = panel.get('textarea');
    expect(input.element.value.trim()).not.toBe('');
    expect(fetch).not.toHaveBeenCalled();

    for (const [index, text] of ['请解释 RAG', '给出一个例子'].entries()) {
      await input.setValue(text);
      await panel.get('form').trigger('submit');
      await flushPromises();
      const [url, options] = fetch.mock.calls[index];
      expect(url).toBe('/api/ai/benchmark');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({ message: text });
      expect(input.element.value).toBe(text);
      expect(panel.get('.benchmark-question').text()).toBe(text);
      expect(panel.get('[role="status"]').text()).toMatch(/耗时 \d+ ms/);
    }
    expect(panel.get('.markdown-message').text()).toBe('第二轮回答');
  });

  it('ignores blank and duplicate submissions and keeps input on failure', async () => {
    let finish;
    const fetch = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const panel = mountBenchmark(fetch);
    const input = panel.get('textarea');
    await input.setValue('  ');
    await panel.get('form').trigger('submit');
    expect(panel.get('button').element.disabled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();

    await input.setValue('自定义测试');
    await panel.get('form').trigger('submit');
    await panel.get('form').trigger('submit');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(panel.get('button').element.disabled).toBe(true);
    finish(reply({ message: ' ' }));
    await flushPromises();
    expect(panel.get('[role="alert"]').text()).toContain('message');
    expect(panel.get('button').element.disabled).toBe(false);
    expect(input.element.value).toBe('自定义测试');
  });

  it('aborts a pending request on unmount', async () => {
    const fetch = vi.fn(() => new Promise(() => {}));
    const panel = mountBenchmark(fetch);
    await panel.get('form').trigger('submit');
    const { signal } = fetch.mock.calls[0][1];
    panel.unmount();
    expect(signal.aborted).toBe(true);
    await flushPromises();
  });
});
