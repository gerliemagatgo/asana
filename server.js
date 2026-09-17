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
// Default of 80/day is sized to keep worst-case Claude Haiku spend under
// ~$5/month even if every call maxes out its ~750 input + 250 output tokens
// (80 calls/day * 30 days * ~$0.002/call ≈ $4.80). Override with a lower
// AI_DAILY_LIMIT env var for an even tighter cap.
const aiDailyLimit = Number(AI_DAILY_LIMIT) > 0 ? Number(AI_DAILY_LIMIT) : 80;

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

// Shared by the /api/members route and the AI extraction step below, so
// there's one place that knows how to fetch the project's real member list.
async function getProjectMembers() {
  if (isDryRun) {
    return [
      { gid: 'demo-user-1', name: '(dry run) Gerlie' },
      { gid: 'demo-user-2', name: '(dry run) Katie' },
    ];
  }
  if (!ASANA_TOKEN || !ASANA_PROJECT_GID) return [];

  const url = `${ASANA_API}/projects/${ASANA_PROJECT_GID}?opt_fields=members.name,members.gid`;
  const r = await fetch(url, { headers: asanaHeaders() });
  if (!r.ok) return [];
  const body = await r.json();
  return (body.data?.members || []).map((m) => ({ gid: m.gid, name: m.name }));
}

// List members of the default project, for the optional "assign to" dropdown.
app.get('/api/members', requireAccessCode, async (req, res) => {
  try {
    const members = await getProjectMembers();
    res.json({ members });
  } catch (err) {
    console.error('GET /api/members failed:', err);
    res.status(502).json({ error: 'Could not reach Asana. Try again in a moment.' });
  }
});

// Falls back to the old behavior: first ~100 chars as the title, full text
// as the description, no assignee/due date guessed. Used whenever AI
// summarization isn't available, hasn't been configured, is over its daily
// budget, or fails for any reason.
function plainSplit(text) {
  const name = text.length > 100 ? `${text.slice(0, 97)}...` : text;
  return { title: name, description: text, assigneeGid: null, dueDate: null };
}

// Formats the member list into "Name (gid: 123)" lines so Claude can match a
// spoken name to the exact gid, rather than us fuzzy-matching names ourselves.
function membersForPrompt(members) {
  if (!members.length) return '(no member list available — never guess an assignee)';
  return members.map((m) => `${m.name} (gid: ${m.gid})`).join('\n');
}

function todayContext() {
  const now = new Date();
  return `${now.toDateString()} (i.e. ${now.toISOString().slice(0, 10)})`;
}

// Claude sometimes wraps JSON replies in a ```json ... ``` code fence even
// when told not to. Strip that, then fall back to grabbing the outermost
// {...} block, so a stray fence or a stray word never breaks JSON.parse.
function parseJsonLoose(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch (err) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (err2) {
        // fall through to the throw below
      }
    }
    throw err;
  }
}

// Calls Claude once and returns parsed JSON, or null on any failure. Shared
// by summarizeUpdate() and extractAssigneeAndDueDate() below — both always
// fall back to non-AI behavior on null rather than ever blocking a submission.
async function callClaudeJson(system, userText) {
  if (!ANTHROPIC_API_KEY || !aiBudgetAvailable()) return null;

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
        max_tokens: 250,
        system,
        messages: [{ role: 'user', content: userText }],
      }),
    });

    if (!r.ok) return null; // e.g. bad key — rejected before any tokens are billed

    aiCallCount += 1; // only count calls that actually reached the model (i.e. cost something)

    const body = await r.json();
    const raw = body?.content?.[0]?.text || '';
    return parseJsonLoose(raw);
  } catch (err) {
    console.error('Claude call failed, falling back to non-AI behavior:', err);
    return null;
  }
}

// Asks Claude for a short title + cleaned-up description from a raw dictated
// update, and — since the same note often says who it's for or when it's
// due — also pulls out an assignee and due date if they were mentioned.
async function summarizeUpdate(text, members) {
  const parsed = await callClaudeJson(
    'You turn a dictated voice-note update into a task title and description, and ' +
      'pick up on any assignment/due-date instructions in the same note. ' +
      'The text was produced by speech-to-text from a voicemail, so expect imperfect ' +
      'transcription: misheard or phonetically-spelled names, dropped/wrong words, run-on ' +
      'sentences, and odd punctuation. Do your best to understand the intended meaning ' +
      'anyway rather than taking the literal wording too strictly. ' +
      'Reply with ONLY raw compact JSON and nothing else — no markdown, no code fences, ' +
      'no commentary before or after it: ' +
      '{"title": "...", "description": "...", "assigneeGid": "..." or null, "dueDate": "YYYY-MM-DD" or null}. ' +
      'The title is a short, specific summary (under 10 words, no trailing period). ' +
      'The description is the full context, lightly cleaned up (fix filler words/false ' +
      'starts/transcription glitches) but keeping every real detail — do not summarize the ' +
      'description, only the title. If the note names who this should be assigned to, match ' +
      'them against this exact member list and return their gid — match by sound-alike/' +
      'phonetic similarity too (e.g. "Katy", "Cady", "Katie" should all match a member named ' +
      `"Katie"), but never invent a gid and never guess if genuinely no one is a close match:\n${membersForPrompt(members)}\n` +
      'If the note mentions a due date (e.g. "by Friday", "next week", "end of month"), ' +
      `resolve it to an actual date. Today is ${todayContext()}. ` +
      'If nothing is said about who it is for or when it is due, leave those fields null — ' +
      'do not default to assigning it to anyone.',
    text
  );

  if (!parsed || !parsed.title || !parsed.description) return plainSplit(text);

  return {
    title: String(parsed.title).trim(),
    description: String(parsed.description).trim(),
    assigneeGid: parsed.assigneeGid || null,
    dueDate: parsed.dueDate || null,
  };
}

// Lighter-weight version used when adding a comment to an existing ticket —
// no title/description needed, just checks whether the note mentions an
// assignee or due date that wasn't already picked manually in the app.
async function extractAssigneeAndDueDate(text, members) {
  const parsed = await callClaudeJson(
    'A note is being added as a comment on an existing task. The text was produced by ' +
      'speech-to-text from a voicemail, so expect imperfect transcription: misheard or ' +
      'phonetically-spelled names, dropped/wrong words, odd punctuation. Do your best to ' +
      'understand the intended meaning anyway. Check whether it mentions who the task ' +
      'should be assigned to and/or a due date. Reply with ONLY raw compact JSON and ' +
      'nothing else — no markdown, no code fences, no commentary: ' +
      '{"assigneeGid": "..." or null, "dueDate": "YYYY-MM-DD" or null}. ' +
      'If a person is named, match them against this exact member list and return their ' +
      'gid — match by sound-alike/phonetic similarity too (e.g. "Katy", "Cady", "Katie" ' +
      'should all match a member named "Katie"), but never invent a gid and never guess if ' +
      `genuinely no one is a close match:\n${membersForPrompt(members)}\n` +
      `Today is ${todayContext()}, for resolving relative dates like "Friday" or "next week". ` +
      'If nothing is said about either, return both as null.',
    text
  );

  return {
    assigneeGid: parsed?.assigneeGid || null,
    dueDate: parsed?.dueDate || null,
  };
}

// Builds the {assignee, due_on} fields to merge into an Asana payload,
// omitting anything the caller didn't actually set.
function optionalTaskFields(assigneeGid, dueDate) {
  const fields = {};
  if (assigneeGid) fields.assignee = assigneeGid;
  if (dueDate) fields.due_on = dueDate; // expects YYYY-MM-DD
  return fields;
}

// Explicit values chosen in the app UI always win over anything AI-inferred
// from the dictated text — AI only fills in what the person didn't already set.
function mergeField(explicitValue, aiValue) {
  return explicitValue || aiValue || null;
}

// Either comment on an existing task (taskGid provided) or create a new one
// in the default project (taskGid omitted). assigneeGid and dueDate are both
// optional in either case, and can come from the UI, from AI reading the
// dictated text, or both (UI wins on conflict).
app.post('/api/submit', requireAccessCode, async (req, res) => {
  const { taskGid, text, assigneeGid, dueDate } = req.body || {};
  const trimmed = (text || '').trim();

  if (!trimmed) {
    return res.status(400).json({ error: 'Nothing to send — the message was empty.' });
  }

  if (isDryRun) {
    const members = await getProjectMembers();
    const preview = await summarizeUpdate(trimmed, members);
    const finalAssigneeGid = mergeField(assigneeGid, taskGid ? null : preview.assigneeGid);
    const finalDueDate = mergeField(dueDate, taskGid ? null : preview.dueDate);
    console.log('[DRY RUN] Would send to Asana:', {
      taskGid: taskGid || null,
      text: trimmed,
      assigneeGid: finalAssigneeGid,
      dueDate: finalDueDate,
      wouldUseTitle: taskGid ? null : preview.title,
      wouldUseDescription: taskGid ? null : preview.description,
    });
    return res.json({ ok: true, dryRun: true, taskGid: taskGid || 'demo-new-task' });
  }

  if (!ASANA_TOKEN || !ASANA_PROJECT_GID) return serverMisconfigured(res);

  try {
    let url;
    let payload;
    let finalAssigneeGid = assigneeGid || null;
    let finalDueDate = dueDate || null;

    if (taskGid) {
      // Add as a comment on the chosen existing ticket. No title needed here,
      // so no summarization call — just the raw text as-is. Only bother asking
      // AI to check for an assignee/due date if the person didn't already set
      // both manually — no point spending a call when there's nothing to add.
      if (!assigneeGid || !dueDate) {
        const members = await getProjectMembers();
        const inferred = await extractAssigneeAndDueDate(trimmed, members);
        finalAssigneeGid = mergeField(assigneeGid, inferred.assigneeGid);
        finalDueDate = mergeField(dueDate, inferred.dueDate);
      }
      url = `${ASANA_API}/tasks/${taskGid}/stories`;
      payload = { data: { text: trimmed } };
    } else {
      // Create a brand-new ticket. Let Claude split this into a short title
      // + a cleaned-up description, and pick up any assignee/due-date mention,
      // when it's configured and within budget; otherwise plainSplit() inside
      // summarizeUpdate() covers it seamlessly.
      const members = await getProjectMembers();
      const { title, description, assigneeGid: aiAssigneeGid, dueDate: aiDueDate } =
        await summarizeUpdate(trimmed, members);
      finalAssigneeGid = mergeField(assigneeGid, aiAssigneeGid);
      finalDueDate = mergeField(dueDate, aiDueDate);
      url = `${ASANA_API}/tasks`;
      payload = {
        data: {
          name: title,
          notes: description,
          projects: [ASANA_PROJECT_GID],
          ...optionalTaskFields(finalAssigneeGid, finalDueDate),
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
    // an existing ticket needs a second request to apply those, if given
    // (either picked manually in the UI or inferred by AI above).
    if (taskGid && (finalAssigneeGid || finalDueDate)) {
      const updateFields = optionalTaskFields(finalAssigneeGid, finalDueDate);
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
