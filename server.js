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
} = process.env;

const ASANA_API = 'https://app.asana.com/api/1.0';
const isDryRun = String(DRY_RUN).toLowerCase() === 'true';

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

// Either comment on an existing task (taskGid provided) or create a new one
// in the default project (taskGid omitted).
app.post('/api/submit', requireAccessCode, async (req, res) => {
  const { taskGid, text } = req.body || {};
  const trimmed = (text || '').trim();

  if (!trimmed) {
    return res.status(400).json({ error: 'Nothing to send — the message was empty.' });
  }

  if (isDryRun) {
    console.log('[DRY RUN] Would send to Asana:', { taskGid: taskGid || null, text: trimmed });
    return res.json({ ok: true, dryRun: true, taskGid: taskGid || 'demo-new-task' });
  }

  if (!ASANA_TOKEN || !ASANA_PROJECT_GID) return serverMisconfigured(res);

  try {
    let url;
    let payload;

    if (taskGid) {
      // Add as a comment on the chosen existing ticket.
      url = `${ASANA_API}/tasks/${taskGid}/stories`;
      payload = { data: { text: trimmed } };
    } else {
      // Create a brand-new ticket. First ~100 chars become the task name so
      // it's scannable in list view; the full text always goes in the notes.
      const name = trimmed.length > 100 ? `${trimmed.slice(0, 97)}...` : trimmed;
      url = `${ASANA_API}/tasks`;
      payload = {
        data: {
          name,
          notes: trimmed,
          projects: [ASANA_PROJECT_GID],
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

    res.json({ ok: true, taskGid: body?.data?.gid || taskGid || null });
  } catch (err) {
    console.error('POST /api/submit failed:', err);
    res.status(502).json({ error: 'Could not reach Asana. Try again in a moment.' });
  }
});

const port = PORT || 3000;
app.listen(port, () => {
  console.log(`voice-to-asana listening on port ${port}${isDryRun ? ' [DRY RUN]' : ''}`);
});
