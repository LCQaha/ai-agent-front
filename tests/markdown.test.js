// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownMessage from '../src/components/MarkdownMessage.vue'
import { renderMarkdown } from '../src/utils/markdown.js'

function renderIntoElement(content) {
  const element = document.createElement('div')
  element.innerHTML = renderMarkdown(content)
  return element
}

function expectInert(element) {
  expect(element.querySelector('script, img, svg, math, iframe, video, audio, source, object, embed, style, link, form')).toBeNull()

  for (const node of element.querySelectorAll('*')) {
    for (const attribute of node.attributes) {
      expect(attribute.name).not.toMatch(/^on/iu)
      expect(attribute.name).not.toBe('style')
      if (attribute.name === 'href') {
        const protocol = new URL(attribute.value, 'https://test.invalid/').protocol
        expect(['http:', 'https:', 'mailto:']).toContain(protocol)
      }
    }
  }
}

describe('renderMarkdown', () => {
  it('renders headings, lists, quotes, tables, emphasis and code as semantic HTML', () => {
    const element = renderIntoElement([
      '# 学习记录',
      '',
      '## 小结',
      '',
      '- **第一步**',
      '- *第二步*',
      '',
      '1. 开始',
      '2. 结束',
      '',
      '> 一个引用',
      '',
      '| 组件 | 用途 |',
      '| --- | --- |',
      '| Client | 调用 |',
      '',
      '使用 `ChatClient`。',
      '',
      '```java',
      'String text = "<script>alert(1)</script>";',
      '```',
    ].join('\n'))

    expect(element.querySelector('h1')?.textContent).toBe('学习记录')
    expect(element.querySelector('h2')?.textContent).toBe('小结')
    expect(element.querySelectorAll('ul li')).toHaveLength(2)
    expect(element.querySelectorAll('ol li')).toHaveLength(2)
    expect(element.querySelector('strong')?.textContent).toBe('第一步')
    expect(element.querySelector('em')?.textContent).toBe('第二步')
    expect(element.querySelector('blockquote')?.textContent).toContain('一个引用')
    expect(element.querySelectorAll('table th')).toHaveLength(2)
    expect(element.querySelector('table td')?.textContent).toBe('Client')
    expect(element.querySelector('p code')?.textContent).toBe('ChatClient')
    expect(element.querySelector('pre code.language-java')?.textContent).toContain('<script>alert(1)</script>')
    expectInert(element)
  })

  it.each([
    ['[文档](https://example.com/docs?q=ai)', 'https://example.com/docs?q=ai'],
    ['<https://example.com>', 'https://example.com'],
    ['https://example.com/path', 'https://example.com/path'],
    ['[站内页面](/docs)', '/docs'],
    ['[目录](#chapter)', '#chapter'],
    ['[邮件](mailto:learn@example.com)', 'mailto:learn@example.com'],
  ])('keeps safe links with protected new-tab attributes: %s', (input, href) => {
    const element = renderIntoElement(input)
    const link = element.querySelector('a')
    expect(link?.getAttribute('href')).toBe(href)
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it.each([
    '[执行](javascript:alert(1))',
    '[执行](JaVaScRiPt:alert%281%29)',
    '[执行](javascript&#x3a;alert(1))',
    '[执行](javascript&#58;alert(1))',
    '[执行](java&#x09;script:alert(1))',
    '[执行](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[执行](vbscript:msgbox(1))',
    '[本地文件](file:///etc/passwd)',
    '[临时内容](blob:https://example.com/123)',
  ])('never renders dangerous URLs as active links: %s', (input) => {
    const element = renderIntoElement(input)
    expectInert(element)
    expect(element.querySelector('a[href]')).toBeNull()
  })

  it.each([
    '<script>window.__markdownXss = true</script>',
    '<img src="https://example.com/track" onerror="window.__markdownXss=true">',
    '<svg><a xlink:href="javascript:alert(1)"><text>click</text></a></svg>',
    '<svg onload="alert(1)"></svg>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<video autoplay src="https://example.com/video.mp4"></video>',
    '<style>@import "https://example.com/track.css";</style>',
    '<a href="https://example.com" onclick="alert(1)" target="_self">原始链接</a>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=1 onerror=alert(1)>">',
  ])('treats raw HTML and mixed-namespace payloads as inert text: %s', (input) => {
    const element = renderIntoElement(input)
    expectInert(element)
    expect(element.textContent).toContain('<')
  })

  it('replaces Markdown images with escaped descriptions without loading media', () => {
    const element = renderIntoElement([
      '![模型架构图](https://example.com/tracking.png)',
      '![<img src=x onerror=alert(1)>](https://example.com/image.png)',
      '![](data:image/png;base64,aGVsbG8=)',
    ].join('\n\n'))

    expect(element.querySelectorAll('.markdown-image-placeholder')).toHaveLength(3)
    expect(element.textContent).toContain('[图片：模型架构图]')
    expect(element.textContent).toContain('[图片：未命名图片]')
    expectInert(element)
    expect(element.querySelector('[src], [srcset]')).toBeNull()
  })

  it('returns empty output for missing, null or non-text content', () => {
    expect(renderMarkdown()).toBe('')
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown(null)).toBe('')
    expect(renderMarkdown({ html: '<script>alert(1)</script>' })).toBe('')
  })
})

describe('MarkdownMessage', () => {
  it('starts empty and updates sanitized output when content changes', async () => {
    const wrapper = mount(MarkdownMessage)
    expect(wrapper.classes()).toContain('markdown-message')
    expect(wrapper.text()).toBe('')

    await wrapper.setProps({ content: '# 第一版\n\n**加粗**' })
    expect(wrapper.find('h1').text()).toBe('第一版')
    expect(wrapper.find('strong').text()).toBe('加粗')

    await wrapper.setProps({ content: '<img src=x onerror=alert(1)>\n\n[文档](https://example.com)' })
    expect(wrapper.find('h1').exists()).toBe(false)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('a').attributes('rel')).toBe('noopener noreferrer')
    expectInert(wrapper.element)
    wrapper.unmount()
  })
})
