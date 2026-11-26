import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.vue';

const wrappers = [];
const response = (answer = '模拟回复', conversationId = 'conversation-001', expiresAt) => ({
  ok: true,
  status: 200,
  json: async () => ({ conversationId, answer, expiresAt }),
});
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function render(fetchImpl = vi.fn(async () => response())) {
  vi.stubGlobal('fetch', fetchImpl);
  const wrapper = mount(App, { attachTo: document.body });
  wrappers.push(wrapper);
  return wrapper;
}
async function enterAndSubmit(wrapper, text) {
  await wrapper.get('#message-input').setValue(text);
  await wrapper.get('#chat-form').trigger('submit');
}
async function finish(network, reply = response()) {
  network.resolve(reply);
  await flushPromises();
}
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('App integration with the real chat composable and Markdown renderer', () => {
  it('opens BaseChat Benchmark and preserves both inputs when switching views', async () => {
    const fetchImpl = vi.fn();
    const wrapper = render(fetchImpl);
    const chat = wrapper.get('#chat-workspace');
    const benchmark = wrapper.get('#benchmark-workspace');
    await chat.get('textarea').setValue('聊天草稿');
    await wrapper.get('[aria-controls="benchmark-workspace"]').trigger('click');
    expect(benchmark.isVisible()).toBe(true);
    expect(chat.isVisible()).toBe(false);
    await benchmark.get('textarea').setValue('我的基准问题');
    await wrapper.get('[aria-controls="chat-workspace"]').trigger('click');
    expect(chat.get('textarea').element.value).toBe('聊天草稿');
    await wrapper.get('[aria-controls="benchmark-workspace"]').trigger('click');
    expect(benchmark.get('textarea').element.value).toBe('我的基准问题');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('offers both apps and keeps streaming disabled for LoveApp', () => {
    const fetchImpl = vi.fn();
    const wrapper = render(fetchImpl);
    const apps = wrapper.findAll('#app-select option');
    expect(apps.map(option => option.text())).toEqual(['LoveApp', 'FirstApp']);
    expect(apps[0].element.value).toBe('loveapp');
    expect(wrapper.find('#delivery-select').exists()).toBe(false);
    expect(wrapper.get('#stream-toggle').text()).toBe('开启流式输出');
    expect(wrapper.get('#stream-toggle').element.disabled).toBe(true);
    expect(wrapper.get('#send-button').element.disabled).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('streams the first turn live, continues using JSON and resets the FirstApp ID on new chat', async () => {
    let writer;
    const stream = new ReadableStream({ start(controller) { writer = controller; } });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }))
      .mockResolvedValueOnce(response('青松', 'first-1'))
      .mockResolvedValueOnce(response('新的会话', 'first-2'));
    const wrapper = render(fetchImpl);
    await wrapper.get('#app-select').setValue('firstapp');
    await wrapper.get('#delivery-select').setValue('events');
    await enterAndSubmit(wrapper, '记住青松');
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/ai/first-app/event-stream');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ message: '记住青松' });
    const write = (name, data) => writer.enqueue(
      new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`),
    );
    write('turn.started', { conversationId: 'first-1' });
    write('generation.started', {});
    write('answer.delta', { text: '记住' });
    await flushPromises();
    expect(wrapper.get('#conversation-label').attributes('title')).toBe('first-1');
    expect(wrapper.get('.message--assistant .message-text').text()).toBe('记住');
    expect(wrapper.get('#delivery-select').element.disabled).toBe(true);
    write('answer.delta', { text: '了。' });
    write('turn.finished', { status: 'completed' });
    writer.close();
    await flushPromises();
    expect(wrapper.get('.message--assistant .message-text').text()).toBe('记住了。');
    await wrapper.get('#delivery-select').setValue('complete');
    await enterAndSubmit(wrapper, '我的代号？');
    await flushPromises();
    expect(fetchImpl.mock.calls[1][0]).toBe('/api/ai/first-app');
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ message: '我的代号？', conversationId: 'first-1' });
    await wrapper.get('#new-chat').trigger('click');
    await enterAndSubmit(wrapper, '新的会话');
    await flushPromises();
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toEqual({ message: '新的会话' });
    expect(wrapper.get('#conversation-label').attributes('title')).toBe('first-2');
  });

  it('keeps the old messages above the expiry divider and starts the next conversation without an ID', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const day = 86_400_000;
    const expiry = new Date(Date.now() + 60 * day).toISOString();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response('上段回答', 'old-id', expiry))
      .mockResolvedValueOnce(response('新段回答', 'new-id'));
    const wrapper = render(fetchImpl);
    await wrapper.get('#app-select').setValue('firstapp');
    await enterAndSubmit(wrapper, '上段问题');
    await flushPromises();
    await wrapper.get('#message-input').setValue('新段问题');
    await vi.advanceTimersByTimeAsync(59 * day);
    expect(wrapper.get('#conversation-label').attributes('title')).toBe('old-id');
    expect(wrapper.find('.session-divider').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(day);
    expect(wrapper.get('#conversation-label').attributes('title')).toBe('');
    expect(wrapper.get('.session-divider').text()).toBe('上一段会话已过期');
    expect(wrapper.get('#message-input').element.value).toBe('新段问题');
    await wrapper.get('#chat-form').trigger('submit');
    await flushPromises();
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ message: '新段问题' });
    expect(wrapper.findAll('#messages > *').map(node => node.text())).toEqual([
      expect.stringContaining('上段问题'), expect.stringContaining('上段回答'), '上一段会话已过期',
      expect.stringContaining('新段问题'), expect.stringContaining('新段回答'),
    ]);
    expect(wrapper.get('#conversation-label').attributes('title')).toBe('new-id');
  });

  it('starts with no transcript or conversation ID after remounting the page', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response('刷新前的回复', 'before-reload'))
      .mockResolvedValueOnce(response('刷新后的回复', 'after-reload'));
    const before = render(fetchImpl);
    await before.get('#app-select').setValue('firstapp');
    await enterAndSubmit(before, '刷新前');
    await flushPromises();
    expect(before.get('#conversation-label').attributes('title')).toBe('before-reload');
    wrappers.pop().unmount();

    const after = render(fetchImpl);
    await after.get('#app-select').setValue('firstapp');
    expect(after.get('#messages').text()).toBe('');
    expect(after.get('#conversation-label').attributes('title')).toBe('');
    await enterAndSubmit(after, '刷新后');
    await flushPromises();
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ message: '刷新后' });
  });

  it('checks the deadline again when switching apps and cancels it for a manually replaced chat', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const deadline = Date.now() + 60_000;
    const fetchImpl = vi.fn(async () => response('答复', 'first-id', new Date(deadline).toISOString()));
    const wrapper = render(fetchImpl);
    await wrapper.get('#app-select').setValue('firstapp');
    await enterAndSubmit(wrapper, '旧问题');
    await flushPromises();
    await wrapper.get('#app-select').setValue('loveapp');
    vi.setSystemTime(deadline);
    expect(wrapper.find('.session-divider').exists()).toBe(false);
    await wrapper.get('#app-select').setValue('firstapp');
    expect(wrapper.findAll('.session-divider')).toHaveLength(1);
    await wrapper.get('#new-chat').trigger('click');
    document.dispatchEvent(new Event('visibilitychange'));
    await nextTick();
    expect(wrapper.get('#messages').text()).toBe('');
  });

  it('puts the divider after a streamed answer when the deadline passes mid-turn', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let writer;
    const stream = new ReadableStream({ start(controller) { writer = controller; } });
    const wrapper = render(vi.fn().mockResolvedValue(new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    await wrapper.get('#app-select').setValue('firstapp');
    await wrapper.get('#delivery-select').setValue('events');
    await enterAndSubmit(wrapper, '问题');
    const started = { conversationId: 'old-id', expiresAt: new Date(Date.now() + 1_000).toISOString() };
    const encoder = new TextEncoder();
    writer.enqueue(encoder.encode(`event: turn.started\ndata: ${JSON.stringify(started)}\n\n`));
    writer.enqueue(encoder.encode('event: answer.delta\ndata: {"text":"末轮回答"}\n\n'));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(wrapper.find('.session-divider').exists()).toBe(false);
    writer.enqueue(encoder.encode('event: turn.finished\ndata: {"status":"completed"}\n\n'));
    writer.close();
    await flushPromises();
    expect(wrapper.get('#messages > :last-child').text()).toBe('上一段会话已过期');
    expect(wrapper.get('.message--assistant').text()).toContain('末轮回答');
    expect(wrapper.get('#conversation-label').attributes('title')).toBe('');
  });

  it.each(['complete', 'events'])('keeps the rejected draft after server-side expiry (%s)', async (delivery) => {
    const error = { code: 'session_expired', message: '会话已过期' };
    const rejection = delivery === 'complete'
      ? Response.json(error, { status: 410 })
      : new Response(`event: turn.finished\ndata: ${JSON.stringify({ status: 'failed', error })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response('旧回答', 'missing-id'))
      .mockResolvedValueOnce(rejection)
      .mockResolvedValueOnce(response('重新发送成功', 'new-id'));
    const wrapper = render(fetchImpl);
    await wrapper.get('#app-select').setValue('firstapp');
    await enterAndSubmit(wrapper, '第一轮');
    await flushPromises();
    await wrapper.get('#delivery-select').setValue(delivery);
    await enterAndSubmit(wrapper, '待发送的问题');
    await flushPromises();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(wrapper.get('#messages').text()).toContain('旧回答');
    expect(wrapper.findAll('.session-divider')).toHaveLength(1);
    expect(wrapper.get('#message-input').element.value).toBe('待发送的问题');
    expect(wrapper.get('#conversation-label').attributes('title')).toBe('');
    await wrapper.get('#delivery-select').setValue('complete');
    await wrapper.get('#chat-form').trigger('submit');
    await flushPromises();
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toEqual({ message: '待发送的问题' });
    expect(wrapper.findAll('.session-divider')).toHaveLength(1);
  });

  it('keeps the current FirstApp conversation and partial text when a follow-up stream fails', async () => {
    const reason = '连接模型服务时未能完成安全握手。请检查网络后再试。';
    const frames = 'event: turn.started\ndata: {"conversationId":"first-1"}\n\n'
      + 'event: answer.delta\ndata: {"text":"部分回答"}\n\n'
      + `event: turn.finished\ndata: ${JSON.stringify({ status: 'failed', error: { code: 'model_tls_failed', message: reason } })}\n\n`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response('好的', 'first-1'))
      .mockResolvedValueOnce(new Response(frames, { headers: { 'Content-Type': 'text/event-stream' } }));
    const wrapper = render(fetchImpl);
    await wrapper.get('#app-select').setValue('firstapp');
    await enterAndSubmit(wrapper, '记住青松');
    await flushPromises();
    await wrapper.get('#delivery-select').setValue('events');
    await enterAndSubmit(wrapper, '我的代号？');
    await flushPromises();
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ message: '我的代号？', conversationId: 'first-1' });
    expect(wrapper.get('#conversation-label').attributes('title')).toBe('first-1');
    expect(wrapper.get('#messages').text()).toContain('部分回答');
    expect(wrapper.get('#messages').text()).toContain('回答已中断');
    expect(wrapper.get('#firstapp-error-notice [role="alert"]').text()).toContain(reason);
    expect(wrapper.find('#error-message').exists()).toBe(false);
    await wrapper.get('[aria-label="关闭提示"]').trigger('click');
    expect(wrapper.find('#firstapp-error-notice').exists()).toBe(false);
    expect(wrapper.get('#message-input').element.value).toBe('我的代号？');
    await wrapper.get('#message-input').setValue('继续写草稿');
    await wrapper.get('#firstapp-error-trigger').trigger('click');
    expect(wrapper.get('#firstapp-error-notice').text()).toContain(reason);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await wrapper.get('#app-select').setValue('loveapp');
    expect(wrapper.get('#conversation-label').text()).toContain('尚未开始');
    expect(wrapper.get('#messages').text()).not.toContain('部分回答');
    expect(wrapper.find('#firstapp-error-notice').exists()).toBe(false);
    expect(wrapper.find('#firstapp-error-trigger').exists()).toBe(false);
  });

  it('opens a local preview with the button or shortcut, and keeps the shortcut scoped to FirstApp', async () => {
    const fetchImpl = vi.fn();
    const wrapper = render(fetchImpl);
    const shortcut = () => new KeyboardEvent('keydown', {
      code: 'KeyE', altKey: true, shiftKey: true, bubbles: true, cancelable: true,
    });
    await wrapper.get('#app-select').setValue('firstapp');
    const input = wrapper.get('#message-input');
    await input.setValue('正在编辑的问题');
    await wrapper.get('#firstapp-error-trigger').trigger('click');
    expect(wrapper.get('#firstapp-error-notice [role="status"]').text()).toContain('错误提示预览');
    const close = wrapper.get('[aria-label="关闭提示"]');
    close.element.focus();
    await close.trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('#firstapp-error-notice').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('#firstapp-error-trigger').element);

    input.element.focus();
    const openEvent = shortcut();
    input.element.dispatchEvent(openEvent);
    await nextTick();
    expect(openEvent.defaultPrevented).toBe(true);
    expect(wrapper.get('#firstapp-error-notice').text()).toContain('示例');
    expect(document.activeElement).toBe(input.element);
    expect(input.element.value).toBe('正在编辑的问题');
    expect(wrapper.get('#conversation-label').attributes('title')).toBe('');
    expect(wrapper.findAll('#messages .message')).toHaveLength(0);

    await wrapper.get('#new-chat').trigger('click');
    expect(wrapper.find('#firstapp-error-notice').exists()).toBe(false);
    await wrapper.get('[aria-controls="benchmark-workspace"]').trigger('click');
    const hiddenEvent = shortcut();
    window.dispatchEvent(hiddenEvent);
    expect(hiddenEvent.defaultPrevented).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('clears the input while the response is still pending and prevents a duplicate submit', async () => {
    const network = deferred();
    const fetchImpl = vi.fn(() => network.promise);
    const wrapper = render(fetchImpl);
    await enterAndSubmit(wrapper, '第一条消息');

    expect(wrapper.get('#message-input').element.value).toBe('');
    expect(wrapper.get('#message-input').element.disabled).toBe(false);
    expect(wrapper.get('.message--user .message-text').text()).toBe('第一条消息');
    expect(wrapper.find('.message--pending').exists()).toBe(true);
    expect(wrapper.get('#request-status').text()).toContain('正在等待回复');
    for (const id of ['send-button', 'app-select', 'new-chat', 'stream-toggle']) {
      expect(wrapper.get(`#${id}`).element.disabled).toBe(true);
    }
    await wrapper.get('#chat-form').trigger('submit');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await finish(network);
    expect(wrapper.find('.message--pending').exists()).toBe(false);
  });

  it('keeps text written while waiting when the model reply succeeds', async () => {
    const network = deferred();
    const wrapper = render(vi.fn(() => network.promise));
    await enterAndSubmit(wrapper, '已经发出的消息');
    await wrapper.get('#message-input').setValue('下一条尚未发送的草稿');
    await finish(network, response('这是第一条消息的回答'));

    expect(wrapper.get('#message-input').element.value).toBe('下一条尚未发送的草稿');
    expect(wrapper.get('.message--user .message-text').text()).toBe('已经发出的消息');
    expect(wrapper.get('.message--assistant').text()).toContain('这是第一条消息的回答');
    expect(wrapper.get('#send-button').element.disabled).toBe(false);
  });

  it('restores the original draft after failure if the user has not edited a next draft', async () => {
    const network = deferred();
    const wrapper = render(vi.fn(() => network.promise));
    await enterAndSubmit(wrapper, '  保留原文和空格\n');
    expect(wrapper.get('#message-input').element.value).toBe('');
    network.reject(new TypeError('raw-secret-error'));
    await flushPromises();

    expect(wrapper.get('#message-input').element.value).toBe('  保留原文和空格\n');
    expect(wrapper.get('#error-message').text()).toContain('后台可能已执行');
    expect(wrapper.get('#error-message').text()).not.toContain('raw-secret-error');
    expect(wrapper.find('.failed-draft').exists()).toBe(false);
    expect(wrapper.find('.message--pending').exists()).toBe(false);
    expect(wrapper.get('#conversation-label').text()).toContain('尚未开始');
  });

  it('preserves the next draft on failure and restores queued failed drafts only into an empty composer', async () => {
    const first = deferred();
    const second = deferred();
    const fetchImpl = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const wrapper = render(fetchImpl);
    await enterAndSubmit(wrapper, '第一份失败原文');
    await wrapper.get('#message-input').setValue('第二份草稿');
    first.reject(new TypeError('failed'));
    await flushPromises();

    expect(wrapper.get('#message-input').element.value).toBe('第二份草稿');
    expect(wrapper.get('.failed-draft-text').text()).toBe('第一份失败原文');
    expect(wrapper.get('.failed-draft button').element.disabled).toBe(true);
    await wrapper.get('.failed-draft button').trigger('click');
    expect(wrapper.get('#message-input').element.value).toBe('第二份草稿');

    await wrapper.get('#chat-form').trigger('submit');
    await wrapper.get('#message-input').setValue('第三份不能丢失的草稿');
    second.reject(new TypeError('failed again'));
    await flushPromises();
    expect(wrapper.get('.failed-draft').text()).toContain('已保留 2 条');
    expect(wrapper.get('#message-input').element.value).toBe('第三份不能丢失的草稿');

    await wrapper.get('#message-input').setValue('');
    expect(wrapper.get('.failed-draft button').element.disabled).toBe(false);
    await wrapper.get('.failed-draft button').trigger('click');
    expect(wrapper.get('#message-input').element.value).toBe('第一份失败原文');
    expect(wrapper.get('.failed-draft-text').text()).toBe('第二份草稿');
    expect(wrapper.get('.failed-draft button').element.disabled).toBe(true);
    await wrapper.get('#message-input').setValue('');
    await wrapper.get('.failed-draft button').trigger('click');
    expect(wrapper.get('#message-input').element.value).toBe('第二份草稿');
    expect(wrapper.find('.failed-draft').exists()).toBe(false);
  });

  it('renders assistant Markdown as headings, lists, code and tables while user HTML remains text', async () => {
    const markdown = [
      '## 沟通建议', '',
      '- 先听对方表达', '- 再说明自己的感受', '',
      '```java', 'int count = 1;', '```', '',
      '| 场景 | 做法 |', '| --- | --- |', '| 争执 | 先暂停 |',
    ].join('\n');
    const wrapper = render(vi.fn(async () => response(markdown)));
    const userText = '<img src=x onerror="alert(1)"><script>alert(2)</script> 这是我的问题';
    await enterAndSubmit(wrapper, userText);
    await flushPromises();

    const user = wrapper.get('.message--user .message-text');
    expect(user.text()).toBe(userText);
    expect(user.find('img').exists()).toBe(false);
    expect(user.find('script').exists()).toBe(false);
    const assistant = wrapper.get('.message--assistant');
    expect(assistant.get('h2').text()).toBe('沟通建议');
    expect(assistant.findAll('ul li').map(item => item.text())).toEqual(['先听对方表达', '再说明自己的感受']);
    expect(assistant.get('pre code').text()).toBe('int count = 1;');
    expect(assistant.get('table th').text()).toBe('场景');
    expect(assistant.get('table tbody tr').text()).toContain('争执');
    expect(assistant.get('table tbody tr').text()).toContain('先暂停');
  });

  it('sends the server conversation ID on the second request and omits it after a new conversation', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response('第一轮回答', 'first-id'))
      .mockResolvedValueOnce(response('第二轮回答', 'first-id'))
      .mockResolvedValueOnce(response('新会话回答', 'second-id'));
    const wrapper = render(fetchImpl);
    await enterAndSubmit(wrapper, '第一轮');
    await flushPromises();
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ message: '第一轮' });
    expect(wrapper.get('#conversation-label').attributes('title')).toBe('first-id');
    await enterAndSubmit(wrapper, '第二轮');
    await flushPromises();
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ message: '第二轮', conversationId: 'first-id' });
    expect(wrapper.findAll('#messages .message')).toHaveLength(4);

    await wrapper.get('#message-input').setValue('待清空的草稿');
    await wrapper.get('#new-chat').trigger('click');
    expect(wrapper.findAll('#messages .message')).toHaveLength(0);
    expect(wrapper.get('#message-input').element.value).toBe('');
    expect(wrapper.find('.empty-state').exists()).toBe(true);
    expect(wrapper.get('#conversation-label').attributes('title')).toBe('');
    await enterAndSubmit(wrapper, '新会话第一轮');
    await flushPromises();
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toEqual({ message: '新会话第一轮' });
    expect(wrapper.get('#conversation-label').attributes('title')).toBe('second-id');
  });

  it('sends with Enter but leaves Shift + Enter to the textarea', async () => {
    const network = deferred();
    const fetchImpl = vi.fn(() => network.promise);
    const wrapper = render(fetchImpl);
    const input = wrapper.get('#message-input');
    await input.setValue('快捷键发送');
    const shiftEnter = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    input.element.dispatchEvent(shiftEnter);
    await nextTick();
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    const plainEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.element.dispatchEvent(plainEnter);
    await nextTick();
    expect(plainEnter.defaultPrevented).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(input.element.value).toBe('');
    await finish(network);
  });

  it('does not submit during IME composition, a composing key event or key repetition', async () => {
    const network = deferred();
    const fetchImpl = vi.fn(() => network.promise);
    const wrapper = render(fetchImpl);
    const input = wrapper.get('#message-input');
    await input.setValue('正在使用中文输入法');
    await input.trigger('compositionstart');
    await input.trigger('keydown', { key: 'Enter' });
    await wrapper.get('#chat-form').trigger('submit');
    expect(fetchImpl).not.toHaveBeenCalled();
    await input.trigger('compositionend');
    await input.trigger('keydown', { key: 'Enter', isComposing: true });
    await input.trigger('keydown', { key: 'Enter', repeat: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(input.element.value).toBe('正在使用中文输入法');
    await input.trigger('keydown', { key: 'Enter' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await finish(network);
  });

  it('does not treat an IME keyCode 229 event as the send shortcut', async () => {
    const fetchImpl = vi.fn(async () => response());
    const wrapper = render(fetchImpl);
    const input = wrapper.get('#message-input');
    await input.setValue('输入法确认键');
    const imeEnter = new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    });
    Object.defineProperty(imeEnter, 'keyCode', { value: 229 });
    input.element.dispatchEvent(imeEnter);
    await nextTick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(input.element.value).toBe('输入法确认键');
  });
});
