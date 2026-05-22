const fs = require('fs');
const path = require('path');

const dotenv = require('dotenv');
const express = require('express');
const OpenAI = require('openai');

const baseDir = __dirname;
dotenv.config({ path: path.join(baseDir, '.env') });

const app = express();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const openAiTimeoutMs = Number.parseInt(process.env.OPENAI_TIMEOUT_MS || '10000', 10);
const rateLimitWindowSeconds = Number.parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS || '300', 10);
const rateLimitMaxRequests = Number.parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '5', 10);
const allowedCorsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowAllCorsOrigins = allowedCorsOrigins.includes('*');
const requestLog = new Map();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(baseDir));

app.use((req, res, next) => {
  const requestOrigin = req.headers.origin;

  if (!requestOrigin) {
    return next();
  }

  const isAllowed = allowAllCorsOrigins || allowedCorsOrigins.includes(requestOrigin);

  if (!isAllowed) {
    if (req.method === 'OPTIONS') {
      return res.sendStatus(403);
    }

    return res.status(403).json({
      error: 'Request origin is not allowed. Add this origin to CORS_ORIGINS on the server.',
    });
  }

  res.setHeader('Access-Control-Allow-Origin', allowAllCorsOrigins ? '*' : requestOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (!allowAllCorsOrigins) {
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  return next();
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({
      error: 'Invalid JSON body. Send valid JSON with Content-Type: application/json.',
    });
  }

  return next(error);
});

function isRateLimited(clientId) {
  const now = Date.now();
  const windowStart = now - rateLimitWindowSeconds * 1000;
  const recentRequests = (requestLog.get(clientId) || []).filter((timestamp) => timestamp >= windowStart);

  requestLog.set(clientId, recentRequests);

  if (recentRequests.length >= rateLimitMaxRequests) {
    return true;
  }

  recentRequests.push(now);
  requestLog.set(clientId, recentRequests);
  return false;
}

function buildPrompt(userStory, testType) {
  return `
You are a QA expert.

Generate detailed test cases from the user story below.

Return only valid JSON with this exact shape:
{
  "testCases": [
    {
      "testId": "TC-001",
      "scenario": "...",
      "precondition": "...",
      "steps": ["...", "..."],
      "expectedResult": "...",
      "priority": "High"
    }
  ]
}

Rules:
- Include positive, negative, and edge coverage where relevant.
- Cover validation and error scenarios.
- Keep priorities limited to High, Medium, or Low.
- Keep steps actionable and concise.
- Tailor the output to this requested focus: ${testType}.
- Generate at least 8 test cases unless the story is too small.
- Do not include markdown, explanations, or code fences.

User Story:
${userStory}
  `.trim();
}

function buildAssistantPrompt(userInput) {
  return `
You are a helpful AI assistant in a small web app.

Respond clearly and directly to the user's request.
- Keep the answer practical and easy to read.
- Use short paragraphs or bullets when helpful.
- Do not include markdown code fences unless the user asks for code.

User input:
${userInput}
  `.trim();
}

function buildAssistantMessages(userInput, history) {
  const messages = [
    {
      role: 'system',
      content: 'You are a practical assistant helping users in a web app. Answer clearly, directly, and helpfully.',
    },
  ];

  history.forEach((entry) => {
    const role = entry && entry.role;
    const content = typeof entry?.content === 'string' ? entry.content.trim() : '';
    if (!['user', 'assistant'].includes(role) || !content) {
      return;
    }

    messages.push({ role, content });
  });

  messages.push({ role: 'user', content: buildAssistantPrompt(userInput) });
  return messages;
}

function getClient() {
  // Prefer GitHub Models (free with a GitHub token)
  if (GITHUB_TOKEN) {
    return new OpenAI({
      baseURL: 'https://models.inference.ai.azure.com',
      apiKey: GITHUB_TOKEN,
    });
  }

  // Fall back to direct OpenAI
  if (OPENAI_API_KEY) {
    return new OpenAI({ apiKey: OPENAI_API_KEY });
  }

  return null;
}

function getClientId(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'anonymous';
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

function getOpenAiErrorDetails(error, actionLabel) {
  const statusCode = error?.status || error?.statusCode || 502;
  const rawMessage = error?.error?.message || error?.message || `Failed to ${actionLabel}.`;
  const normalizedMessage = rawMessage.toLowerCase();

  if (statusCode === 429 && normalizedMessage.includes('quota')) {
    return {
      statusCode: 429,
      message: 'OpenAI API quota has been exceeded for this API key. Check billing, usage limits, and the selected project for your OpenAI account.',
    };
  }

  if (statusCode === 429) {
    return {
      statusCode: 429,
      message: 'OpenAI is rate limiting this request right now. Wait a moment and try again.',
    };
  }

  if (statusCode === 401) {
    return {
      statusCode: 401,
      message: 'The OpenAI API key is invalid or does not have access to the requested model.',
    };
  }

  if (statusCode === 403) {
    return {
      statusCode: 403,
      message: 'The OpenAI account does not have permission to use this model or endpoint.',
    };
  }

  return {
    statusCode: statusCode >= 400 ? statusCode : 502,
    message: `Failed to ${actionLabel}: ${rawMessage}`,
  };
}

// ── Local test case generator (works without OpenAI) ──

function generateLocalTestCases(userStory, testType) {
  const subject = extractSubject(userStory);
  const templates = getTemplatesForType(testType, subject, userStory);
  return templates.map((t, i) => ({
    testId: `TC-${String(i + 1).padStart(3, '0')}`,
    scenario: t.scenario,
    precondition: t.precondition,
    steps: t.steps.map((s, si) => `${si + 1}. ${s}`).join('\n'),
    expectedResult: t.expectedResult,
    priority: t.priority,
  }));
}

function extractSubject(text) {
  const wantMatch = text.match(/(?:I want to|I need to|I should be able to|allow .+ to)\s+(.+?)(?:\s+so that|\s+in order to|\.|\n|$)/i);
  if (wantMatch) return wantMatch[1].trim().replace(/\.$/, '');
  const first60 = text.substring(0, 80).replace(/\n/g, ' ').trim();
  return first60 || 'perform the action';
}

function getTemplatesForType(testType, subject, story) {
  const lowerType = (testType || '').toLowerCase();
  const base = [
    {
      scenario: `Verify user can ${subject} with valid inputs`,
      precondition: 'User is on the relevant page or screen.',
      steps: [`Navigate to the feature`, `Provide all required valid inputs`, `Submit or trigger the action to ${subject}`],
      expectedResult: `The system successfully processes the request and the user can ${subject}.`,
      priority: 'High',
    },
    {
      scenario: `Verify ${subject} reflects correct data`,
      precondition: 'Valid test data exists in the system.',
      steps: [`Set up the required preconditions`, `Perform the action to ${subject}`, `Review the output or result`],
      expectedResult: 'All displayed data matches the expected values.',
      priority: 'High',
    },
    {
      scenario: `Verify UI elements are present for ${subject}`,
      precondition: 'User has access to the page.',
      steps: [`Navigate to the page`, `Inspect that all labels, buttons and inputs are visible`, `Check alignment and spelling`],
      expectedResult: 'All UI elements render correctly with no visual defects.',
      priority: 'Medium',
    },
    {
      scenario: `Verify required field validation when trying to ${subject}`,
      precondition: 'User is on the form or input screen.',
      steps: [`Leave one or more required fields empty`, `Submit the form`],
      expectedResult: 'Appropriate validation messages are shown and submission is blocked.',
      priority: 'High',
    },
    {
      scenario: `Verify ${subject} with invalid or malformed inputs`,
      precondition: 'User is on the input screen.',
      steps: [`Enter invalid values (special characters, extreme lengths, wrong formats)`, `Attempt to submit`],
      expectedResult: 'The system rejects the input gracefully and shows a clear error.',
      priority: 'High',
    },
    {
      scenario: `Verify ${subject} when session or authentication expires`,
      precondition: 'User session has expired or user is logged out.',
      steps: [`Attempt the action to ${subject}`],
      expectedResult: 'User is redirected to login or shown an appropriate message.',
      priority: 'Medium',
    },
    {
      scenario: `Verify ${subject} under slow network conditions`,
      precondition: 'Simulate a slow or intermittent connection.',
      steps: [`Throttle the network`, `Attempt to ${subject}`],
      expectedResult: 'A loading indicator is shown and the operation completes or times out gracefully.',
      priority: 'Low',
    },
    {
      scenario: `Verify ${subject} on different screen sizes`,
      precondition: 'Access the feature on desktop, tablet, and mobile viewports.',
      steps: [`Open the page on each viewport size`, `Perform the action to ${subject}`],
      expectedResult: 'Layout adapts correctly and the feature works on all sizes.',
      priority: 'Medium',
    },
  ];

  if (lowerType === 'negative') {
    return [
      base[3], base[4], base[5],
      {
        scenario: `Verify ${subject} with SQL injection attempt`,
        precondition: 'User is on the input screen.',
        steps: [`Enter SQL injection strings in input fields`, `Submit the form`],
        expectedResult: 'Input is sanitized and no SQL error or data leak occurs.',
        priority: 'High',
      },
      {
        scenario: `Verify ${subject} with XSS script in input`,
        precondition: 'User is on the input screen.',
        steps: [`Enter script tags or event handlers in text fields`, `Submit and view output`],
        expectedResult: 'Scripts are escaped and not executed in the browser.',
        priority: 'High',
      },
      {
        scenario: `Verify ${subject} with empty payload`,
        precondition: 'User submits the form with no data.',
        steps: [`Clear all fields`, `Click submit`],
        expectedResult: 'Validation prevents submission and shows a message.',
        priority: 'Medium',
      },
      {
        scenario: `Verify ${subject} with duplicate submission`,
        precondition: 'User has already submitted once.',
        steps: [`Submit the form`, `Immediately click submit again`],
        expectedResult: 'Duplicate submission is prevented or handled correctly.',
        priority: 'Medium',
      },
      {
        scenario: `Verify ${subject} when backend service is unavailable`,
        precondition: 'Backend API is down or unreachable.',
        steps: [`Attempt the action to ${subject}`],
        expectedResult: 'A user-friendly error is displayed instead of a raw stack trace.',
        priority: 'High',
      },
    ];
  }

  if (lowerType === 'edge cases') {
    return [
      base[4], base[6],
      {
        scenario: `Verify ${subject} with maximum length input`,
        precondition: 'User is on the input screen.',
        steps: [`Enter the maximum allowed characters in each field`, `Submit`],
        expectedResult: 'System accepts the input and processes it correctly.',
        priority: 'Medium',
      },
      {
        scenario: `Verify ${subject} with unicode and emoji input`,
        precondition: 'User is on the input screen.',
        steps: [`Enter unicode characters and emojis`, `Submit`],
        expectedResult: 'System handles the input without corruption or errors.',
        priority: 'Low',
      },
      {
        scenario: `Verify ${subject} with concurrent users`,
        precondition: 'Multiple users access the same resource simultaneously.',
        steps: [`Simulate concurrent actions`, `Verify data integrity`],
        expectedResult: 'No data corruption or race condition occurs.',
        priority: 'High',
      },
      {
        scenario: `Verify ${subject} at boundary values`,
        precondition: 'Identify min/max boundary values for all numeric fields.',
        steps: [`Enter boundary values (0, 1, max, max+1)`, `Submit`],
        expectedResult: 'Boundary values within range succeed; out-of-range values are rejected.',
        priority: 'High',
      },
      {
        scenario: `Verify ${subject} when browser back button is used`,
        precondition: 'User has completed or started the action.',
        steps: [`Click the browser back button`, `Attempt to resubmit or navigate forward`],
        expectedResult: 'No duplicate action occurs and state is consistent.',
        priority: 'Medium',
      },
      {
        scenario: `Verify ${subject} after page refresh mid-action`,
        precondition: 'User is in the middle of the action.',
        steps: [`Refresh the page`, `Check state`],
        expectedResult: 'User is returned to a safe state with no data loss.',
        priority: 'Medium',
      },
    ];
  }

  if (lowerType === 'bdd format') {
    return base.map((t) => ({
      ...t,
      scenario: `Scenario: ${t.scenario}`,
      steps: [`Given ${t.precondition}`, ...t.steps.map((s) => `When ${s}`), `Then ${t.expectedResult}`],
      precondition: '(see Given step)',
      expectedResult: '(see Then step)',
    }));
  }

  return base;
}

// ── Local assistant (works without OpenAI) ──

function generateLocalAssistantAnswer(userInput) {
  return (
    `Here is my response to your query:\n\n` +
    `You asked: "${userInput.length > 200 ? userInput.substring(0, 200) + '...' : userInput}"\n\n` +
    `This app is currently running in local mode without an active OpenAI API connection. ` +
    `The test case generator works fully offline, but the AI assistant needs a valid OpenAI API key with available quota to give detailed answers.\n\n` +
    `To enable full AI responses, add a funded OpenAI API key to the .env file and restart the server.`
  );
}

// ── Routes ──

app.get('/', (req, res) => {
  res.sendFile(path.join(baseDir, 'index.html'));
});

app.post('/generate-testcases', async (req, res) => {
  const userStory = (req.body?.userStory || req.body?.query || '').trim();
  const testType = (req.body?.testType || 'Functional').trim();

  if (!userStory) {
    return res.status(400).json({ error: 'User story is required.' });
  }

  // Try OpenAI first if key is available
  const client = getClient();
  if (client) {
    const clientId = getClientId(req);
    if (isRateLimited(clientId)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please wait a few minutes and try again.' });
    }

    try {
      const completion = await withTimeout(
        client.chat.completions.create({
          model: AI_MODEL,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'You generate structured QA test cases in strict JSON.' },
            { role: 'user', content: buildPrompt(userStory, testType) },
          ],
        }),
        openAiTimeoutMs,
        'Generate test cases request'
      );

      const content = completion.choices?.[0]?.message?.content || '{}';
      const parsed = JSON.parse(content);
      const testCases = parsed.testCases;

      if (!Array.isArray(testCases)) {
        throw new Error('Model response did not include a testCases array.');
      }

      const normalized = testCases.map((testCase, index) => {
        const steps = Array.isArray(testCase.steps)
          ? testCase.steps.map((step, stepIndex) => `${stepIndex + 1}. ${step}`).join('\n')
          : String(testCase.steps || '');

        return {
          testId: testCase.testId || `TC-${String(index + 1).padStart(3, '0')}`,
          scenario: testCase.scenario || '',
          precondition: testCase.precondition || '',
          steps,
          expectedResult: testCase.expectedResult || '',
          priority: testCase.priority || 'Medium',
        };
      });

      return res.json({ testCases: normalized });
    } catch (error) {
      console.log('OpenAI unavailable, falling back to local generator:', error.message);
    }
  }

  // Fallback: generate locally
  const testCases = generateLocalTestCases(userStory, testType);
  return res.json({ testCases });
});

app.post('/ask-ai', async (req, res) => {
  const userInput = (req.body?.message || req.body?.query || '').trim();
  const history = req.body?.history || [];

  if (!userInput) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  if (!Array.isArray(history)) {
    return res.status(400).json({ error: 'History must be an array.' });
  }

  // Try OpenAI first if key is available
  const client = getClient();
  if (client) {
    const clientId = getClientId(req);
    if (isRateLimited(clientId)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please wait a few minutes and try again.' });
    }

    try {
      const completion = await withTimeout(
        client.chat.completions.create({
          model: AI_MODEL,
          messages: buildAssistantMessages(userInput, history.slice(-12)),
        }),
        openAiTimeoutMs,
        'Assistant request'
      );

      const answer = completion.choices?.[0]?.message?.content || '';
      return res.json({ answer: answer.trim() });
    } catch (error) {
      console.log('OpenAI unavailable, falling back to local assistant:', error.message);
    }
  }

  // Fallback: respond locally
  return res.json({ answer: generateLocalAssistantAnswer(userInput) });
});

app.get('*', (req, res) => {
  const filePath = path.join(baseDir, req.path);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return res.sendFile(filePath);
  }

  return res.sendFile(path.join(baseDir, 'index.html'));
});

const port = Number.parseInt(process.env.PORT || '5000', 10);
app.listen(port, () => {
  console.log(`Server running at http://127.0.0.1:${port}`);
});