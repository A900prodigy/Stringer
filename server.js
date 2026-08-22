require('dotenv').config();

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');

const config = {
  port: Number(process.env.PORT) || 3000,
  newsdataApiKey: process.env.NEWSDATA_API_KEY || '',
  brightDataApiKey: process.env.BRIGHTDATA_API_KEY || '',
  collectorId: process.env.BRIGHTDATA_COLLECTOR_ID || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || '',
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb',
  elevenLabsModel: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
  elevenLabsFormat: process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128'
};

const ELEVENLABS_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

const CLI_ENTRY = require.resolve('@brightdata/cli/dist/index.js');
const CLI_TIMEOUT_MS = 900000;
const COLLECTOR_LIST_URL = 'https://api.brightdata.com/dca/collectors_list?limit=500';
const COLLECTOR_PREFIX = 'stringer-';

const state = {
  lastExtraction: null,
  lastSummary: null,
  pendingHeal: null,
  collectors: new Map(),
  collectorsLoaded: false,
  learnedHosts: new Set(),
  metrics: {
    extractions: 0,
    driftIncidents: 0,
    healsCompleted: 0,
    patchesApplied: 0,
    summaries: 0,
    lastHealMs: null
  }
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sseClients = new Set();

function broadcast(event, payload) {
  const frame = `data: ${JSON.stringify({ event, payload, at: Date.now() })}\n\n`;
  for (const client of sseClients) {
    client.write(frame);
  }
}

function log(level, message) {
  broadcast('log', { level, message });
  process.stdout.write(`[${new Date().toISOString()}] ${level.toUpperCase()} ${message}\n`);
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    if (!config.brightDataApiKey) {
      reject(new HttpError(500, 'BRIGHTDATA_API_KEY is not configured in .env'));
      return;
    }
    log('cli', `bdata ${args.join(' ')}`);

    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, BRIGHTDATA_API_KEY: config.brightDataApiKey },
      windowsHide: true
    });

    let stdout = '';
    let stderrText = '';
    let lastStep = '';
    const timer = setTimeout(() => child.kill(), CLI_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderrText += chunk.toString();
      for (const raw of chunk.toString().split(/\r?\n|\r/)) {
        const line = raw.replace(/[\u2800-\u28ff\u280b\u2839\u2838\u2834\u2826\u2827\u280f\u2807\u283f]/g, '').trim();
        if (!line) continue;
        const step = /Step:\s*([\w_]*)\s*—\s*polling \(attempt (\d+)/.exec(line);
        if (step) {
          if (step[1] && step[1] !== lastStep) {
            lastStep = step[1];
            log('heal', `Scraper Studio step: ${step[1]}`);
          }
          continue;
        }
        if (/Assertion failed|UV_HANDLE_CLOSING/.test(line)) continue;
        log('cli', line);
      }
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new HttpError(500, `Could not start the Bright Data CLI: ${error.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(cliFailure(stderrText, code));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function cliFailure(stderrText, code) {
  if (/Another refactor job is still in progress/i.test(stderrText)) {
    const busy = new HttpError(
      409,
      'Bright Data is still finishing a previous heal on this collector. Scraper Studio allows one refactor job at a time, wait for it to finish and retry.'
    );
    busy.code = 'REFACTOR_IN_PROGRESS';
    return busy;
  }
  if (/\bStatus:\s*429\b/.test(stderrText) || /concurrent-job cap/i.test(stderrText)) {
    return new HttpError(429, 'Bright Data AI-Flow is at its concurrent job cap, retry shortly');
  }
  if (/Self-healing failed \(collector/i.test(stderrText)) {
    const failed = new HttpError(
      502,
      'Bright Data ended this refactor job with status failed. Nothing was committed and the collector is unchanged, run the heal again.'
    );
    failed.code = 'HEAL_NOT_APPROVABLE';
    return failed;
  }
  if (/Failed to approve self-healing|sprintf invalid format/i.test(stderrText)) {
    const stale = new HttpError(
      502,
      'This refactor job can no longer be approved because it already finished or failed. Nothing was committed, run the heal again.'
    );
    stale.code = 'HEAL_NOT_APPROVABLE';
    return stale;
  }
  if (/awaiting approval|awaiting_approval/i.test(stderrText)) {
    return new HttpError(409, 'This collector already has a heal awaiting approval, approve or reject it first');
  }
  const timedOut = /Timeout after (\d+) seconds waiting for ([^(\n]+)/i.exec(stderrText);
  if (timedOut) {
    return new HttpError(
      504,
      `Bright Data was still working on the ${timedOut[2].trim()} after ${timedOut[1]}s and stopped polling. ` +
      'The collector is unchanged, retry it or give the heal a longer --timeout.'
    );
  }
  const detail = stderrText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/Assertion failed|UV_HANDLE_CLOSING|^Status:|^Note:|^Open https?:\/\//.test(line))
    .pop();
  return new HttpError(502, detail ? `Bright Data CLI failed: ${detail}` : `Bright Data CLI exited with code ${code}`);
}

function parseCliJson(output) {
  const start = output.search(/[[{]/);
  if (start === -1) throw new HttpError(502, 'Bright Data CLI returned no JSON payload');
  try {
    return JSON.parse(output.slice(start));
  } catch (error) {
    throw new HttpError(502, 'Bright Data CLI returned malformed JSON');
  }
}

function requireCollector() {
  if (!config.collectorId) {
    throw new HttpError(
      500,
      'BRIGHTDATA_COLLECTOR_ID is not set. Create one with: bdata scraper create <url> "<description>"'
    );
  }
  return config.collectorId;
}

// Bright Data has no domain field, so each collector is named after its publisher and matched back by name.
function findCollector(host) {
  const target = `${COLLECTOR_PREFIX}${host}`;
  for (const [name, id] of state.collectors) {
    if (name.includes(target)) return id;
  }
  return null;
}

function collectorFor(url) {
  if (!url) return requireCollector();
  return findCollector(new URL(url).hostname) || requireCollector();
}

async function loadCollectors() {
  const response = await fetch(COLLECTOR_LIST_URL, {
    headers: { Authorization: `Bearer ${config.brightDataApiKey}` },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`collectors_list responded ${response.status}`);
  const payload = await response.json();
  const found = new Map();
  for (const item of payload.data || []) {
    if (item.id && String(item.name || '').startsWith(COLLECTOR_PREFIX)) found.set(item.name, item.id);
  }
  return found;
}

async function scraperRun(url) {
  const output = await runCli(['scraper', 'run', collectorFor(url), url, '--sync', '--json']);
  const parsed = parseCliJson(output);
  const record = Array.isArray(parsed) ? parsed[0] || {} : parsed;
  const body = record.article_body || '';
  return {
    headline: record.headline || null,
    author: record.author || null,
    published: record.publish_date || record.published || null,
    content: body || null,
    stats: {
      characters: body.length,
      words: body ? body.split(/\s+/).filter(Boolean).length : 0
    }
  };
}

async function scraperHeal(url, prompt) {
  const output = await runCli([
    'scraper',
    'heal',
    collectorFor(url),
    prompt,
    '--url',
    url,
    '--json'
  ]);
  return parseCliJson(output);
}

async function scraperApprove(url) {
  const args = ['scraper', 'approve', collectorFor(url), '--auto-save', '--json'];
  if (url) args.push('--url', url);
  return parseCliJson(await runCli(args));
}

async function scraperCreate(url, description) {
  const output = await runCli([
    'scraper',
    'create',
    url,
    description,
    '--name',
    `${COLLECTOR_PREFIX}${new URL(url).hostname}`,
    '--json'
  ]);
  return parseCliJson(output);
}

function isBroken(article) {
  return !article.content || article.stats.characters < 250 || !article.headline;
}

const REQUIRED_FIELDS = ['headline', 'article_body'];
const OPTIONAL_FIELDS = ['author'];

// The CLI does not forward --url to the heal call, so the failing page has to be named in the prompt itself.
function buildHealPrompt(url, article) {
  const nulls = REQUIRED_FIELDS.filter((field) => {
    if (!article) return true;
    return field === 'article_body' ? !article.content : !article[field];
  });
  const failing = nulls.length ? nulls : REQUIRED_FIELDS;
  return [
    `On ${url} this scraper returns ${failing.join(' and ')} as null.`,
    `Update the extraction so those fields are captured on ${new URL(url).hostname} article pages, and leave fields that already work on other pages unchanged.`,
    `The heal is done when ${REQUIRED_FIELDS.join(' and ')} are non-empty for the URL above; ${OPTIONAL_FIELDS.join(', ')} may stay null.`
  ].join('\n').slice(0, 1000);
}

// Field names must match what scraperRun() reads off each record.
function buildCollectorSpec(url) {
  return [
    `Extract one record per news article page on ${new URL(url).hostname}.`,
    'Fields: headline (article title), author (byline name, null when the page has no byline),',
    'publish_date (publication date), article_body (full article text without navigation, ads or comments).'
  ].join(' ');
}

const SUMMARY_PROMPT = [
  'You are a wire service editor. Read the article below and return JSON with two fields.',
  '"headline": one original headline of at most 12 words that states the central fact.',
  '"summary": exactly four sentences covering what happened, who is involved, and why it matters.',
  'Use only facts present in the article. Add no opinion, no speculation, no outside knowledge.',
  'If the text is not a news article, set headline to "NOT_AN_ARTICLE" and summary to an empty string.'
].join(' ');

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    summary: { type: 'string' }
  },
  required: ['headline', 'summary']
};

async function summarizeWithGemini(title, content) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
    body: JSON.stringify({
      contents: [
        { parts: [{ text: `${SUMMARY_PROMPT}\n\nSource headline: ${title}\n\nArticle:\n${content.slice(0, 12000)}` }] }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingLevel: 'minimal' },
        responseMimeType: 'application/json',
        responseSchema: SUMMARY_SCHEMA
      }
    }),
    signal: AbortSignal.timeout(45000)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && payload.error ? payload.error.message : `HTTP ${response.status}`;
    throw new HttpError(response.status === 429 ? 429 : 502, `Gemini rejected the request: ${detail}`);
  }

  const candidate = payload && payload.candidates && payload.candidates[0];
  if (candidate && candidate.finishReason === 'MAX_TOKENS') {
    throw new HttpError(502, 'Gemini hit the output token budget before finishing');
  }
  const text = candidate && candidate.content && candidate.content.parts
    ? candidate.content.parts
        .filter((part) => !part.thought)
        .map((part) => part.text || '')
        .join('')
        .replace(/^```(?:json)?\s*|\s*```$/g, '')
        .trim()
    : '';
  if (!text) throw new HttpError(502, 'Gemini returned no usable candidate');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new HttpError(502, 'Gemini returned malformed JSON');
  }
  if (parsed.headline === 'NOT_AN_ARTICLE') {
    throw new HttpError(422, 'Gemini judged this page not to be a news article');
  }
  return parsed;
}

const CHANNEL_PROMPT = [
  'You are a TV news anchor recording short segments for a live broadcast.',
  'Below is a numbered list of news stories, each with a title and a short description.',
  'For every story, write a punchy on-air segment: a "headline" of at most 10 words, read as a chyron,',
  'and a "summary" of exactly two sentences in a confident TV-anchor voice, using only facts given below.',
  'Do not invent facts, numbers, or quotes that are not in the title or description.',
  'Return a JSON array with one object per story, in the same order, each with "headline" and "summary".'
].join(' ');

const CHANNEL_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          headline: { type: 'string' },
          summary: { type: 'string' }
        },
        required: ['headline', 'summary']
      }
    }
  },
  required: ['segments']
};

async function channelBriefWithGemini(stories) {
  const listing = stories
    .map((story, index) => `${index + 1}. Title: ${story.title || 'Untitled'}\nDescription: ${story.description || 'No description available.'}`)
    .join('\n\n');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${CHANNEL_PROMPT}\n\n${listing}` }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 3072,
        thinkingConfig: { thinkingLevel: 'minimal' },
        responseMimeType: 'application/json',
        responseSchema: CHANNEL_SCHEMA
      }
    }),
    signal: AbortSignal.timeout(45000)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && payload.error ? payload.error.message : `HTTP ${response.status}`;
    throw new HttpError(response.status === 429 ? 429 : 502, `Gemini rejected the request: ${detail}`);
  }

  const candidate = payload && payload.candidates && payload.candidates[0];
  if (candidate && candidate.finishReason === 'MAX_TOKENS') {
    throw new HttpError(502, 'Gemini hit the output token budget before finishing');
  }
  const text = candidate && candidate.content && candidate.content.parts
    ? candidate.content.parts
        .filter((part) => !part.thought)
        .map((part) => part.text || '')
        .join('')
        .replace(/^```(?:json)?\s*|\s*```$/g, '')
        .trim()
    : '';
  if (!text) throw new HttpError(502, 'Gemini returned no usable candidate');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new HttpError(502, 'Gemini returned malformed JSON');
  }
  if (!Array.isArray(parsed.segments)) {
    throw new HttpError(502, 'Gemini did not return a segments array');
  }
  return parsed.segments;
}

const LANGUAGES = [
  'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Dutch',
  'Hindi', 'Tamil', 'Bengali', 'Arabic', 'Japanese', 'Korean',
  'Chinese', 'Russian', 'Turkish', 'Indonesian', 'Vietnamese', 'Ukrainian'
];

const TRANSLATE_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    summary: { type: 'string' }
  },
  required: ['headline', 'summary']
};

async function translateWithGemini(headline, summary, language) {
  const prompt = [
    `Translate the news headline and summary below into ${language}.`,
    'Preserve meaning, names and numbers exactly. Do not add or remove information.',
    'Return only the translation, written naturally for a native reader.',
    '',
    `Headline: ${headline}`,
    '',
    `Summary: ${summary}`
  ].join('\n');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingLevel: 'minimal' },
        responseMimeType: 'application/json',
        responseSchema: TRANSLATE_SCHEMA
      }
    }),
    signal: AbortSignal.timeout(45000)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && payload.error ? payload.error.message : `HTTP ${response.status}`;
    throw new HttpError(response.status === 429 ? 429 : 502, `Gemini rejected the translation: ${detail}`);
  }
  const candidate = payload && payload.candidates && payload.candidates[0];
  const text = candidate && candidate.content && candidate.content.parts
    ? candidate.content.parts
        .filter((part) => !part.thought)
        .map((part) => part.text || '')
        .join('')
        .replace(/^```(?:json)?\s*|\s*```$/g, '')
        .trim()
    : '';
  if (!text) throw new HttpError(502, 'Gemini returned no translation');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HttpError(502, 'Gemini returned malformed translation JSON');
  }
}

async function elevenLabsErrorDetail(response) {
  const payload = await response.json().catch(() => null);
  const detail = payload && payload.detail;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail.message === 'string') return detail.message;
  return `HTTP ${response.status}`;
}

async function speakWithElevenLabs(text) {
  if (!config.elevenLabsApiKey) {
    throw new HttpError(500, 'ELEVENLABS_API_KEY is not configured in .env');
  }
  const endpoint = `${ELEVENLABS_TTS_URL}/${encodeURIComponent(config.elevenLabsVoiceId)}` +
    `?output_format=${encodeURIComponent(config.elevenLabsFormat)}`;
  const body = JSON.stringify({
    text,
    model_id: config.elevenLabsModel,
    voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true }
  });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': config.elevenLabsApiKey,
          Accept: 'audio/mpeg'
        },
        body,
        signal: AbortSignal.timeout(120000)
      });
    } catch (error) {
      const cause = error.cause && error.cause.message ? `: ${error.cause.message}` : '';
      throw new HttpError(502, `Could not reach the ElevenLabs API${cause}`);
    }

    if (response.status >= 500 && attempt === 1) {
      log('warn', `ElevenLabs returned ${response.status}, retrying once`);
      continue;
    }
    if (!response.ok) {
      const detail = await elevenLabsErrorDetail(response);
      throw new HttpError(response.status === 429 ? 429 : 502, `ElevenLabs rejected the request: ${detail}`);
    }

    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length) {
      if (attempt === 1) {
        log('warn', 'ElevenLabs returned an empty stream, retrying once');
        continue;
      }
      throw new HttpError(502, 'ElevenLabs returned no audio');
    }
    return { audio, contentType: response.headers.get('content-type') || 'audio/mpeg' };
  }
  throw new HttpError(502, 'ElevenLabs TTS failed after a retry');
}

async function fetchNews(query) {
  if (!config.newsdataApiKey) {
    throw new HttpError(500, 'NEWSDATA_API_KEY is not configured');
  }
  const endpoint = new URL('https://newsdata.io/api/1/latest');
  endpoint.searchParams.set('apikey', config.newsdataApiKey);
  endpoint.searchParams.set('language', 'en');
  if (query.q) endpoint.searchParams.set('q', query.q);
  if (query.category) endpoint.searchParams.set('category', query.category);
  if (query.country) endpoint.searchParams.set('country', query.country);

  const response = await fetch(endpoint, { signal: AbortSignal.timeout(20000) });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.status !== 'success') {
    const message = payload && payload.results && payload.results.message
      ? payload.results.message
      : `Newsdata.io responded ${response.status}`;
    throw new HttpError(response.status === 200 ? 502 : response.status, message);
  }
  return (payload.results || [])
    .filter((item) => item.link)
    .map((item) => ({
      id: item.article_id,
      title: item.title,
      description: item.description,
      link: item.link,
      source: item.source_name || item.source_id,
      publishedAt: item.pubDate,
      category: Array.isArray(item.category) ? item.category[0] : item.category
    }));
}

function assertHttpUrl(candidate) {
  let parsed;
  try {
    parsed = new URL(String(candidate));
  } catch (error) {
    throw new HttpError(400, 'A valid absolute article URL is required');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, 'Only http and https targets are allowed');
  }
  return parsed.toString();
}

async function extractArticle(url) {
  const host = new URL(url).hostname;
  const started = Date.now();
  log('info', `running collector ${collectorFor(url)} against ${host}`);
  const article = await scraperRun(url);
  state.metrics.extractions += 1;

  const broken = isBroken(article);
  const result = {
    url,
    collectorId: collectorFor(url),
    status: broken ? 'COLLECTOR_DRIFT' : 'HEALTHY',
    article,
    healable: broken,
    durationMs: Date.now() - started
  };
  state.lastExtraction = result;

  if (broken) {
    state.metrics.driftIncidents += 1;
    log('error', `collector returned no usable data for ${host}, fields came back null`);
  } else {
    state.learnedHosts.add(host);
    log('success', `extraction healthy -> ${article.stats.words} words in ${result.durationMs}ms`);
  }
  return result;
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (request, response) => {
  response.json({
    collectorId: config.collectorId,
    collectors: Object.fromEntries(state.collectors),
    pendingHeal: state.pendingHeal,
    metrics: state.metrics,
    integrations: {
      newsdata: Boolean(config.newsdataApiKey),
      brightDataCli: Boolean(config.brightDataApiKey),
      collector: Boolean(config.collectorId),
      gemini: Boolean(config.geminiApiKey),
      elevenlabs: Boolean(config.elevenLabsApiKey)
    }
  });
});

app.get('/api/stream', (request, response) => {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  response.write(': connected\n\n');
  sseClients.add(response);
  const heartbeat = setInterval(() => response.write(': ping\n\n'), 25000);
  request.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(response);
    response.end();
  });
});

app.get('/api/news', async (request, response, next) => {
  try {
    const articles = await fetchNews({
      q: typeof request.query.q === 'string' ? request.query.q.slice(0, 120) : '',
      category: typeof request.query.category === 'string' ? request.query.category.slice(0, 40) : '',
      country: typeof request.query.country === 'string' ? request.query.country.slice(0, 10) : ''
    });
    log('info', `Newsdata.io discovery returned ${articles.length} live stories`);
    response.json({ count: articles.length, articles });
  } catch (error) {
    next(error);
  }
});

app.post('/api/extract', async (request, response, next) => {
  try {
    const url = assertHttpUrl(request.body && request.body.url);
    response.json(await extractArticle(url));
  } catch (error) {
    next(error);
  }
});

app.post('/api/simulate', async (request, response, next) => {
  try {
    log('warn', 'looking for a publisher this collector has never seen');
    const articles = await fetchNews({});
    const candidates = articles
      .filter((item) => {
        try {
          const host = new URL(item.link).hostname;
          return !state.learnedHosts.has(host) && !/(^|\.)news\.google\./.test(host);
        } catch (error) {
          return false;
        }
      })
      .slice(0, 4);

    if (!candidates.length) {
      throw new HttpError(422, 'Every publisher in the current feed is already known to this collector');
    }

    for (const candidate of candidates) {
      const host = new URL(candidate.link).hostname;
      log('warn', `pointing collector ${collectorFor(candidate.link)} at ${host}, a publisher it was never trained on`);
      const result = await extractArticle(candidate.link);
      if (result.status === 'COLLECTOR_DRIFT') {
        response.json({ ...result, story: candidate });
        return;
      }
      log('info', `${host} already works, trying the next publisher`);
    }
    throw new HttpError(422, 'Could not find a failing publisher in this batch, reload the feed and retry');
  } catch (error) {
    next(error);
  }
});

// A publisher with no collector of its own gets one built for it; healing is reserved for collectors that already own the domain.
async function provisionCollector(url, started, reason) {
  const host = new URL(url).hostname;
  if (!state.collectorsLoaded) {
    throw new HttpError(503, 'The collector registry never loaded from Bright Data, refusing to build a possible duplicate');
  }
  log('warn', `${reason}, building a collector dedicated to ${host}`);
  const spec = buildCollectorSpec(url);
  const created = await scraperCreate(url, spec);
  if (!created.collector_id) {
    throw new HttpError(502, `Bright Data could not build a collector for ${host} (status ${created.status || 'unknown'})`);
  }

  state.collectors.set(`${COLLECTOR_PREFIX}${host}`, created.collector_id);
  state.pendingHeal = null;
  log('success', `${host} now has its own collector ${created.collector_id}`);

  const extraction = await extractArticle(url);
  const durationMs = Date.now() - started;
  state.metrics.healsCompleted += 1;
  state.metrics.lastHealMs = durationMs;

  const patch = {
    collectorId: created.collector_id,
    status: 'COLLECTOR_CREATED',
    prompt: spec,
    steps: created.completed_steps || [],
    nextStep: '',
    diffSummary: `built collector ${created.collector_id} for ${host}, other publishers keep their own`,
    viewUrl: created.view_url || '',
    preview: {
      headline: extraction.article.headline,
      author: extraction.article.author,
      characters: extraction.article.stats.characters
    },
    url,
    durationMs,
    extraction
  };

  log('success', `collector for ${host} ready in ${Math.round(durationMs / 1000)}s across ${patch.steps.length} steps`);
  broadcast('patch-ready', patch);
  return patch;
}

app.post('/api/heal', async (request, response, next) => {
  try {
    const url = assertHttpUrl(
      (request.body && request.body.url) || (state.lastExtraction && state.lastExtraction.url)
    );
    const custom = request.body && typeof request.body.prompt === 'string' ? request.body.prompt.trim() : '';
    const observed = state.lastExtraction && state.lastExtraction.url === url ? state.lastExtraction.article : null;
    const prompt = custom ? custom.slice(0, 1000) : buildHealPrompt(url, observed);

    const started = Date.now();
    const host = new URL(url).hostname;
    if (!findCollector(host)) {
      response.json(await provisionCollector(url, started, `${host} has no collector of its own`));
      return;
    }

    log('heal', `asking Bright Data Scraper Studio to repair collector ${collectorFor(url)}`);
    const envelope = await scraperHeal(url, prompt);
    const durationMs = Date.now() - started;

    state.metrics.healsCompleted += 1;
    state.metrics.lastHealMs = durationMs;
    const preview = Array.isArray(envelope.preview_result) ? envelope.preview_result[0] || {} : {};
    const patch = {
      collectorId: envelope.collector_id,
      status: envelope.status,
      prompt: envelope.prompt,
      steps: envelope.completed_steps || [],
      nextStep: envelope.next_step || '',
      diffSummary: envelope.diff_summary || '',
      viewUrl: envelope.view_url || '',
      preview: {
        headline: preview.headline || null,
        author: preview.author || null,
        characters: (preview.article_body || '').length
      },
      url,
      durationMs
    };
    state.pendingHeal = patch;

    log('success', `heal ${envelope.status} in ${Math.round(durationMs / 1000)}s across ${patch.steps.length} steps`);
    broadcast('patch-ready', patch);
    response.json(patch);
  } catch (error) {
    next(error);
  }
});

app.post('/api/approve', async (request, response, next) => {
  try {
    if (!state.pendingHeal) {
      throw new HttpError(409, 'There is no heal awaiting approval');
    }
    const started = Date.now();
    const envelope = await scraperApprove(state.pendingHeal.url);
    state.metrics.patchesApplied += 1;
    state.pendingHeal = null;
    log('success', `Bright Data saved the healed template in ${Date.now() - started}ms, status ${envelope.status}`);
    broadcast('patch-applied', { status: envelope.status, collectorId: envelope.collector_id });
    response.json({ status: envelope.status, collectorId: envelope.collector_id });
  } catch (error) {
    if (error.code === 'HEAL_NOT_APPROVABLE') {
      state.pendingHeal = null;
      log('warn', 'dropped the staged heal, Bright Data will not commit it');
    }
    next(error);
  }
});

app.post('/api/summarize', async (request, response, next) => {
  try {
    const last = state.lastExtraction;
    if (!last || !last.article.content) {
      throw new HttpError(409, 'Run a healthy extraction first, there is nothing to summarize');
    }
    if (!config.geminiApiKey) {
      throw new HttpError(500, 'GEMINI_API_KEY is not configured in .env');
    }
    const started = Date.now();
    log('info', `sending ${last.article.stats.words} words to ${config.geminiModel}`);
    const result = await summarizeWithGemini(last.article.headline, last.article.content);
    const durationMs = Date.now() - started;
    const words = result.summary.split(/\s+/).filter(Boolean).length;
    const compression = Math.round((1 - words / last.article.stats.words) * 100);
    state.metrics.summaries += 1;
    state.lastSummary = { headline: result.headline, summary: result.summary, language: 'English' };
    state.originalSummary = state.lastSummary;
    log('success', `Gemini returned a headline and ${words} word summary in ${durationMs}ms, ${compression}% shorter`);
    response.json({
      headline: result.headline,
      summary: result.summary,
      engine: config.geminiModel,
      words,
      compression,
      durationMs,
      source: { title: last.article.headline, url: last.url }
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/channel', async (request, response, next) => {
  try {
    if (!config.geminiApiKey) {
      throw new HttpError(500, 'GEMINI_API_KEY is not configured in .env');
    }
    const stories = Array.isArray(request.body && request.body.stories) ? request.body.stories.slice(0, 10) : [];
    if (!stories.length) {
      throw new HttpError(409, 'No stories were sent. Load stories first, then open the channel.');
    }
    const cleaned = stories
      .map((story) => ({
        title: typeof story.title === 'string' ? story.title.slice(0, 300) : '',
        description: typeof story.description === 'string' ? story.description.slice(0, 600) : '',
        source: typeof story.source === 'string' ? story.source.slice(0, 80) : '',
        link: typeof story.link === 'string' ? story.link.slice(0, 500) : ''
      }))
      .filter((story) => story.title);
    if (!cleaned.length) {
      throw new HttpError(422, 'None of the sent stories had a usable title');
    }

    const started = Date.now();
    log('info', `briefing ${cleaned.length} stories for the news channel with ${config.geminiModel}`);
    const segments = await channelBriefWithGemini(cleaned);
    const durationMs = Date.now() - started;
    log('success', `channel ready with ${segments.length} segments in ${durationMs}ms`);

    const combined = cleaned.map((story, index) => ({
      headline: (segments[index] && segments[index].headline) || story.title,
      summary: (segments[index] && segments[index].summary) || story.description,
      source: story.source,
      link: story.link
    }));

    response.json({ segments: combined, engine: config.geminiModel, durationMs });
  } catch (error) {
    next(error);
  }
});

app.post('/api/translate', async (request, response, next) => {
  try {
    if (!state.lastSummary) {
      throw new HttpError(409, 'Generate a summary first, there is nothing to translate');
    }
    if (!config.geminiApiKey) {
      throw new HttpError(500, 'GEMINI_API_KEY is not configured in .env');
    }
    const language = LANGUAGES.find(
      (item) => item.toLowerCase() === String(request.body && request.body.language).toLowerCase()
    );
    if (!language) {
      throw new HttpError(400, `Unsupported language. Choose one of: ${LANGUAGES.join(', ')}`);
    }

    const source = state.originalSummary || state.lastSummary;
    state.originalSummary = source;
    const started = Date.now();
    log('info', `translating the summary into ${language} with ${config.geminiModel}`);
    const result = await translateWithGemini(source.headline, source.summary, language);
    const durationMs = Date.now() - started;
    state.lastSummary = { headline: result.headline, summary: result.summary, language };
    log('success', `translated into ${language} in ${durationMs}ms`);
    response.json({ headline: result.headline, summary: result.summary, language, durationMs });
  } catch (error) {
    next(error);
  }
});

app.get('/api/languages', (request, response) => {
  response.json({ languages: LANGUAGES });
});

app.post('/api/speak', async (request, response, next) => {
  try {
    const summary = state.lastSummary;
    if (!summary) {
      throw new HttpError(409, 'Generate a summary first, there is nothing to read aloud');
    }
    const started = Date.now();
    log('info', `voicing the summary with ElevenLabs voice ${config.elevenLabsVoiceId} on ${config.elevenLabsModel}`);
    const spoken = await speakWithElevenLabs(`${summary.headline}. ${summary.summary}`);
    log('success', `${(spoken.audio.length / 1024).toFixed(1)}KB of audio rendered in ${Date.now() - started}ms`);
    response.setHeader('Content-Type', spoken.contentType);
    response.setHeader('Cache-Control', 'no-store');
    response.send(spoken.audio);
  } catch (error) {
    next(error);
  }
});

app.post('/api/channel-speak', async (request, response, next) => {
  try {
    const text = typeof (request.body && request.body.text) === 'string' ? request.body.text.trim() : '';
    if (!text) {
      throw new HttpError(400, 'No text was sent to voice');
    }
    const started = Date.now();
    const spoken = await speakWithElevenLabs(text.slice(0, 2000));
    log('info', `voiced a channel segment with ElevenLabs in ${Date.now() - started}ms`);
    response.setHeader('Content-Type', spoken.contentType);
    response.setHeader('Cache-Control', 'no-store');
    response.send(spoken.audio);
  } catch (error) {
    next(error);
  }
});

app.use((error, request, response, next) => {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof HttpError ? error.message : 'Unexpected pipeline failure';
  log(status >= 500 ? 'error' : 'warn', message);
  response.status(status).json({ error: message });
});

loadCollectors()
  .then((collectors) => {
    state.collectors = collectors;
    state.collectorsLoaded = true;
  })
  .catch((error) => {
    process.stdout.write(`Warning: could not load collectors from Bright Data (${error.message}), new publishers cannot be provisioned\n`);
  })
  .finally(() => {
    app.listen(config.port, () => {
      process.stdout.write(`Autonomous news pipeline listening on http://localhost:${config.port}\n`);
      process.stdout.write(`${state.collectors.size} publisher collectors recovered from Bright Data\n`);
      if (!config.collectorId) {
        process.stdout.write('Warning: BRIGHTDATA_COLLECTOR_ID missing, extraction and healing will fail\n');
      }
    });
  });