require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const {
  ASANA_TOKEN,
  ASANA_PROJECT_GID,
  ACCESS_CODE,
  DRY_RUN,
  PORT,
  ANTHROPIC_API_KEY,
  AI_DAILY_LIMIT,
} = process.env;

const ASANA_API = 'https://app.asana.com/api/1.0';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'; // cheapest current model — plenty for this
const isDryRun = String(DRY_RUN).toLowerCase() === 'true';
const aiDailyLimit = Number(AI_DAILY_LIMIT) > 0 ? Number(AI_DAILY_LIMIT) : 200;

// Simple in-memory daily counter so a misfire can't quietly run up cost.
// Resets whenever the calendar day changes; resets on redeploy too, which is fine.
let aiCallDay = new Date().toDateString();
let aiCallCount = 0;

function aiBudgetAvailable() {
  const today = new Date().toDateString();
  if (today !== aiCallDay) {
    aiCallDay = today;
    aiCallCount = 0;
  }
  return aiCallCount < aiDailyLimit;
}

// ---- helpers -------------------------------------------------------------

function asanaHeaders() {
  return {
    Authorization: `Bearer ${ASANA_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function requireAccessCode(req, res, next) {
  if (!ACCESS_CODE) return next(); // access code disabled
  const supplied = req.get('x-access-code') || '';
  if (supplied !== ACCESS_CODE) {
    return res.status(401).json({ error: 'Wrong or missing access code.' });
  }
  next();
}

function serverMisconfigured(res) {
  return res.status(500).json({
    error:
      'Server is missing ASANA_TOKEN or ASANA_PROJECT_GID. Set them as environment variables on your host and redeploy.',
  });
}

// ---- routes ---------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    dryRun: isDryRun,
    asanaConfigured: Boolean(ASANA_TOKEN && ASANA_PROJECT_GID),
    accessCodeEnabled: Boolean(ACCESS_CODE),
    aiSummarizationConfigured: Boolean(ANTHROPIC_API_KEY),
    aiDailyLimit,
    aiCallsToday: aiCallCount,
  });
});

// List open (incomplete) tasks in the default project, for the "update an
// existing ticket" dropdown.
app.get('/api/tasks', requireAccessCode, async (req, res) => {
  if (isDryRun) {
    return res.json({
      tasks: [
        { gid: 'demo-1', name: '(dry run) F/U with Keith Jelinek' },
        { gid: 'demo-2', name: '(dry run) Parker Hayden - Redesign Health' },
      ],
    });
  }

  if (!ASANA_TOKEN || !ASANA_PROJECT_GID) return serverMisconfigured(res);

  try {
    const url = `${ASANA_API}/projects/${ASANA_PROJECT_GID}/tasks?completed_since=now&opt_fields=name,gid&limit=100`;
    const r = await fetch(url, { headers: asanaHeaders() });
    const body = await r.json();

    if (!r.ok) {
      const message = body?.errors?.[0]?.message || 'Asana rejected the request.';
      return res.status(r.status).json({ error: message });
    }

    const tasks = (body.data || []).map((t) => ({ gid: t.gid, name: t.name }));
    res.json({ tasks });
  } catch (err) {
    console.error('GET /api/tasks failed:', err);
    res.status(502).json({ error: 'Could not reach Asana. Try again in a moment.' });
  }
});

// List members of the default project, for the optional "assign to" dropdown.
app.get('/api/members', requireAccessCode, async (req, res) => {
  if (isDryRun) {
    return res.json({
      members: [
        { gid: 'demo-user-1', name: '(dry run) Gerlie' },
        { gid: 'demo-user-2', name: '(dry run) Katie' },
      ],
    });
  }

  if (!ASANA_TOKEN || !ASANA_PROJECT_GID) return serverMisconfigured(res);

  try {
    const url = `${ASANA_API}/projects/${ASANA_PROJECT_GID}?opt_fields=members.name,members.gid`;
    const r = await fetch(url, { headers: asanaHeaders() });
    const body = await r.json();

    if (!r.ok) {
      const message = body?.errors?.[0]?.message || 'Asana rejected the request.';
      return res.status(r.status).json({ error: message });
    }

    const members = (body.data?.members || []).map((m) => ({ gid: m.gid, name: m.name }));
    res.json({ members });
  } catch (err) {
    console.error('GET /api/members failed:', err);
    res.status(502).json({ error: 'Could not reach Asana. Try again in a moment.' });
  }
});

// Falls back to the old behavior: first ~100 chars as the title, full text
// as the description. Used whenever AI summarization isn't available,
// hasn't been configured, is over its daily budget, or fails for any reason.
function plainSplit(text) {
  const name = text.length > 100 ? `${text.slice(0, 97)}...` : text;
  return { title: name, description: text };
}

// Asks Claude for a short title + cleaned-up description from a raw dictated
// update. Always falls back to plainSplit() rather than ever blocking a
// submission — a hiccup in the AI call should never stop a ticket from
// being created.
async function summarizeUpdate(text) {
  if (!ANTHROPIC_API_KEY || !aiBudgetAvailable()) {
    return plainSplit(text);
  }

  try {
    const r = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 200,
        system:
          'You turn a dictated voice-note update into a task title and description. ' +
          'Reply with ONLY compact JSON: {"title": "...", "description": "..."}. ' +
          'The title is a short, specific summary (under 10 words, no trailing period). ' +
          'The description is the full context, lightly cleaned up (fix filler words/' +
          'false starts) but keeping every real detail — do not summarize the description, ' +
          'only the title. If the note truly has nothing beyond what fits in the title, ' +
          'the description can repeat it.',
        messages: [{ role: 'user', content: text }],
      }),
    });

    if (!r.ok) return plainSplit(text); // e.g. bad key — rejected before any tokens are billed

    aiCallCount += 1; // only count calls that actually reached the model (i.e. cost something)

    const body = await r.json();
    const raw = body?.content?.[0]?.text || '';
    const parsed = JSON.parse(raw);
    if (!parsed.title || !parsed.description) return plainSplit(text);

    return { title: parsed.title.trim(), description: parsed.description.trim() };
  } catch (err) {
    console.error('Claude summarization failed, falling back to plain split:', err);
    return plainSplit(text);
  }
}

// Builds the {assignee, due_on} fields to merge into an Asana payload,
// omitting anything the caller didn't actually set.
function optionalTaskFields(assigneeGid, dueDate) {
  const fields = {};
  if (assigneeGid) fields.assignee = assigneeGid;
  if (dueDate) fields.due_on = dueDate; // expects YYYY-MM-DD
  return fields;
}

// Either comment on an existing task (taskGid provided) or create a new one
// in the default project (taskGid omitted). assigneeGid and dueDate are both
// optional in either case.
app.post('/api/submit', requireAccessCode, async (req, res) => {
  const { taskGid, text, assigneeGid, dueDate } = req.body || {};
  const trimmed = (text || '').trim();

  if (!trimmed) {
    return res.status(400).json({ error: 'Nothing to send — the message was empty.' });
  }

  if (isDryRun) {
    const preview = await summarizeUpdate(trimmed);
    console.log('[DRY RUN] Would send to Asana:', {
      taskGid: taskGid || null,
      text: trimmed,
      assigneeGid: assigneeGid || null,
      dueDate: dueDate || null,
      wouldUseTitle: taskGid ? null : preview.title,
      wouldUseDescription: taskGid ? null : preview.description,
    });
    return res.json({ ok: true, dryRun: true, taskGid: taskGid || 'demo-new-task' });
  }

  if (!ASANA_TOKEN || !ASANA_PROJECT_GID) return serverMisconfigured(res);

  try {
    let url;
    let payload;

    if (taskGid) {
      // Add as a comment on the chosen existing ticket. No title needed here,
      // so no summarization call — just the raw text as-is.
      url = `${ASANA_API}/tasks/${taskGid}/stories`;
      payload = { data: { text: trimmed } };
    } else {
      // Create a brand-new ticket. Let Claude split this into a short title
      // + a cleaned-up description when it's configured and within budget;
      // otherwise plainSplit() inside summarizeUpdate() covers it seamlessly.
      const { title, description } = await summarizeUpdate(trimmed);
      url = `${ASANA_API}/tasks`;
      payload = {
        data: {
          name: title,
          notes: description,
          projects: [ASANA_PROJECT_GID],
          ...optionalTaskFields(assigneeGid, dueDate),
        },
      };
    }

    const r = await fetch(url, {
      method: 'POST',
      headers: asanaHeaders(),
      body: JSON.stringify(payload),
    });
    const body = await r.json();

    if (!r.ok) {
      const message = body?.errors?.[0]?.message || 'Asana rejected the request.';
      return res.status(r.status).json({ error: message });
    }

    const resultGid = body?.data?.gid || taskGid || null;
    let warning = null;

    // Commenting doesn't let you set assignee/due date in the same call, so
    // an existing ticket needs a second request to apply those, if given.
    if (taskGid && (assigneeGid || dueDate)) {
      const updateFields = optionalTaskFields(assigneeGid, dueDate);
      const updateR = await fetch(`${ASANA_API}/tasks/${taskGid}`, {
        method: 'PUT',
        headers: asanaHeaders(),
        body: JSON.stringify({ data: updateFields }),
      });
      if (!updateR.ok) {
        const updateBody = await updateR.json().catch(() => ({}));
        warning =
          'Comment was added, but could not update assignee/due date: ' +
          (updateBody?.errors?.[0]?.message || 'Asana rejected the request.');
      }
    }

    res.json({ ok: true, taskGid: resultGid, warning });
  } catch (err) {
    console.error('POST /api/submit failed:', err);
    res.status(502).json({ error: 'Could not reach Asana. Try again in a moment.' });
  }
});

const port = PORT || 3000;
app.listen(port, () => {
  console.log(`voice-to-asana listening on port ${port}${isDryRun ? ' [DRY RUN]' : ''}`);
});
