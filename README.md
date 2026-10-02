# Quick Update → Asana

A tiny mobile web app: open it, dictate an update using your iPhone's own
keyboard microphone, tap Send, and it lands on an Asana ticket — either as a
comment on an existing one you pick, or as a brand-new ticket.

It does **not** record or transcribe audio itself. It relies on the iPhone's
built-in dictation (the mic key on the keyboard), which is far more reliable
than anything a web page can do with the microphone directly, and needs no
extra transcription service or API key.

## What you need before you start

- An Asana account with access to the project you want tickets created in.
- A free GitHub account (to hold the code).
- A free Render account (to run the code so it has a real, always-on web address).

None of these need a credit card for what this app does.

## 1. Get your Asana Personal Access Token

1. Go to <https://app.asana.com/0/my-apps>
2. Click **Manage Developer Apps** → **Personal Access Tokens** → **Create new token**
3. Name it something like "Quick Update app" and copy the token.
4. **Keep this private** — anyone with it can read/write your Asana account.
   Never paste it into a chat, a public repo, or the app's source code. It
   only ever goes into Render's environment variable settings (step 4).

## 2. Confirm your Asana project GID

The project GID is the number in the project's URL:

```
app.asana.com/1/<workspace>/project/<THIS NUMBER>/list/...
```

This app defaults to `1207508814915091` (the ASAY - BIZ DEV project used
while this was built). Double-check that's still the right project, or grab
the GID from whichever project you actually want new tickets to land in.

## 3. Put the code on GitHub

1. Go to <https://github.com/new>, create a new **private** repository
   (e.g. `quick-update-asana`).
2. On the new repo's page, click **uploading an existing file** and drag in
   every file from this folder *except* `.env` if you ever create one
   locally (there isn't one included here — only `.env.example`).
3. Commit the files.

## 4. Deploy it on Render

1. Go to <https://dashboard.render.com/register> and sign up (free, no card).
2. Connect your GitHub account when prompted.
3. Click **New +** → **Web Service**, and pick the repo you just created.
4. Settings:
   - **Language:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Before deploying, add these **Environment Variables**:
   | Key | Value |
   |---|---|
   | `ASANA_TOKEN` | the token from step 1 |
   | `ASANA_PROJECT_GID` | the GID from step 2 |
   | `ACCESS_CODE` | any short passcode you'll remember (e.g. `asay2026`) |
6. Click **Deploy**. Wait for the status to say **Live** (a couple of minutes).
7. Render gives you a URL like `https://quick-update-asana.onrender.com` —
   that's the app.

**One free-tier quirk:** if nobody opens the app for 15 minutes, Render puts
it to sleep. The next open takes ~20–30 seconds to wake back up, then it's
instant after that. If that ever becomes annoying, Render's cheapest paid
tier (a few dollars/month) removes it — not needed to start.

## 5. Put it on the iPhone home screen

1. Open the Render URL in **Safari** on the iPhone.
2. Enter the access code you set in step 5 above.
3. Tap the **Share** icon → **Add to Home Screen**.
4. It now opens full-screen, like a real app, with one tap.

## 6. Try it safely first (optional but recommended)

Before pointing this at real tickets, you can sanity-check the deploy without
touching Asana at all: temporarily add an environment variable `DRY_RUN` set
to `true` in Render, redeploy, and use the app — it'll return fake success
messages and a demo ticket list instead of calling Asana. Remove that
variable (or set it to `false`) once you've confirmed it looks right.

## How it works, briefly

- `server.js` is a small Express server with two endpoints: one that lists
  open tickets in your project, and one that either adds a comment to a
  ticket you picked or creates a new one, using Asana's REST API
  (`POST /tasks`, `POST /tasks/{gid}/stories`).
- `public/index.html` is the whole front end — a text box, a ticket picker,
  and a Send button. No frameworks, nothing to build.
- The access code is checked on the server, not just hidden in the app, so
  it actually stops someone who finds the URL from creating tickets.

## Extending this later

- **Voice-triggered instead of tap-to-open:** an iPhone Shortcut can open
  this app's URL (or POST straight to `/api/submit`) from a Siri phrase like
  "Hey Siri, log update" — fully hands-free, no unlocking the phone first.

## Automatic board + section routing, and the Asana link

`ASANA_PROJECT_GID` is still the *default* board new tickets land on, but a
new ticket is no longer stuck there — the same AI pass that writes the
title/description also looks at every other board in your workspace and
moves the ticket to a different one only when it's clearly and specifically
about something else (e.g. the default board is personal/household and the
note is obviously a business-dev item). When it's at all ambiguous, it stays
on the default board — that's always the safer call.

Once a board is picked, the ticket is also dropped into that board's
"Admin" / "Ad Hoc" / "Recurring" section automatically, the same way it
always categorized sections on the one default project — just scoped to
whichever board it actually landed on.

## Splitting a note into tickets and subtasks

One dictated note doesn't always mean one ticket. The same AI pass now also
decides:

- **Separate tickets** when the note names two or more genuinely independent
  things — unrelated errands, different people or topics, anything that
  would make sense to finish on completely different days. Each one lands as
  its own ticket (own title, description, assignee, due date, board, and
  section).
- **Subtasks on one ticket** when the note describes a single goal made up of
  smaller steps or milestones (e.g. "get quotes, then pick a contractor,
  then schedule the install") — those become Asana subtasks under one
  ticket instead of separate tickets.

Most notes are still just one plain ticket with no subtasks — splitting or
adding subtasks only happens when the note clearly calls for it; when it's
a toss-up, it stays as a single ticket (easier to split by hand later than
to untangle wrongly-separated tickets). If a ticket's subtasks fail to save
for some reason, the ticket itself still gets created — you'll see a note
in the app telling you which subtask to add by hand.

After every send, the app now also shows an **Open in Asana** link straight
to the ticket that was just created or updated, so you're never stuck
hunting for it.

None of this needs a new environment variable — it reuses the same
`ASANA_TOKEN` and `ASANA_PROJECT_GID` you already set, and simply asks Asana
which other boards that token can see.
