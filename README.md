# Taskshi — Setup Guide

Organize. Assign. Track. Achieve. A multi-company, role-based project tracker built with
vanilla HTML/CSS/JS and Firebase (Authentication + Realtime Database), where **every company's
data lives in its own database instance** — not just a filtered folder inside a shared one.

## Files

| File                        | Purpose                                                          |
|------------------------------|-------------------------------------------------------------------|
| `index.html`                | App shell, layout, and all CSS                                    |
| `app.js`                     | All application logic (Firebase, rendering, events)                |
| `control-plane-rules.json`  | Security rules for the one shared control-plane database          |
| `tenant-rules.json`          | Security rules to apply to **every company's** own database        |
| `combined-demo-rules.json`  | Both rule sets merged — for quickly testing with a single database |
| `logo.png`                   | Add your own logo here (referenced by `index.html`)                |

## 1. A word on security first, since that's what prompted this architecture

Firebase Realtime Database isn't open source — it's a managed Google service — but you were
right to worry about it: it's a **public backend**. Anyone who opens your app can see the
`apiKey` and `databaseURL` in the page source. That's normal and expected for Firebase; those
values are not secrets. The only thing standing between "anyone on the internet" and your
data is the **Security Rules** you publish, so that's where all real protection has to live.

Two changes were made specifically for that:

1. **Every company now gets its own Realtime Database instance.** Company A's rules can't be
   misconfigured into leaking into Company B's data, because they're not even in the same
   database — Firebase enforces the boundary at the infrastructure level, not just in your
   rule logic.
2. **Rules were rewritten so nothing is readable by "any authenticated user."** Every read in
   `tenant-rules.json` requires the requester to already have a `/users/{uid}` record inside
   *that specific* company's database. Every write in `control-plane-rules.json` is scoped so
   a Team Lead can only invite people into their own company, and only a Master Admin can
   invite another Master Admin — see "Security model in detail" below for the full reasoning.

## 2. Architecture

```
CONTROL-PLANE DATABASE (one per deployment, shared)
  /creators/{uid}                 → who may register companies
  /creatorProfiles/{uid}          → a creator's display name
  /companies/{companyId}          → { name, databaseURL, createdAt, createdBy }
  /memberCompany/{uid}            → { companyId, role, email } — which company you belong to
  /platformInvites/{emailKey}     → pending invite, used to route a signup to the right company
  /userRouting/{emailKey}         → once activated: fast lookup straight to your company's DB

COMPANY DATABASE  (one per company — its own URL, its own rules)
  /meta                           → { name, createdAt }
  /users/{uid}                    → { email, name, role, createdAt }
  /teams/{teamId}                 → { name, leadEmails/leadUids, memberEmails/memberUids }
  /projects/{projectId}           → { name, description, teamId, status, assignedEmails, stages }
  /pendingInvites/{emailKey}      → team-level invite record local to this company
  /userProjectIndex/{emailKey}    → { projectId: true, ... } — fast "my projects" lookup
```

A single Firebase **project** (one `apiKey`/`authDomain`) can host many Realtime Database
*instances*. Authentication stays shared across every company (one login system, one set of
accounts) — only the data storage is split per company. This is what "different database for
different companies" means in Firebase terms, and it's why `app.js` calls
`getDatabase(app, someCompanysURL)` to connect to whichever company's data is relevant, instead
of always using the same database handle.

## 3. Roles

| Role | Scope | Can do |
|---|---|---|
| **Creator** | Platform-wide, one-time bootstrap | Register companies, assign each one's first Master Admin. Never reads a company's teams/projects. |
| **Master Admin** | One company | Full access to every team and project *in that company only*. Create teams, invite additional Master Admins. |
| **Team Lead / Admin** | Teams they lead | Create projects under their team, define stages + due dates, invite Team Leads/Members by email. |
| **Team Member** | Assigned projects only | Sees only the projects where their email is in `assignedEmails`. Can check stages off; can't edit structure. |

A Master Admin in Company A has **zero visibility** into Company B — not filtered out by the
UI, but structurally impossible, because their session never connects to Company B's database
at all.

## 4. First-time Firebase setup

1. In the [Firebase Console](https://console.firebase.google.com/), open your project.
2. **Authentication → Sign-in method →** enable **Email/Password**. (Shared across all companies.)
3. **Realtime Database:** confirm your default instance URL matches the one already filled in
   at the top of `app.js` (`CONTROL_DB_URL`). This database will serve as the control plane.
4. **Realtime Database → Rules:** paste in `control-plane-rules.json` and publish. *(If you're
   doing the quick single-database test in the walkthrough below, publish
   `combined-demo-rules.json` instead — see step 4 of the walkthrough.)*
5. **Project settings → General → Your apps →** add/open a Web app and copy its config into the
   `firebaseConfig` object at the top of `app.js`.
6. Serve the app over `http://`/`https://` (ES modules need a real origin, not `file://`):
   ```bash
   npx serve .
   # or
   python3 -m http.server 8080
   ```

## 5. Step-by-step: test it with a "Reconense" login

This walkthrough uses the **same database for everything** so you can test in minutes without
provisioning a second Realtime Database instance. (Section 6 below covers giving Reconense its
own fully isolated database, which is what you'd do for a real second company.)

**Step 1 — Publish the demo rules.**
Realtime Database → Rules → paste the contents of `combined-demo-rules.json` → Publish.

**Step 2 — Open the app.** Since no Creator exists yet, the login screen shows a **"Become
Creator"** tab. Fill it in with values you'll remember, e.g.:
- Name: `Platform Owner`
- Email: `owner@taskshi.dev`
- Password: any password you choose (6+ characters)

Click **Become Creator**. You're now signed in as the platform Creator — you'll see a
"Companies" screen.

**Step 3 — Register the Reconense company.** Click **New Company** and enter:
- Company name: `Reconense`
- Database URL: paste the *same* `databaseURL` you used in `firebaseConfig` (quick-test mode)
- Initial Master Admin email: `admin@reconense.com`

Click **Register Company**. This creates an invite for `admin@reconense.com` — it does **not**
create a password for them; nobody's password is ever set by anyone but that person.

**Step 4 — Sign out** (top-right of the header).

**Step 5 — Accept the invite as Reconense's Master Admin.** On the login screen, open the
**Accept Invite** tab and enter:
- Your name: `Reconense Admin`
- Invited email: `admin@reconense.com` *(must match exactly)*
- Create a password: any password you choose

Click **Activate Account**. You're now signed in as the **Master Admin of Reconense** — full
access to Reconense's teams and projects, and no visibility into any other company.

**Step 6 — Try it out.** Create a team (e.g. "Engineering"), invite a Team Lead or Team Member
by email with a role, create a project under that team, add stages with due dates, and watch
the status badges (Overdue / Due Soon / On Track / Completed) update.

To test the Team Lead/Member experience, invite a second email address from the Teams screen,
sign out, and use **Accept Invite** again with that email to see their more limited view.

## 6. Giving a company its own fully isolated database

For real multi-company use, don't reuse one database for everything — give each company a
dedicated instance:

1. Firebase Console → **Realtime Database → Add Database** (or, in older console layouts,
   the "⋮" menu next to your existing database → "Create instance"). Pick a region and a name,
   e.g. `reconense-default-rtdb`.
2. Open that new instance's **Rules** tab and paste in `tenant-rules.json` → Publish.
3. Copy its URL (shown at the top of the instance page,
   `https://reconense-default-rtdb.<region>.firebasedatabase.app/`).
4. As the Creator, register the company using *that* URL instead of the shared one.

Client-side JavaScript intentionally cannot create a new database instance for you — doing so
requires elevated Firebase Management credentials that must never be shipped to a browser.
Provisioning a new instance is a one-time console/CLI step you (the platform operator) do; the
app only ever needs the resulting URL.

## 7. Security model in detail

**Control plane (`control-plane-rules.json`):**
- `/creators` can only ever be written once, globally — the very first successful write locks
  the door for everyone else. There's intentionally no in-app way to add a second Creator; do
  that directly in the Firebase Console if you ever need to.
- `/companies` is Creator-only, both read and write.
- `/platformInvites` can be created by a Creator, or by an existing Master Admin/Team Lead
  *for their own company only* (checked via `/memberCompany`) — and only a Master Admin can
  create a `masterAdmin`-role invite. Anyone can delete/consume the one invite matching their
  own authenticated email (that's how "Accept Invite" cleans up after itself).
- `/userRouting` and `/memberCompany` entries can only ever be written by the account they
  belong to.

**Tenant database (`tenant-rules.json`), applied identically to every company:**
- Every read requires an existing `/users/{uid}` record in *that* database — an authenticated
  user who isn't a member of this company gets nothing back, even if they know the URL.
- Only a Master Admin can create a team; a Team Lead can only modify a team they already lead.
- Only a Master Admin or that project's team lead can edit a project's structure; the deeper
  `stages/{stageId}` rule separately lets any tenant member with access toggle a stage's
  `completed` flag, matching the client's "assigned members can check things off, but can't
  restructure the project" behavior.

**Known limitation, stated plainly:** Realtime Database rules can't see "is this email in this
project's `assignedEmails` map" without a string-transform the rules language doesn't support,
so the stage-toggle rule is scoped to "any member of this company," not "specifically the
people assigned to this project." The client UI never exposes unassigned projects to a Team
Member, but a technically sophisticated member of the same company could toggle a stage on a
project outside their assignment via a direct API call. If that residual gap matters for your
use case, add a small Cloud Function to validate writes against `assignedEmails` server-side.

## 8. Status badge logic

Unchanged from the single-company version — computed live against today's date in
`getStageStatus()`: **Completed** (checked), **Overdue** (past due, unchecked), **Due Soon**
(within 3 days), **On Track** (further out).

---

Developed by **Reconense**.
