// Register an app only after its backend endpoint is available.
export const APP_REGISTRY = Object.freeze([
  Object.freeze({
    id: 'loveapp',
    name: 'LoveApp',
    label: 'LoveApp',
    description: '围绕你的问题，开始一段连续对话。',
    endpoint: '/api/ai/love/v1',
    streamEndpoint: null,
    suggestions: Object.freeze([
      Object.freeze({ label: '表达感受', prompt: '怎样更自然地表达自己的感受？' }),
      Object.freeze({ label: '改善沟通', prompt: '我们最近总因为小事争执，该怎么沟通？' }),
      Object.freeze({ label: '聊聊一段关系', prompt: '我想理清一段关系，可以陪我聊聊吗？' }),
    ]),
  }),
  Object.freeze({
    id: 'firstapp',
    name: 'FirstApp',
    description: '记住同一会话里的提问和回答，可随时切换回复方式。',
    endpoint: '/api/ai/first-app',
    eventStreamEndpoint: '/api/ai/first-app/event-stream',
    suggestions: Object.freeze([
      Object.freeze({ label: '记下一个代号', prompt: '请记住，我的代号是青松。' }),
      Object.freeze({ label: '接着上次聊', prompt: '我刚才告诉你的代号是什么？' }),
    ]),
  }),
]);
