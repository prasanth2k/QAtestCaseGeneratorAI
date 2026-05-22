const revealElements = document.querySelectorAll('.reveal');
const userStoryInput = document.querySelector('#userStory');
const actionTypeSelect = document.querySelector('#actionType');
const testTypeSelect = document.querySelector('#testType');
const testTypeGroup = document.querySelector('#testTypeGroup');
const generateBtn = document.querySelector('#generateBtn');
const askAiBtn = document.querySelector('#askAiBtn');
const voiceBtn = document.querySelector('#voiceBtn');
const exportBtn = document.querySelector('#exportBtn');
const statusMessage = document.querySelector('#statusMessage');
const emptyState = document.querySelector('#emptyState');
const assistantWrapper = document.querySelector('#assistantWrapper');
const assistantResponse = document.querySelector('#assistantResponse');
const resultsWrapper = document.querySelector('#resultsWrapper');
const resultsTableBody = document.querySelector('#resultsTable tbody');
const API_BASE_URL = (document.querySelector('meta[name="api-base-url"]')?.content || '')
  .trim()
  .replace(/\/+$/, '');

let latestRows = [];
let assistantHistory = [];
let recognition = null;
let isVoiceListening = false;

function apiUrl(pathname) {
  return `${API_BASE_URL}${pathname}`;
}

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) {
        return;
      }

      entry.target.classList.add('is-visible');
      revealObserver.unobserve(entry.target);
    });
  },
  {
    threshold: 0.18,
  }
);

revealElements.forEach((element, index) => {
  element.style.transitionDelay = `${index * 80}ms`;
  revealObserver.observe(element);
});

function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle('is-error', isError);
}

function resetOutput() {
  assistantHistory = [];
  assistantResponse.innerHTML = '';
  assistantWrapper.classList.add('is-hidden');
  resultsWrapper.classList.add('is-hidden');
  emptyState.classList.remove('is-hidden');
  exportBtn.disabled = true;
}

function updateActionState() {
  const action = actionTypeSelect.value;
  const isAssistantMode = action === 'assistant';
  const isVoiceMode = action === 'voice';
  const isTestcaseMode = action === 'testcases';

  testTypeGroup.classList.toggle('is-hidden', !isTestcaseMode);
  generateBtn.disabled = !isTestcaseMode;
  askAiBtn.disabled = !isAssistantMode;
  voiceBtn.disabled = !isVoiceMode;
  exportBtn.disabled = !isTestcaseMode || latestRows.length === 0;

  if (!isVoiceMode) {
    stopVoiceChat();
  }
}

function renderRows(rows) {
  latestRows = rows;
  resultsTableBody.innerHTML = '';
  assistantHistory = [];
  assistantResponse.innerHTML = '';
  assistantWrapper.classList.add('is-hidden');

  rows.forEach((row) => {
    const tr = document.createElement('tr');
    const columns = [
      row.testId,
      row.scenario,
      row.precondition,
      row.steps,
      row.expectedResult,
      row.priority,
    ];

    columns.forEach((value) => {
      const td = document.createElement('td');
      td.textContent = value || '';
      tr.appendChild(td);
    });

    resultsTableBody.appendChild(tr);
  });

  emptyState.classList.add('is-hidden');
  resultsWrapper.classList.remove('is-hidden');
  exportBtn.disabled = rows.length === 0;
}

function renderAssistantConversation() {
  latestRows = [];
  resultsTableBody.innerHTML = '';
  assistantResponse.innerHTML = '';

  assistantHistory.forEach((entry) => {
    const message = document.createElement('div');
    message.className = `assistant-message assistant-message-${entry.role}`;

    const label = document.createElement('div');
    label.className = 'assistant-message-role';
    label.textContent = entry.role === 'user' ? 'You' : 'AI';

    const body = document.createElement('div');
    body.className = 'assistant-message-body';
    body.textContent = entry.content;

    message.append(label, body);
    assistantResponse.appendChild(message);
  });

  emptyState.classList.add('is-hidden');
  resultsWrapper.classList.add('is-hidden');
  assistantWrapper.classList.remove('is-hidden');
  exportBtn.disabled = true;
}

function setLoadingState(isLoading, mode) {
  generateBtn.disabled = isLoading || mode !== 'testcases';
  askAiBtn.disabled = isLoading || mode !== 'assistant';
  voiceBtn.disabled = isLoading || mode !== 'voice';
  exportBtn.disabled = true;
  actionTypeSelect.disabled = isLoading;
  testTypeSelect.disabled = isLoading;
}

function getNetworkErrorMessage(actionLabel) {
  if (window.location.protocol === 'file:') {
    return `Unable to ${actionLabel}. Open this app through the local server at http://127.0.0.1:5000 instead of opening index.html directly.`;
  }

  if (API_BASE_URL) {
    return `Unable to ${actionLabel}. The configured backend ${API_BASE_URL} is not reachable.`;
  }

  return `Unable to ${actionLabel}. The backend server is not reachable. Start the local server with npm start and then reload this page.`;
}

async function generateTestCases() {
  const userStory = userStoryInput.value.trim();
  const testType = testTypeSelect.value;

  if (!userStory) {
    setStatus('Enter a user story before generating test cases.', true);
    userStoryInput.focus();
    return;
  }

  setLoadingState(true, 'testcases');
  setStatus('Generating test cases...');

  try {
    const response = await fetch(apiUrl('/generate-testcases'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userStory, testType }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Request failed.');
    }

    renderRows(data.testCases || []);
    setStatus(`Generated ${data.testCases.length} test cases.`);
  } catch (error) {
    resetOutput();
    if (error instanceof TypeError) {
      setStatus(getNetworkErrorMessage('generate test cases'), true);
    } else {
      setStatus(error.message || 'Unable to generate test cases.', true);
    }
  } finally {
    setLoadingState(false, 'testcases');
    updateActionState();
  }
}

async function askAi() {
  const message = userStoryInput.value.trim();

  return askAiWithMessage(message, false);
}

async function askAiWithMessage(message, shouldSpeak) {
  const trimmedMessage = (message || '').trim();

  if (!trimmedMessage) {
    setStatus('Enter a message before asking AI.', true);
    userStoryInput.focus();
    return;
  }

  const mode = actionTypeSelect.value === 'voice' ? 'voice' : 'assistant';
  setLoadingState(true, mode);
  setStatus('Getting AI response...');

  try {
    const response = await fetch(apiUrl('/ask-ai'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: trimmedMessage, history: assistantHistory }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Request failed.');
    }

    assistantHistory.push({ role: 'user', content: trimmedMessage });
    assistantHistory.push({ role: 'assistant', content: data.answer || '' });
    renderAssistantConversation();
    if (mode !== 'voice') {
      userStoryInput.value = '';
    }

    if (shouldSpeak) {
      speakText(data.answer || '');
    }

    setStatus('AI response received.');
  } catch (error) {
    if (!assistantHistory.length) {
      resetOutput();
    }
    if (error instanceof TypeError) {
      setStatus(getNetworkErrorMessage('get AI response'), true);
    } else {
      setStatus(error.message || 'Unable to get AI response.', true);
    }
  } finally {
    setLoadingState(false, mode);
    updateActionState();
  }
}

function getSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function speakText(text) {
  if (!text || !window.speechSynthesis) {
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

function startVoiceChat() {
  const SpeechRecognition = getSpeechRecognition();
  if (!SpeechRecognition) {
    setStatus('Voice mode is not supported in this browser. Use latest Chrome or Edge.', true);
    return;
  }

  if (!recognition) {
    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onresult = async (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript?.trim() || '';
      if (!transcript) {
        setStatus('Could not detect speech. Please try again.', true);
        return;
      }

      userStoryInput.value = transcript;
      await askAiWithMessage(transcript, true);
      if (isVoiceListening) {
        recognition.start();
      }
    };

    recognition.onerror = (event) => {
      if (event.error === 'not-allowed') {
        setStatus('Microphone access is blocked. Allow mic permission and try again.', true);
      } else {
        setStatus(`Voice recognition error: ${event.error}`, true);
      }
    };

    recognition.onend = () => {
      if (isVoiceListening) {
        setStatus('Listening... speak now.');
      }
    };
  }

  isVoiceListening = true;
  voiceBtn.textContent = 'Stop Voice Chat';
  setStatus('Listening... speak now.');
  recognition.start();
}

function stopVoiceChat() {
  isVoiceListening = false;
  if (recognition) {
    recognition.stop();
  }
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  if (voiceBtn) {
    voiceBtn.textContent = 'Start Voice Chat';
  }
}

function toggleVoiceChat() {
  if (isVoiceListening) {
    stopVoiceChat();
    setStatus('Voice chat stopped.');
    return;
  }

  startVoiceChat();
}

function exportToExcel() {
  if (!latestRows.length || !window.XLSX) {
    return;
  }

  const worksheet = window.XLSX.utils.json_to_sheet(latestRows);
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, worksheet, 'Test Cases');
  window.XLSX.writeFile(workbook, 'generated-test-cases.xlsx');
}

actionTypeSelect.addEventListener('change', () => {
  resetOutput();
  setStatus('');
  updateActionState();
});
generateBtn.addEventListener('click', generateTestCases);
askAiBtn.addEventListener('click', askAi);
voiceBtn.addEventListener('click', toggleVoiceChat);
exportBtn.addEventListener('click', exportToExcel);
updateActionState();