import createDOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

// Model-supplied images must not cause automatic requests to third-party hosts.
markdown.renderer.rules.image = (tokens, index) => {
  const description = markdown.utils.escapeHtml(tokens[index].content || '未命名图片')
  return `<span class="markdown-image-placeholder">[图片：${description}]</span>`
}

const allowedTags = [
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'strong', 'em', 's', 'del', 'a', 'span',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
]

let purifier

function isSafeLink(href) {
  if (!href || /[\u0000-\u0020\u007f-\u009f]/u.test(href)) return false

  try {
    // markdown-it can encode obfuscated control characters instead of rejecting them.
    // Reject those links too, even when a browser would treat them as relative paths.
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(decodeURIComponent(href))) return false
    // A fixed base also lets relative URLs and fragment links be checked safely.
    const protocol = new URL(href, 'https://markdown.invalid/').protocol
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

function getPurifier() {
  if (purifier) return purifier

  // Use a private instance so link rules cannot change another renderer's hooks.
  purifier = createDOMPurify(window)
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName !== 'A') return

    if (isSafeLink(node.getAttribute('href'))) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    } else {
      node.removeAttribute('href')
      node.removeAttribute('target')
      node.removeAttribute('rel')
    }
  })

  return purifier
}

/** Render only model messages. User messages should continue to use text bindings. */
export function renderMarkdown(content = '') {
  if (typeof content !== 'string' || content.length === 0) return ''

  return getPurifier().sanitize(markdown.render(content), {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: ['href', 'title', 'class', 'target', 'rel', 'start'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  })
}
