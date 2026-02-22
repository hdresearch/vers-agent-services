// ═══════════════════════════════════════════════════════════════════════════
// Chat — Talk to Claude with infra context
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const CHAT_API = '/ui/api/chat';
  let conversationHistory = [];
  let isStreaming = false;
  let currentAbort = null;

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  // Simple markdown-ish rendering
  function renderMarkdown(text) {
    return text
      // Code blocks
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="chat-codeblock"><code>$2</code></pre>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>')
      // Bold
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Headers
      .replace(/^### (.+)$/gm, '<div class="chat-h3">$1</div>')
      .replace(/^## (.+)$/gm, '<div class="chat-h2">$1</div>')
      .replace(/^# (.+)$/gm, '<div class="chat-h1">$1</div>')
      // List items
      .replace(/^- (.+)$/gm, '<div class="chat-li">• $1</div>')
      // Line breaks
      .replace(/\n/g, '<br>');
  }

  function addMessage(role, content, isHtml) {
    const container = document.getElementById('chat-messages');
    if (!container) return null;

    const msg = document.createElement('div');
    msg.className = `chat-msg chat-msg-${role}`;

    const label = document.createElement('div');
    label.className = 'chat-msg-label';
    label.textContent = role === 'user' ? 'You' : 'Claude';

    const body = document.createElement('div');
    body.className = 'chat-msg-body';
    if (isHtml) {
      body.innerHTML = content;
    } else {
      body.innerHTML = renderMarkdown(esc(content));
    }

    msg.appendChild(label);
    msg.appendChild(body);
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
    return body;
  }

  function addSystemNote(text) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const note = document.createElement('div');
    note.className = 'chat-system-note';
    note.textContent = text;
    container.appendChild(note);
    container.scrollTop = container.scrollHeight;
  }

  async function sendMessage() {
    const input = document.getElementById('chat-input');
    if (!input) return;

    const text = input.value.trim();
    if (!text || isStreaming) return;

    input.value = '';
    addMessage('user', text);

    conversationHistory.push({ role: 'user', content: text });

    isStreaming = true;
    updateSendButton();

    const msgBody = addMessage('assistant', '', true);
    msgBody.innerHTML = '<span class="chat-cursor">▊</span>';

    currentAbort = new AbortController();

    try {
      const resp = await fetch(CHAT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: conversationHistory,
          includeContext: true,
        }),
        signal: currentAbort.signal,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        msgBody.innerHTML = `<span class="chat-error">Error: ${esc(err.error || resp.statusText)}</span>`;
        conversationHistory.pop(); // remove the user message
        isStreaming = false;
        updateSendButton();
        return;
      }

      // Parse SSE stream from Anthropic (proxied through)
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const evt = JSON.parse(data);
            if (evt.type === 'content_block_delta' && evt.delta?.text) {
              fullText += evt.delta.text;
              msgBody.innerHTML = renderMarkdown(esc(fullText)) + '<span class="chat-cursor">▊</span>';
              const container = document.getElementById('chat-messages');
              container.scrollTop = container.scrollHeight;
            }
          } catch {
            // skip unparseable lines
          }
        }
      }

      // Final render without cursor
      msgBody.innerHTML = renderMarkdown(esc(fullText));
      conversationHistory.push({ role: 'assistant', content: fullText });
    } catch (e) {
      if (e.name === 'AbortError') {
        msgBody.innerHTML += '<br><span class="chat-error">(stopped)</span>';
      } else {
        msgBody.innerHTML = `<span class="chat-error">Error: ${esc(e.message)}</span>`;
        conversationHistory.pop();
      }
    } finally {
      isStreaming = false;
      currentAbort = null;
      updateSendButton();
    }
  }

  function stopStreaming() {
    if (currentAbort) {
      currentAbort.abort();
    }
  }

  function clearChat() {
    conversationHistory = [];
    const container = document.getElementById('chat-messages');
    if (container) container.innerHTML = '';
    addSystemNote('Chat cleared. Infra context will be refreshed on next message.');
  }

  function updateSendButton() {
    const btn = document.getElementById('chat-send-btn');
    if (!btn) return;
    if (isStreaming) {
      btn.textContent = '⏹';
      btn.title = 'Stop';
      btn.onclick = stopStreaming;
    } else {
      btn.textContent = '↑';
      btn.title = 'Send';
      btn.onclick = sendMessage;
    }
  }

  // ─── Init ───

  window.chatInit = function () {
    const input = document.getElementById('chat-input');
    if (!input) return;

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isStreaming) return;
        sendMessage();
      }
    });

    const clearBtn = document.getElementById('chat-clear-btn');
    if (clearBtn) clearBtn.onclick = clearChat;

    updateSendButton();

    addSystemNote('Chat with Claude about your infrastructure. Your board, feed, registry, logs, and usage data are included as context.');
  };

  window.chatDestroy = function () {
    if (currentAbort) currentAbort.abort();
    isStreaming = false;
  };
})();
