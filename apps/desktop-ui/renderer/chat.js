let config = { agentUrl: 'http://127.0.0.1:3000' };
void window.desktop.getConfig().then((value) => {
  config = value;
});

const inputEl = document.getElementById('input');
const replyEl = document.getElementById('reply');
const approvalEl = document.getElementById('approval');
const approvalTextEl = document.getElementById('approval-text');
let sessionId = null;
let pendingRequestId = null;

async function ensureSession() {
  if (!sessionId) {
    try {
      const stored = localStorage.getItem(`promise-ai:session:${config.agentUrl}`);
      if (stored) sessionId = stored;
    } catch {
      // localStorage may be unavailable; a fresh session is created below
    }
  }
  if (sessionId) {
    try {
      const res = await fetch(`${config.agentUrl}/api/sessions/${sessionId}`);
      if (res.ok) return sessionId;
    } catch {
      // fall through to creating a fresh session
    }
    sessionId = null;
  }
  const res = await fetch(`${config.agentUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`无法连接 Agent Server（${res.status}）`);
  sessionId = (await res.json()).id;
  try {
    localStorage.setItem(`promise-ai:session:${config.agentUrl}`, sessionId);
  } catch {
    // localStorage may be unavailable; the session still works for this run
  }
}

function hideApproval() {
  pendingRequestId = null;
  approvalEl.classList.add('hidden');
}

async function respondApproval(approved) {
  if (!pendingRequestId || !sessionId) return;
  const requestId = pendingRequestId;
  hideApproval();
  try {
    await fetch(`${config.agentUrl}/api/sessions/${sessionId}/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, approved }),
    });
  } catch {
    replyEl.textContent = '审批提交失败，请检查 Agent Server 连接';
  }
}

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  replyEl.textContent = '';
  replyEl.classList.add('thinking');

  try {
    await ensureSession();
    const res = await fetch(`${config.agentUrl}/api/sessions/${sessionId}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok || !res.body) throw new Error(`chat failed: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let reply = '';
    let failed = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 2);
        if (!block.startsWith('data: ')) continue;
        const event = JSON.parse(block.slice(6));
        if (event.type === 'chat.token') {
          reply += event.payload?.delta ?? '';
          replyEl.textContent = reply;
          replyEl.scrollTop = replyEl.scrollHeight;
        } else if (event.type === 'agent.state') {
          if (event.payload?.state === 'thinking') {
            replyEl.classList.add('thinking');
          } else {
            replyEl.classList.remove('thinking');
          }
        } else if (event.type === 'permission.request') {
          const request = event.payload?.request;
          if (request?.requestId) {
            pendingRequestId = request.requestId;
            approvalTextEl.textContent = `需要确认：「${request.toolName}」`;
            approvalEl.classList.remove('hidden');
          }
        } else if (event.type === 'permission.response') {
          hideApproval();
        } else if (event.type === 'chat.error') {
          failed = true;
          replyEl.textContent = `出错：${event.payload?.error ?? '未知错误'}`;
        }
      }
    }
    if (!failed) replyEl.textContent = reply || '(无回复)';
    replyEl.scrollTop = replyEl.scrollHeight;
  } catch (error) {
    replyEl.textContent = `出错：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    replyEl.classList.remove('thinking');
  }
}

inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void sendMessage();
  if (event.key === 'Escape') window.close();
});

document.getElementById('approval-allow').addEventListener('click', () => {
  void respondApproval(true);
});
document.getElementById('approval-deny').addEventListener('click', () => {
  void respondApproval(false);
});

inputEl.focus();
