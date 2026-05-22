# QA Test Case Generator and AI Assistant

Small Node.js + HTML app that lets users paste a requirement, generate QA test cases through OpenAI, ask a general AI question, and export generated test cases to Excel.

## Why this design

- Users do not log in.
- The browser never receives the OpenAI API key.
- The frontend calls local backend endpoints at `/generate-testcases` and `/ask-ai`.
- A small in-memory rate limit is included for basic protection.

## Deploy with GitHub (recommended)

Use GitHub for source control and Render for hosting the Node server.

1. Push this folder to a GitHub repository.
2. In Render, create a new Web Service from your GitHub repo.
3. Render detects [render.yaml](render.yaml) and applies these settings:
	- Build command: `npm install`
	- Start command: `npm start`
4. Set environment variables in Render:
	- `GITHUB_TOKEN` (recommended) or `OPENAI_API_KEY`
	- `AI_MODEL` (optional, default is `gpt-4o-mini`)
	- `CORS_ORIGINS` (set to your frontend domain)
5. Deploy and open the Render service URL.

## Setup

1. Install Node.js.
2. Install dependencies:

```powershell
npm install
```

3. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
4. Start the app:

```powershell
npm start
```

5. Open `http://127.0.0.1:5000`.

## GitHub Pages + Separate Backend (optional)

GitHub Pages cannot run Node.js APIs, so use this only for the frontend files.

1. Deploy backend on Render (or Railway).
2. Deploy frontend on GitHub Pages.
3. Set your backend URL in [index.html](index.html) by updating the `api-base-url` meta tag value.
4. On backend, set `CORS_ORIGINS` to your GitHub Pages origin.

Example:

```html
<meta name="api-base-url" content="https://your-backend.onrender.com">
```

## Python-Free Runtime

- The recommended local runtime is now Node.js.
- The existing `app.py` file can be kept as a reference, but it is no longer required to run the app locally.

## Notes

- Test type options are Functional, Negative, Edge Cases, and BDD Format.
- Assistant mode returns a normal AI reply in the same page.
- Excel export is handled in the browser with SheetJS.
- For real public use, add stronger controls such as CAPTCHA, logging, and a persistent rate limiter.