import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.vue';

const wrappers = [];
const response = (answer = '模拟回复', conversationId = 'conversation-001') => ({
  ok: true,
  status: 200,
  json: async () => ({ conversationId, answer }),
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

  it('offers only LoveApp and keeps the unimplemented stream button disabled', () => {
    const fetchImpl = vi.fn();
    const wrapper = render(fetchImpl);
    const apps = wrapper.findAll('#app-select option');
    expect(apps).toHaveLength(1);
    expect(apps[0].text()).toBe('LoveApp');
    expect(apps[0].element.value).toBe('loveapp');
    expect(wrapper.find('#delivery-select').exists()).toBe(false);
    expect(wrapper.get('#stream-toggle').text()).toBe('开启流式输出');
    expect(wrapper.get('#stream-toggle').element.disabled).toBe(true);
    expect(wrapper.get('#send-button').element.disabled).toBe(true);
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
