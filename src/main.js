import './style.css';

const $ = (selector) => document.querySelector(selector);
const recordButton = $('#recordButton');
const recordLabel = $('#recordLabel');
const sourceLanguage = $('#sourceLanguage');
const targetLanguage = $('#targetLanguage');
const sourceTranscript = $('#sourceTranscript');
const targetTranscript = $('#targetTranscript');
const statusMessage = $('#statusMessage');
const sessionState = $('#sessionState');
const timerElement = $('#timer');
const timerWrap = $('.timer');
const waveform = $('#waveform');
const toast = $('#toast');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const languageMeta = {
  'zh-CN': { short: '中文', name: '简体中文', target: '简体中文' },
  'en-US': { short: 'EN', name: 'English', target: 'English' },
  'yue-Hant-HK': { short: '粵語', name: '粤语', target: '繁體中文' },
  'ja-JP': { short: '日語', name: '日语', target: '日本語' },
  'ko-KR': { short: '한국어', name: '韩语', target: '한국어' },
  'fr-FR': { short: 'FR', name: '法语', target: 'Français' },
  'de-DE': { short: 'DE', name: '德语', target: 'Deutsch' },
  'es-ES': { short: 'ES', name: '西班牙语', target: 'Español' },
};
const targetShort = { English: 'EN', 简体中文: '中文', 繁體中文: '繁中', 日本語: '日語', 한국어: '한국어', Français: 'FR', Deutsch: 'DE', Español: 'ES' };

let recognition;
let recording = false;
let starting = false;
let recognitionActive = false;
let recognitionStartingAt = 0;
let recognitionWatchdog;
let lastRecognitionActivity = 0;
let lastSoundAt = 0;
let reconnectTimer;
let reconnectAttempts = 0;
let lastRecognitionError = '';
let entries = [];
let interimText = '';
let interimTranslation = '';
let elapsedBefore = 0;
let startedAt = 0;
let timerInterval;
let audioStream;
let audioContext;
let analyser;
let animationFrame;
let toastTimeout;
let interimTranslateTimer;
let interimRequest = 0;
let translationJobs = [];
let activeTranslations = 0;
const translationCache = new Map();
const translationRequests = new Map();
let backendAvailable = true;
let backendCheckTimer;
let backendCheckInFlight = false;

for (let i = 0; i < 24; i += 1) {
  const bar = document.createElement('i');
  bar.style.height = `${3 + (i % 4)}px`;
  waveform.appendChild(bar);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function formatTime(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function entryTime(entry) {
  return formatTime(entry.at);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 2200);
}

function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle('error', isError);
}

function renderPanel(container, type) {
  const isTarget = type === 'target';
  const empty = `<div class="empty-state"><span class="empty-icon">${isTarget ? 'A<span>文</span>' : '<svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/></svg>'}</span><p>${isTarget ? '译文将随原文同步生成<br />无需复制或切换页面' : '点击下方麦克风<br />开始说话，原文会出现在这里'}</p></div>`;
  if (!entries.length && !interimText) {
    container.innerHTML = empty;
    return;
  }

  const finalHtml = entries.map((entry) => {
    const text = isTarget ? entry.translation : entry.text;
    let status = '';
    if (isTarget && entry.status === 'pending') status = '<span class="entry-status">正在翻译</span>';
    if (isTarget && entry.status === 'error') status = '<span class="entry-status error">翻译失败，点击重试</span>';
    return `<article class="transcript-entry" ${isTarget && entry.status === 'error' ? `data-retry="${entry.id}" role="button" tabindex="0"` : ''}>
      <time class="entry-time">${entryTime(entry)}</time>
      <div><p class="entry-text">${escapeHtml(text || (isTarget ? '…' : ''))}</p>${status}</div>
    </article>`;
  }).join('');

  const liveText = isTarget ? interimTranslation : interimText;
  const liveHtml = interimText ? `<article class="transcript-entry interim-entry"><time class="entry-time">现在</time><div><p class="entry-text">${escapeHtml(liveText || (isTarget ? '聆听中…' : ''))}</p></div></article>` : '';
  container.innerHTML = finalHtml + liveHtml;
  requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
}

function render() {
  renderPanel(sourceTranscript, 'source');
  renderPanel(targetTranscript, 'target');
  const hasContent = entries.length > 0 || Boolean(interimText);
  $('#clearButton').disabled = !hasContent;
  $('#copyButton').disabled = !entries.length;
  $('#exportButton').disabled = !entries.length;
}

function retryFailedTranslations() {
  entries.filter((entry) => entry.status === 'error').forEach((entry) => translateEntry(entry));
  if (interimText) scheduleInterimTranslation();
}

async function checkBackendRecovery() {
  if (backendCheckInFlight || backendAvailable) return;
  backendCheckInFlight = true;
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    if (!response.ok) throw new Error('Backend is unavailable');
    backendAvailable = true;
    clearInterval(backendCheckTimer);
    backendCheckTimer = null;
    setStatus('翻译服务已恢复，正在自动重试失败内容');
    retryFailedTranslations();
  } catch {
    backendAvailable = false;
  } finally {
    backendCheckInFlight = false;
  }
}

function scheduleBackendRecovery() {
  backendAvailable = false;
  setStatus('翻译服务连接中断，正在自动检查；已有原文会保留', true);
  if (!backendCheckTimer) backendCheckTimer = setInterval(checkBackendRecovery, 5000);
  checkBackendRecovery();
}

function fetchTranslation(text) {
  const source = languageMeta[sourceLanguage.value]?.name || 'auto';
  const target = targetLanguage.value;
  const key = `${source}|${target}|${text}`;
  if (translationCache.has(key)) return Promise.resolve(translationCache.get(key));
  if (translationRequests.has(key)) return translationRequests.get(key);

  const request = fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, source, target }),
  }).then(async (response) => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '翻译失败');
    translationCache.set(key, data.translation);
    if (translationCache.size > 300) translationCache.delete(translationCache.keys().next().value);
    return data.translation;
  }).catch((error) => {
    if (error instanceof TypeError && /fetch/i.test(error.message)) {
      scheduleBackendRecovery();
      throw new Error('翻译服务未连接，恢复后会自动重试');
    }
    throw error;
  }).finally(() => translationRequests.delete(key));
  translationRequests.set(key, request);
  return request;
}

function drainTranslationQueue() {
  while (activeTranslations < 2 && translationJobs.length) {
    const job = translationJobs.shift();
    activeTranslations += 1;
    fetchTranslation(job.text)
      .then(job.resolve)
      .catch(job.reject)
      .finally(() => {
        activeTranslations -= 1;
        drainTranslationQueue();
      });
  }
}

function queueTranslation(text) {
  return new Promise((resolve, reject) => {
    translationJobs.push({ text, resolve, reject });
    drainTranslationQueue();
  });
}

function translateEntry(entry) {
  entry.status = 'pending';
  entry.translation = '';
  render();
  queueTranslation(entry.text).then((translation) => {
    entry.translation = translation;
    entry.status = 'done';
    if (recording) setStatus('正在聆听，请自然说话');
  }).catch((error) => {
    entry.translation = '暂未生成译文';
    entry.status = 'error';
    setStatus(error.message || '翻译失败，请点击译文重试', true);
  }).finally(render);
}

function scheduleInterimTranslation() {
  clearTimeout(interimTranslateTimer);
  interimTranslateTimer = setTimeout(async () => {
    const text = interimText.trim();
    if (!text) return;
    const requestId = ++interimRequest;
    interimTranslation = '翻译中…';
    render();
    try {
      const translation = await fetchTranslation(text);
      if (requestId === interimRequest && interimText.trim() === text) {
        interimTranslation = translation;
        render();
      }
    } catch {
      if (requestId === interimRequest) {
        interimTranslation = '翻译暂时不可用，将在下一句重试';
        render();
      }
    }
  }, 1200);
}

function scheduleRecognitionRestart() {
  if (!recording || reconnectTimer) return;
  reconnectAttempts += 1;
  const isNetworkError = lastRecognitionError === 'network';
  const delay = isNetworkError ? Math.min(10_000, 500 * (2 ** (reconnectAttempts - 1))) : 350;
  if (isNetworkError) {
    setStatus(`识别连接中断，${Math.ceil(delay / 1000)} 秒后自动重连（第 ${reconnectAttempts} 次）`, true);
    sessionState.classList.remove('listening');
    sessionState.innerHTML = '<span></span>正在重连';
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!recording || recognitionActive) return;
    try {
      recognitionStartingAt = Date.now();
      lastRecognitionActivity = Date.now();
      recognition.start();
    } catch (error) {
      if (error.name === 'InvalidStateError') {
        recognitionActive = true;
        recognitionStartingAt = 0;
        lastRecognitionActivity = Date.now();
      } else {
        recognitionStartingAt = 0;
        lastRecognitionError = 'network';
        scheduleRecognitionRestart();
      }
    }
  }, delay);
}

function restartStalledRecognition(message) {
  if (!recording || reconnectTimer) return;
  recognitionActive = false;
  recognitionStartingAt = 0;
  lastRecognitionError = 'stalled';
  setStatus(message, true);
  sessionState.classList.remove('listening');
  sessionState.innerHTML = '<span></span>正在恢复';
  try { recognition.abort(); } catch { /* A stalled engine may already be stopped. */ }
  scheduleRecognitionRestart();
}

function startRecognitionWatchdog() {
  clearInterval(recognitionWatchdog);
  recognitionWatchdog = setInterval(() => {
    if (!recording) return;
    const now = Date.now();
    if (!recognitionActive && recognitionStartingAt && now - recognitionStartingAt > 12_000) {
      restartStalledRecognition('识别服务启动超时，正在自动重试；已有内容会保留');
      return;
    }
    const hasRecentSound = lastSoundAt && now - lastSoundAt < 5000;
    if (recognitionActive && hasRecentSound && now - lastRecognitionActivity > 18_000) {
      restartStalledRecognition('检测到识别无响应，正在自动恢复；已有内容会保留');
    }
  }, 2000);
}

function setupRecognition() {
  if (!SpeechRecognition) return;
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    if (!recording) {
      try { recognition.stop(); } catch { /* The session was cancelled while starting. */ }
      return;
    }
    recognitionActive = true;
    recognitionStartingAt = 0;
    lastRecognitionActivity = Date.now();
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    setStatus('正在聆听，请自然说话');
    sessionState.classList.add('listening');
    sessionState.innerHTML = '<span></span>正在聆听';
  };

  recognition.onsoundstart = () => {
    if (recording) lastSoundAt = Date.now();
  };

  recognition.onresult = (event) => {
    if (!recording) return;
    lastRecognitionActivity = Date.now();
    reconnectAttempts = 0;
    lastRecognitionError = '';
    let nextInterim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const text = event.results[i][0].transcript.trim();
      if (!text) continue;
      if (event.results[i].isFinal) {
        const entry = {
          id: `${Date.now()}-${i}-${Math.random().toString(16).slice(2)}`,
          text,
          translation: '',
          status: 'pending',
          at: elapsedBefore + (startedAt ? Date.now() - startedAt : 0),
        };
        entries.push(entry);
        translateEntry(entry);
      } else {
        nextInterim += `${text} `;
      }
    }
    interimText = nextInterim.trim();
    interimTranslation = '';
    if (interimText) scheduleInterimTranslation();
    else clearTimeout(interimTranslateTimer);
    render();
  };

  recognition.onerror = (event) => {
    if (!recording || event.error === 'aborted') return;
    lastRecognitionError = event.error;
    const messages = {
      'not-allowed': '麦克风权限未开启，请点击地址栏的麦克风图标，允许后重试',
      'service-not-allowed': '浏览器未允许语音识别服务，请换用最新版 Edge 或 Chrome',
      'audio-capture': '未检测到可用麦克风，请检查设备连接',
      'no-speech': '暂时没有听到声音，将自动保持识别连接',
      'network': '识别连接中断，将自动重连；已有内容会保留',
      'language-not-supported': '当前浏览器不支持所选识别语言',
    };
    const message = messages[event.error] || `语音识别暂时中断：${event.error}`;
    const isFatal = ['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(event.error);
    if (isFatal) {
      stopRecording();
      setStatus(message, true);
    } else {
      setStatus(message, event.error === 'network');
    }
  };

  recognition.onend = () => {
    recognitionActive = false;
    recognitionStartingAt = 0;
    scheduleRecognitionRestart();
  };

  window.addEventListener('offline', () => {
    if (!recording) return;
    lastRecognitionError = 'network';
    setStatus('网络已断开，恢复后会自动接续识别；已有内容会保留', true);
  });
  window.addEventListener('online', () => {
    if (!recording) return;
    lastRecognitionError = 'network';
    recognitionActive = false;
    recognitionStartingAt = 0;
    try { recognition.abort(); } catch { /* Recognition may already be stopped. */ }
    scheduleRecognitionRestart();
  });
}

function updateTimer() {
  const elapsed = elapsedBefore + (recording ? Date.now() - startedAt : 0);
  timerElement.textContent = formatTime(elapsed);
}

function startVisualizer(stream) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  audioContext.resume().catch(() => {});
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.72;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const timeData = new Uint8Array(analyser.fftSize);
  const bars = [...waveform.children];
  const draw = () => {
    if (!recording || !analyser) return;
    analyser.getByteFrequencyData(data);
    analyser.getByteTimeDomainData(timeData);
    const peak = timeData.reduce((value, sample) => Math.max(value, Math.abs(sample - 128)), 0);
    if (peak > 7) lastSoundAt = Date.now();
    bars.forEach((bar, index) => {
      const value = data[Math.floor(index * data.length / bars.length)] || 0;
      bar.style.height = `${Math.max(3, Math.min(30, value / 7))}px`;
    });
    animationFrame = requestAnimationFrame(draw);
  };
  draw();
}

function cancelStart() {
  if (!starting) return;
  starting = false;
  recordButton.setAttribute('aria-label', entries.length ? '继续录音转写' : '开始录音转写');
  recordLabel.textContent = entries.length ? '继续' : '开始转写';
  sessionState.innerHTML = '<span></span>已暂停';
  setStatus('已取消启动，点击麦克风可重试');
}

async function startRecording() {
  if (starting || recording) return;
  if (!SpeechRecognition) {
    setStatus('当前浏览器不支持实时语音识别，请使用最新版 Edge 或 Chrome', true);
    showToast('建议使用最新版 Edge 或 Chrome');
    return;
  }

  starting = true;
  recordButton.setAttribute('aria-label', '取消启动');
  recordLabel.textContent = '等待授权';
  setStatus('正在请求麦克风权限，请在浏览器提示中选择“允许”');
  try {
    let stream = null;
    if (navigator.mediaDevices?.getUserMedia) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    }
    if (!starting) {
      stream?.getTracks().forEach((track) => track.stop());
      return;
    }

    audioStream = stream;
    setStatus('正在启动语音识别…');
    recording = true;
    startedAt = Date.now();
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempts = 0;
    lastRecognitionError = '';
    recognitionActive = false;
    recognitionStartingAt = Date.now();
    lastRecognitionActivity = Date.now();
    lastSoundAt = 0;
    recognition.lang = sourceLanguage.value;
    recognition.start();
    recordButton.classList.add('recording');
    recordButton.setAttribute('aria-label', '停止录音转写');
    recordLabel.textContent = '停止';
    timerWrap.classList.add('active');
    waveform.classList.add('active');
    clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 500);
    updateTimer();
    if (stream) {
      startVisualizer(stream);
      stream.getAudioTracks().forEach((track) => track.addEventListener('ended', () => {
        if (!recording || audioStream !== stream) return;
        stopRecording();
        setStatus('麦克风连接已断开，请检查设备后重新开始', true);
      }, { once: true }));
    }
    startRecognitionWatchdog();
  } catch (error) {
    if (!starting) return;
    recording = false;
    startedAt = 0;
    recognitionActive = false;
    recognitionStartingAt = 0;
    clearInterval(recognitionWatchdog);
    try { recognition.abort(); } catch { /* Recognition did not start. */ }
    audioStream?.getTracks().forEach((track) => track.stop());
    audioStream = null;
    recordButton.classList.remove('recording');
    recordButton.setAttribute('aria-label', entries.length ? '继续录音转写' : '开始录音转写');
    recordLabel.textContent = entries.length ? '继续' : '开始转写';
    timerWrap.classList.remove('active');
    waveform.classList.remove('active');
    sessionState.classList.remove('listening');
    sessionState.innerHTML = '<span></span>启动失败';
    const messages = {
      NotAllowedError: '麦克风权限未开启，请点击地址栏的麦克风图标，选择“允许”后重试',
      SecurityError: '浏览器安全设置阻止了麦克风，请允许 localhost 使用麦克风',
      NotFoundError: '未检测到可用麦克风，请检查设备连接',
      DevicesNotFoundError: '未检测到可用麦克风，请检查设备连接',
      NotReadableError: '麦克风无法读取，可能正被其他应用占用，请检查后重试',
      TrackStartError: '麦克风无法启动，可能正被其他应用占用，请检查后重试',
    };
    setStatus(messages[error.name] || `无法启动语音识别：${error.message || '请使用最新版 Edge 或 Chrome'}`, true);
  } finally {
    starting = false;
  }
}

function stopRecording() {
  if (!recording && !audioStream) return;
  starting = false;
  recording = false;
  recognitionActive = false;
  recognitionStartingAt = 0;
  lastRecognitionActivity = 0;
  lastSoundAt = 0;
  clearInterval(recognitionWatchdog);
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempts = 0;
  lastRecognitionError = '';
  elapsedBefore += startedAt ? Date.now() - startedAt : 0;
  startedAt = 0;
  clearInterval(timerInterval);
  clearTimeout(interimTranslateTimer);
  try { recognition?.stop(); } catch { /* Recognition already stopped. */ }
  audioStream?.getTracks().forEach((track) => track.stop());
  audioStream = null;
  cancelAnimationFrame(animationFrame);
  audioContext?.close().catch(() => {});
  audioContext = null;
  analyser = null;
  [...waveform.children].forEach((bar, index) => { bar.style.height = `${3 + (index % 4)}px`; });
  recordButton.classList.remove('recording');
  recordButton.setAttribute('aria-label', '继续录音转写');
  recordLabel.textContent = '继续';
  timerWrap.classList.remove('active');
  waveform.classList.remove('active');
  sessionState.classList.remove('listening');
  sessionState.innerHTML = '<span></span>已暂停';
  setStatus(entries.length ? '已暂停。可继续说话，或复制、导出本次内容' : '已暂停，点击麦克风可重新开始');
  interimText = '';
  interimTranslation = '';
  updateTimer();
  render();
}

function fullText() {
  return entries.map((entry) => `[${entryTime(entry)}] ${entry.text}\n${entry.translation || '（未翻译）'}`).join('\n\n');
}

async function copyTranscript() {
  try {
    await navigator.clipboard.writeText(fullText());
    showToast('原文与译文已复制');
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = fullText();
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    showToast('原文与译文已复制');
  }
}

function exportTranscript() {
  const blob = new Blob([`声译 · 实时转写翻译\n导出时间：${new Date().toLocaleString('zh-CN')}\n\n${fullText()}\n`], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `声译-${new Date().toISOString().slice(0, 10)}.txt`;
  link.click();
  URL.revokeObjectURL(url);
  showToast('双语逐字稿已导出');
}

recordButton.addEventListener('click', () => {
  if (starting) cancelStart();
  else if (recording) stopRecording();
  else startRecording();
});
$('#copyButton').addEventListener('click', copyTranscript);
$('#exportButton').addEventListener('click', exportTranscript);
$('#clearButton').addEventListener('click', () => {
  if (starting) cancelStart();
  if (recording) stopRecording();
  entries = [];
  interimText = '';
  interimTranslation = '';
  elapsedBefore = 0;
  translationJobs = [];
  updateTimer();
  recordButton.setAttribute('aria-label', '开始录音转写');
  recordLabel.textContent = '开始转写';
  sessionState.innerHTML = '<span></span>准备就绪';
  setStatus('点击开始，并允许浏览器使用麦克风');
  render();
  showToast('已开始新会话');
});

sourceLanguage.addEventListener('change', () => {
  $('#sourceTag').textContent = languageMeta[sourceLanguage.value].short;
  if (starting) cancelStart();
  if (recording) {
    stopRecording();
    setStatus('识别语言已切换，点击继续开始转写');
  }
});

targetLanguage.addEventListener('change', () => {
  $('#targetTag').textContent = targetShort[targetLanguage.value];
  interimTranslation = '';
  entries.forEach((entry) => translateEntry(entry));
  if (interimText) scheduleInterimTranslation();
  render();
});

targetTranscript.addEventListener('click', (event) => {
  const retry = event.target.closest('[data-retry]');
  if (!retry) return;
  const entry = entries.find((item) => item.id === retry.dataset.retry);
  if (entry) translateEntry(entry);
});
targetTranscript.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') event.target.click();
});

window.addEventListener('online', () => {
  if (!backendAvailable) checkBackendRecovery();
});

window.addEventListener('beforeunload', () => {
  clearInterval(backendCheckTimer);
  audioStream?.getTracks().forEach((track) => track.stop());
});

setupRecognition();
if (!SpeechRecognition) {
  setStatus('当前浏览器不支持实时语音识别，请用最新版 Edge 或 Chrome 打开', true);
  $('#supportNote').textContent = '需要 Edge / Chrome';
}
render();
