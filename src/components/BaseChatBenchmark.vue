<script setup>
import { onBeforeUnmount, ref } from 'vue';
import { ChatRequestError, sendCompleteRequest, sendEventStreamRequest, sendStreamRequest } from '../api/chat.js';
import MarkdownMessage from './MarkdownMessage.vue';

const app = {
  endpoint: '/api/ai/benchmark',
  streamEndpoint: '/api/ai/benchmark-stream',
  eventStreamEndpoint: '/api/ai/benchmark-event-stream',
};
const modes = {
  complete: { label: '完整回复', endpoint: app.endpoint },
  stream: { label: '纯文本流', endpoint: app.streamEndpoint },
  events: { label: '事件流（SSE）', endpoint: app.eventStreamEndpoint },
};
const mode = ref('complete');
const input = ref('请用一句话解释什么是 Spring AI。');
const pending = ref(false);
const error = ref('');
const result = ref(null);
const progress = ref('');
let controller;

function readAnswer(body) {
  if (typeof body?.message !== 'string' || !body.message.trim()) {
    throw new ChatRequestError('invalid-response', 'BaseChat 返回的 message 缺少回答正文。');
  }
  return body.message;
}

async function runBenchmark() {
  const message = input.value.trim();
  if (pending.value || !message) return;

  const request = new AbortController();
  controller = request;
  pending.value = true;
  error.value = '';
  result.value = null;
  progress.value = '等待 BaseChat 回复…';
  const started = performance.now();

  function appendText(text) {
    result.value ??= { message, answer: '', firstTextMs: null };
    result.value.answer += text;
    progress.value = '正在接收回答…';
    if (result.value.firstTextMs === null && text.trim()) {
      result.value.firstTextMs = Math.round(performance.now() - started);
    }
  }

  try {
    const options = { app, message, signal: request.signal };
    if (mode.value === 'events') {
      await sendEventStreamRequest({
        ...options,
        onText: appendText,
        onStage(event) {
          progress.value = event === 'turn.started' ? '本轮已开始…' : '正在生成…';
        },
      });
      result.value ??= { message, answer: '', firstTextMs: null };
    } else if (mode.value === 'stream') {
      await sendStreamRequest({ ...options, onText: appendText });
    } else {
      const answer = await sendCompleteRequest({ ...options, validateResponse: readAnswer });
      if (!request.signal.aborted) result.value = { message, answer };
    }
    if (!request.signal.aborted) result.value.elapsedMs = Math.round(performance.now() - started);
  } catch (cause) {
    if (!request.signal.aborted) {
      error.value = cause instanceof ChatRequestError ? cause.message : '本次测试未完成，请重新运行。';
    }
  } finally {
    pending.value = false;
    controller = null;
  }
}

onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <section class="benchmark" aria-labelledby="benchmark-title">
    <header class="benchmark-heading">
      <h2 id="benchmark-title">BaseChat Benchmark</h2>
      <code>POST {{ modes[mode].endpoint }}</code>
    </header>
    <form id="benchmark-form" @submit.prevent="runBenchmark">
      <label for="benchmark-input">测试输入</label>
      <div class="composer">
        <textarea id="benchmark-input" v-model="input" rows="3" required></textarea>
        <div class="composer-toolbar">
          <fieldset class="benchmark-modes" @change="result = null; error = ''">
            <legend class="visually-hidden">回复方式</legend>
            <label v-for="(option, value) in modes" :key="value">
              <input v-model="mode" type="radio" name="benchmark-mode" :value="value" :disabled="pending">
              <span>{{ option.label }}</span>
            </label>
          </fieldset>
          <button id="run-benchmark" class="send-button" type="submit" :disabled="pending || !input.trim()">
            {{ pending ? '运行中…' : '运行测试' }}
          </button>
        </div>
      </div>
    </form>
    <p class="benchmark-status" role="status">
      <template v-if="pending">{{ progress }}</template>
      <template v-else-if="error && result">回答中断，已保留收到的内容。</template>
      <template v-else-if="result">已完成 · 请求往返耗时 {{ result.elapsedMs }} ms</template>
      <template v-if="result?.firstTextMs != null"> · 首段正文 {{ result.firstTextMs }} ms</template>
    </p>
    <p v-if="error" class="error-message" role="alert">{{ error }}</p>
    <div v-if="result" class="benchmark-result">
      <h3>本次输入</h3>
      <p class="benchmark-question">{{ result.message }}</p>
      <h3>模型回答</h3>
      <MarkdownMessage :content="result.answer" />
    </div>
  </section>
</template>

<style scoped>
.benchmark { padding: clamp(16px, 3vw, 32px); border: 1px solid var(--line); border-radius: 18px; background: #fffefa; }
.benchmark-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 18px; margin-bottom: 22px; }
.benchmark-heading h2 { margin: 0; font-size: 21px; }
.benchmark-heading code, .benchmark-status { color: var(--muted); font-size: 12px; }
.benchmark-heading code { overflow-wrap: anywhere; }
.benchmark .composer-toolbar { flex-wrap: wrap; }
.benchmark-modes { display: flex; flex-wrap: wrap; gap: 2px; min-width: 0; margin: 0; padding: 3px; border: 1px solid var(--line); border-radius: 9px; }
.benchmark-modes label { position: relative; margin: 0; cursor: pointer; }
.benchmark-modes input { position: absolute; opacity: 0; }
.benchmark-modes span { display: block; padding: 7px 10px; border-radius: 6px; }
.benchmark-modes input:checked + span { color: white; background: var(--green); }
.benchmark-modes input:focus-visible + span { outline: 2px solid var(--green); outline-offset: 2px; }
.benchmark-modes input:disabled + span { opacity: .65; cursor: wait; }
.benchmark-status:empty { margin: 0; }
.benchmark-result { padding-top: 8px; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
.benchmark-result h3 { margin: 14px 0 6px; color: var(--muted); font-size: 12px; }
.benchmark-question { margin: 0; white-space: pre-wrap; }
.benchmark .error-message { margin: 14px 0 0; }
</style>
