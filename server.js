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

// Fetches the default project's actual sections, so the AI can be told the
// real ones instead of guessing at names.
async function getProjectSections() {
  if (isDryRun) {
    return [
      { gid: 'demo-section-admin', name: 'Admin' },
      { gid: 'demo-section-adhoc', name: 'Ad Hoc' },
      { gid: 'demo-section-recurring', name: 'Recurring Appointments' },
    ];
  }
  if (!ASANA_TOKEN || !ASANA_PROJECT_GID) return [];

  const url = `${ASANA_API}/projects/${ASANA_PROJECT_GID}/sections?opt_fields=name,gid`;
  const r = await fetch(url, { headers: asanaHeaders() });
  if (!r.ok) return [];
  const body = await r.json();
  return (body.data || []).map((s) => ({ gid: s.gid, name: s.name }));
}

// Only auto-categorize into these three specific buckets, matched by keyword
// against the project's real section names (so it adapts if they're renamed,
// but never invents a section that doesn't exist). Anything else — Aspen
// Office, Turo, Travel, etc. — is intentionally left alone; those aren't
// meant to be auto-picked by dictated updates.
function categorizableSections(sections) {
  const byKeyword = (keyword) =>
    sections.find((s) => s.name.toLowerCase().replace(/\s+/g, '').includes(keyword));

  const admin = byKeyword('admin');
  const adHoc = byKeyword('adhoc');
  const recurring = byKeyword('recurring');

  const result = [];
  if (admin) result.push({ ...admin, category: 'admin tasks (paperwork, scheduling, policy/business admin work)' });
  if (adHoc) result.push({ ...adHoc, category: 'random one-off / miscellaneous tasks' });
  if (recurring) result.push({ ...recurring, category: 'any kind of recurring personal appointment (medical, grooming, subscriptions, etc.)' });
  return result;
}

function sectionsForPrompt(categorized) {
  if (!categorized.length) return '(no matching sections available — always leave sectionGid null)';
  return categorized.map((s) => `"${s.name}" — use for ${s.category} (gid: ${s.gid})`).join('\n');
}

// Falls back to the old behavior: first ~100 chars as the title, full text
// as the description, no assignee/due date/section guessed. Used whenever AI
// summarization isn't available, hasn't been configured, is over its daily
// budget, or fails for any reason.
function plainSplit(text) {
  const name = text.length > 100 ? `${text.slice(0, 97)}...` : text;
  return { title: name, description: text, assigneeGid: null, dueDate: null, sectionGid: null };
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
// due, or clearly reads as one of a few known task categories — also pulls
// out an assignee, due date, and section if they apply.
async function summarizeUpdate(text, members, sections) {
  const categorized = categorizableSections(sections);
  const parsed = await callClaudeJson(
    'You turn a dictated voice-note update into a task title and description, and ' +
      'pick up on any assignment/due-date/category instructions in the same note. ' +
      'The text was produced by speech-to-text from a voicemail, so expect imperfect ' +
      'transcription: misheard or phonetically-spelled names, dropped/wrong words, run-on ' +
      'sentences, and odd punctuation. Do your best to understand the intended meaning ' +
      'anyway rather than taking the literal wording too strictly. ' +
      'Reply with ONLY raw compact JSON and nothing else — no markdown, no code fences, ' +
      'no commentary before or after it: ' +
      '{"title": "...", "description": "...", "assigneeGid": "..." or null, "dueDate": "YYYY-MM-DD" or null, "sectionGid": "..." or null}. ' +
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
      'do not default to assigning it to anyone. ' +
      'Separately, decide which section this task belongs in, using ONLY this list — never ' +
      `invent a section gid:\n${sectionsForPrompt(categorized)}\n` +
      'Only set sectionGid when the task clearly and confidently fits one of these categories. ' +
      'If it could reasonably belong to more than one, is ambiguous, or does not clearly match ' +
      'any of them, leave sectionGid null — leaving it uncategorized is always safer than a ' +
      'wrong guess.',
    text
  );

  if (!parsed || !parsed.title || !parsed.description) return plainSplit(text);

  // Never trust the AI's sectionGid blindly — only accept it if it's actually
  // one of the categorizable sections we offered it.
  const validSectionGid = categorized.some((s) => s.gid === parsed.sectionGid)
    ? parsed.sectionGid
    : null;

  return {
    title: String(parsed.title).trim(),
    description: String(parsed.description).trim(),
    assigneeGid: parsed.assigneeGid || null,
    dueDate: parsed.dueDate || null,
    sectionGid: validSectionGid,
  };
}

// Used when a dictated note is being added to an EXISTING ticket. Rather than
// always just bolting the note on as a comment, this assesses whether it
// actually calls for updating the task (assignee, due date, marking it
// complete) and whether it's worth logging as a comment at all, or if it's
// purely a bare instruction with nothing else to record.
async function assessExistingTicketUpdate(text, members) {
  const parsed = await callClaudeJson(
    'A dictated voice-note is being added to an existing task. The text was produced by ' +
      'speech-to-text from a voicemail, so expect imperfect transcription: misheard or ' +
      'phonetically-spelled names, dropped/wrong words, odd punctuation. Do your best to ' +
      'understand the intended meaning anyway. ' +
      'Assess four things about this note. Reply with ONLY raw compact JSON and nothing ' +
      'else — no markdown, no code fences, no commentary before or after it: ' +
      '{"assigneeGid": "..." or null, "dueDate": "YYYY-MM-DD" or null, "markComplete": true or false, "shouldComment": true or false}. ' +
      'assigneeGid: if the note names who this should be assigned to, match them against ' +
      'this exact member list and return their gid — match by sound-alike/phonetic ' +
      'similarity too (e.g. "Katy", "Cady", "Katie" should all match a member named ' +
      `"Katie"), but never invent a gid and never guess if genuinely no one is a close match:\n${membersForPrompt(members)}\n` +
      'dueDate: if the note mentions a due date (e.g. "by Friday", "next week"), resolve it ' +
      `to an actual date. Today is ${todayContext()}. ` +
      'markComplete: true only if the note clearly says this task is done, finished, ' +
      'completed, resolved, or no longer needed (e.g. "this is done", "already took care of ' +
      'it", "go ahead and close this out") — false otherwise, and false whenever it is at ' +
      'all ambiguous. ' +
      'shouldComment: whether this note contains real context, detail, or information worth ' +
      'keeping as a permanent record on the task — true in almost every case. Set it to ' +
      'false ONLY when the note is purely a bare instruction with nothing else worth ' +
      'logging (e.g. it is just "assign this to Katie", or just "mark this done", or just ' +
      '"due Friday", and genuinely nothing more). When in doubt, set shouldComment to true — ' +
      'it is always safer to keep a record than to silently lose one.',
    text
  );

  return {
    assigneeGid: parsed?.assigneeGid || null,
    dueDate: parsed?.dueDate || null,
    markComplete: parsed?.markComplete === true,
    shouldComment: parsed?.shouldComment !== false,
  };
}

// Builds the {assignee, due_on, completed} fields to merge into an Asana
// payload, omitting anything the caller didn't actually set. Only ever sets
// completed to true (marking done) — never used to reopen a task.
function optionalTaskFields(assigneeGid, dueDate, completed) {
  const fields = {};
  if (assigneeGid) fields.assignee = assigneeGid;
  if (dueDate) fields.due_on = dueDate; // expects YYYY-MM-DD
  if (completed) fields.completed = true;
  return fields;
}

// Explicit values chosen in the app UI always win over anything AI-inferred
// from the dictated text — AI only fills in what the person didn't already set.
function mergeField(explicitValue, aiValue) {
  return explicitValue || aiValue || null;
}

// Either update an existing task (taskGid provided) or create a new one in
// the default project (taskGid omitted). assigneeGid and dueDate are both
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
    if (taskGid) {
      const assessed = await assessExistingTicketUpdate(trimmed, members);
      console.log('[DRY RUN] Would update existing ticket:', {
        taskGid,
        text: trimmed,
        assigneeGid: mergeField(assigneeGid, assessed.assigneeGid),
        dueDate: mergeField(dueDate, assessed.dueDate),
        markComplete: assessed.markComplete,
        shouldComment: assessed.shouldComment,
      });
    } else {
      const sections = await getProjectSections();
      const preview = await summarizeUpdate(trimmed, members, sections);
      console.log('[DRY RUN] Would create new ticket:', {
        text: trimmed,
        assigneeGid: mergeField(assigneeGid, preview.assigneeGid),
        dueDate: mergeField(dueDate, preview.dueDate),
        wouldUseTitle: preview.title,
        wouldUseDescription: preview.description,
        wouldUseSectionGid: preview.sectionGid,
      });
    }
    return res.json({ ok: true, dryRun: true, taskGid: taskGid || 'demo-new-task' });
  }

  if (!ASANA_TOKEN || !ASANA_PROJECT_GID) return serverMisconfigured(res);

  try {
    if (taskGid) {
      // Existing ticket: assess what the note actually calls for, rather
      // than always just bolting it on as a comment — it might be assigning
      // it, setting a due date, marking it complete, or some combination,
      // with or without anything worth logging as a comment too.
      const members = await getProjectMembers();
      const assessed = await assessExistingTicketUpdate(trimmed, members);
      const finalAssigneeGid = mergeField(assigneeGid, assessed.assigneeGid);
      const finalDueDate = mergeField(dueDate, assessed.dueDate);
      const markComplete = assessed.markComplete === true;
      const hasOtherAction = Boolean(finalAssigneeGid || finalDueDate || markComplete);
      // Never silently drop the note — if nothing else is happening as a
      // result of it, always keep a record via a comment regardless of what
      // the AI decided.
      const shouldComment = assessed.shouldComment !== false || !hasOtherAction;

      const actions = [];
      let warning = null;

      if (shouldComment) {
        const storyR = await fetch(`${ASANA_API}/tasks/${taskGid}/stories`, {
          method: 'POST',
          headers: asanaHeaders(),
          body: JSON.stringify({ data: { text: trimmed } }),
        });
        if (!storyR.ok) {
          const storyBody = await storyR.json().catch(() => ({}));
          return res.status(storyR.status).json({
            error: storyBody?.errors?.[0]?.message || 'Asana rejected the comment.',
          });
        }
        actions.push('commented');
      }

      const updateFields = optionalTaskFields(finalAssigneeGid, finalDueDate, markComplete);
      if (Object.keys(updateFields).length) {
        const updateR = await fetch(`${ASANA_API}/tasks/${taskGid}`, {
          method: 'PUT',
          headers: asanaHeaders(),
          body: JSON.stringify({ data: updateFields }),
        });
        if (!updateR.ok) {
          const updateBody = await updateR.json().catch(() => ({}));
          warning =
            (shouldComment ? 'Comment was added, but c' : 'C') +
            'ould not apply the update: ' +
            (updateBody?.errors?.[0]?.message || 'Asana rejected the request.');
        } else {
          if (finalAssigneeGid) actions.push('assigned');
          if (finalDueDate) actions.push('due date set');
          if (markComplete) actions.push('marked complete');
        }
      }

      return res.json({ ok: true, taskGid, warning, actions });
    }

    // Create a brand-new ticket. Let Claude split this into a short title +
    // a cleaned-up description, pick up any assignee/due-date mention, and
    // categorize it into a section when it's configured and within budget;
    // otherwise plainSplit() inside summarizeUpdate() covers it seamlessly
    // (new ticket lands with no section, which is the safe default when
    // nothing can be inferred).
    const members = await getProjectMembers();
    const sections = await getProjectSections();
    const {
      title,
      description,
      assigneeGid: aiAssigneeGid,
      dueDate: aiDueDate,
      sectionGid,
    } = await summarizeUpdate(trimmed, members, sections);
    const finalAssigneeGid = mergeField(assigneeGid, aiAssigneeGid);
    const finalDueDate = mergeField(dueDate, aiDueDate);

    const payload = {
      data: {
        name: title,
        notes: description,
        // `projects` is required on every create call (Asana needs it to
        // infer the workspace) — `memberships` is an *additional* hint on
        // top of that which places the task directly into a section when
        // we have a confident match; otherwise it just lands in the
        // project with no section (the default/uncategorized area), per
        // "if unsure, don't put it in any section."
        projects: [ASANA_PROJECT_GID],
        ...(sectionGid
          ? { memberships: [{ project: ASANA_PROJECT_GID, section: sectionGid }] }
          : {}),
        ...optionalTaskFields(finalAssigneeGid, finalDueDate),
      },
    };

    const r = await fetch(`${ASANA_API}/tasks`, {
      method: 'POST',
      headers: asanaHeaders(),
      body: JSON.stringify(payload),
    });
    const body = await r.json();

    if (!r.ok) {
      const message = body?.errors?.[0]?.message || 'Asana rejected the request.';
      return res.status(r.status).json({ error: message });
    }

    res.json({ ok: true, taskGid: body?.data?.gid || null, warning: null, actions: ['created'] });
  } catch (err) {
    console.error('POST /api/submit failed:', err);
    res.status(502).json({ error: 'Could not reach Asana. Try again in a moment.' });
  }
});

const port = PORT || 3000;
app.listen(port, () => {
  console.log(`voice-to-asana listening on port ${port}${isDryRun ? ' [DRY RUN]' : ''}`);
});
