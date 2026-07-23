// ============================================================================
// Taskshi — Application Logic
// Firebase v10 modular SDK (Authentication + Realtime Database)
//
// ARCHITECTURE
// ------------
// Two tiers of Firebase Realtime Database live in the SAME Firebase project:
//
//   1. CONTROL-PLANE database (fixed, one per deployment) — holds only:
//        /creators/{uid}            who is allowed to provision companies
//        /creatorProfiles/{uid}     display name for a creator
//        /companies/{companyId}     company registry: name + its OWN database URL
//        /memberCompany/{uid}       which company + role a signed-in user belongs to
//        /platformInvites/{email}   pending invites, used to route a new signup
//                                   to the right company database before they're
//                                   authenticated into it
//        /userRouting/{email}       once activated, maps an email straight to its
//                                   company database for fast future logins
//
//   2. TENANT databases — one dedicated Realtime Database PER COMPANY, holding
//      that company's own data only:
//        /meta, /users, /teams, /projects, /pendingInvites, /userProjectIndex
//
// A company's tenant database is a genuinely separate Realtime Database
// instance (its own URL) — not just a filtered node inside a shared database.
// That is what gives every company hard data isolation from every other
// company, enforced by Firebase Security Rules on each instance, not just by
// what the UI chooses to display.
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getDatabase, ref, get, set, update, remove, push, onValue, off
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

// ----------------------------------------------------------------------------
// 1. FIREBASE CONFIG — replace the placeholders with your project's values.
//    CONTROL_DB_URL is the one fixed database every deployment shares.
//    Each company gets its OWN databaseURL, entered by the Creator when they
//    register that company (see README for how to provision one).
// ----------------------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyAQlVa_wzc8EO0lpYUo1svL7-NWEv6B9VI",
  authDomain: "office-projects-c0d04.firebaseapp.com",
  databaseURL: "https://office-projects-c0d04-default-rtdb.europe-west1.firebasedatabase.app/",
  projectId: "office-projects-c0d04",
  storageBucket: "office-projects-c0d04.appspot.com",
  messagingSenderId: "1041733503584",
  appId: "1:1041733503584:web:37c4b7d2f8fd19c85a5105"
};
const CONTROL_DB_URL = firebaseConfig.databaseURL;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const controlDb = getDatabase(app, CONTROL_DB_URL);
let tenantDb = null; // set once we know which company's database to talk to

// ----------------------------------------------------------------------------
// 2. GLOBAL STATE
// ----------------------------------------------------------------------------
const state = {
  user: null,
  profile: null,   // { role: "creator"|"masterAdmin"|"teamLead"|"teamMember", name, email }
  company: null,   // { id, name, databaseURL }  — null for creator sessions
  companies: {},   // creator session only — control-plane company registry
  teams: {},
  projects: {},
  tenantUsers: {},
  currentView: "dashboard",
  projectFilter: "active",
  searchTerm: "",
  authTab: "signin",         // signin | invite | creator-bootstrap
  listeners: {},
  creatorBootstrapAvailable: false,
  sidebarOpen: false,
  authInProgress: false,
  pendingSignupName: null,
};

// ----------------------------------------------------------------------------
// 3. UTILITIES
// ----------------------------------------------------------------------------
function sanitizeEmailKey(email) {
  return (email || "").trim().toLowerCase()
    .replace(/\./g, ",").replace(/#/g, "").replace(/\$/g, "")
    .replace(/\[/g, "").replace(/\]/g, "").replace(/\//g, "");
}
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
function initials(nameOrEmail) {
  const s = (nameOrEmail || "?").trim();
  const parts = s.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}
function formatDate(dateStr) {
  if (!dateStr) return "No date set";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return "No date set";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function daysUntil(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(dateStr + "T00:00:00");
  return Math.round((due - today) / 86400000);
}
function getStageStatus(stage) {
  if (stage.completed) return { label: "Completed", cls: "badge-completed" };
  if (!stage.dueDate) return { label: "No date", cls: "badge-neutral" };
  const diff = daysUntil(stage.dueDate);
  if (diff < 0) return { label: `Overdue ${Math.abs(diff)}d`, cls: "badge-overdue" };
  if (diff === 0) return { label: "Due today", cls: "badge-duesoon" };
  if (diff <= 3) return { label: `Due in ${diff}d`, cls: "badge-duesoon" };
  return { label: "On Track", cls: "badge-ontrack" };
}
function projectOverallStatus(project) {
  const stages = Object.values(project.stages || {});
  const open = stages.filter(s => !s.completed);
  if (!stages.length) return { label: "No stages yet", cls: "badge-neutral" };
  if (!open.length) return { label: "All stages complete", cls: "badge-completed" };
  if (open.some(s => s.dueDate && daysUntil(s.dueDate) < 0)) return { label: "Overdue", cls: "badge-overdue" };
  if (open.some(s => s.dueDate && daysUntil(s.dueDate) <= 3)) return { label: "Due Soon", cls: "badge-duesoon" };
  return { label: "On Track", cls: "badge-ontrack" };
}
function computeProgress(project) {
  const stages = Object.values(project.stages || {});
  if (!stages.length) return 0;
  return Math.round((stages.filter(s => s.completed).length / stages.length) * 100);
}
function toast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add("toast-show"));
  setTimeout(() => { el.classList.remove("toast-show"); setTimeout(() => el.remove(), 250); }, 3400);
}
function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) {
    btn.dataset.originalLabel = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> ${escapeHtml(label || "Working...")}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.originalLabel) btn.innerHTML = btn.dataset.originalLabel;
  }
}
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((e || "").trim()); }
function validDbUrl(u) { return /^https:\/\/.+/.test((u || "").trim()); }

// ----------------------------------------------------------------------------
// 4. ROLE / VISIBILITY HELPERS  (all scoped to the CURRENT company only —
//    there is no cross-company visibility for anyone except the Creator's own
//    registry view, which never exposes a company's internal data.)
// ----------------------------------------------------------------------------
function role() { return state.profile ? state.profile.role : null; }
function isCreator() { return role() === "creator"; }
function isMasterAdmin() { return role() === "masterAdmin"; }
function myEmailKey() { return state.user ? sanitizeEmailKey(state.user.email) : ""; }

function isTeamLead(teamId) {
  if (isMasterAdmin()) return true;
  const team = state.teams[teamId];
  if (!team) return false;
  return !!(team.leadEmails && team.leadEmails[myEmailKey()]);
}
function isTeamMember(teamId) {
  const team = state.teams[teamId];
  if (!team) return false;
  return !!(team.memberEmails && team.memberEmails[myEmailKey()]);
}
function myTeamIds() {
  return Object.keys(state.teams).filter(id => isTeamLead(id) || isTeamMember(id));
}
function canManageProject(project) {
  if (!project) return false;
  return isMasterAdmin() || isTeamLead(project.teamId);
}
function canToggleStage(project) {
  if (!project) return false;
  if (canManageProject(project)) return true;
  return !!(project.assignedEmails && project.assignedEmails[myEmailKey()]);
}
function roleLabel(r) {
  return { creator: "Platform Creator", masterAdmin: "Master Admin", teamLead: "Team Lead", teamMember: "Team Member" }[r] || r;
}

function getVisibleProjects() {
  const all = Object.entries(state.projects || {}).map(([id, p]) => ({ id, ...p }));
  let visible;
  if (isMasterAdmin()) {
    visible = all;
  } else {
    const led = new Set(Object.keys(state.teams).filter(isTeamLead));
    visible = all.filter(p => led.has(p.teamId) || (p.assignedEmails && p.assignedEmails[myEmailKey()]));
  }
  if (state.projectFilter === "active") visible = visible.filter(p => p.status !== "archived");
  if (state.projectFilter === "archived") visible = visible.filter(p => p.status === "archived");
  if (state.searchTerm.trim()) {
    const term = state.searchTerm.trim().toLowerCase();
    visible = visible.filter(p => (p.name || "").toLowerCase().includes(term));
  }
  return visible.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
function getVisibleTeams() {
  const all = Object.entries(state.teams || {}).map(([id, t]) => ({ id, ...t }));
  if (isMasterAdmin()) return all.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const mine = new Set(myTeamIds());
  return all.filter(t => mine.has(t.id)).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}
function teamProjectCount(teamId) {
  return Object.values(state.projects || {}).filter(p => p.teamId === teamId && p.status !== "archived").length;
}
function teamName(teamId) { return (state.teams[teamId] && state.teams[teamId].name) || "Unassigned team"; }

// ----------------------------------------------------------------------------
// 5. DATA LISTENERS
// ----------------------------------------------------------------------------
function attachListener(database, path, key, cb) {
  const r = ref(database, path);
  const handler = (snap) => { cb(snap.val() || {}); };
  onValue(r, handler, (err) => console.error(`Listener error @ ${path}`, err));
  state.listeners[key] = { ref: r, cb: handler };
}
function stopAllListeners() {
  Object.values(state.listeners).forEach(({ ref: r, cb }) => off(r, "value", cb));
  state.listeners = {};
  state.companies = {}; state.teams = {}; state.projects = {}; state.tenantUsers = {};
}
function startCreatorListeners() {
  stopAllListeners();
  attachListener(controlDb, "companies", "companies", (val) => { state.companies = val; render(); });
}
function startTenantListeners() {
  stopAllListeners();
  attachListener(tenantDb, "teams", "teams", (val) => { state.teams = val; render(); });
  attachListener(tenantDb, "projects", "projects", (val) => { state.projects = val; render(); });
  attachListener(tenantDb, "users", "tenantUsers", (val) => { state.tenantUsers = val; render(); });
}

// ----------------------------------------------------------------------------
// 6. SESSION RESOLUTION
// ----------------------------------------------------------------------------
async function checkCreatorBootstrap() {
  try {
    const snap = await get(ref(controlDb, "platformBootstrapped"));
    state.creatorBootstrapAvailable = !snap.exists();
  } catch (e) {
    state.creatorBootstrapAvailable = false;
  }
}

/** Figures out (from the control-plane db) whether this signed-in Firebase user
 *  is a Creator or belongs to a company, connects to the right database, and
 *  activates the session. Returns true if a session was activated. */
async function resolveAndActivateSession(firebaseUser) {
  const creatorSnap = await get(ref(controlDb, `creators/${firebaseUser.uid}`));
  if (creatorSnap.exists() && creatorSnap.val() === true) {
    const profSnap = await get(ref(controlDb, `creatorProfiles/${firebaseUser.uid}`));
    const prof = profSnap.exists() ? profSnap.val() : {};
    state.user = firebaseUser;
    state.profile = { role: "creator", name: prof.name || firebaseUser.email.split("@")[0], email: firebaseUser.email };
    state.company = null;
    state.currentView = "companies";
    startCreatorListeners();
    render();
    return true;
  }

  const emailKey = sanitizeEmailKey(firebaseUser.email);
  const routeSnap = await get(ref(controlDb, `userRouting/${emailKey}`));
  if (routeSnap.exists()) {
    const route = routeSnap.val(); // { companyId, databaseURL, email }
    tenantDb = getDatabase(app, route.databaseURL);
    const userSnap = await get(ref(tenantDb, `users/${firebaseUser.uid}`));
    if (userSnap.exists()) {
      const metaSnap = await get(ref(tenantDb, "meta"));
      const companyName = metaSnap.exists() ? (metaSnap.val().name || "") : "";
      state.user = firebaseUser;
      state.profile = userSnap.val();
      state.company = { id: route.companyId, databaseURL: route.databaseURL, name: companyName };
      state.currentView = "dashboard";
      startTenantListeners();
      render();
      return true;
    }
  }
  return false;
}

// ----------------------------------------------------------------------------
// 7. AUTH FLOWS — Creator bootstrap, invite acceptance, sign-in
// ----------------------------------------------------------------------------
async function handleSignIn(email, password) {
  // No manual provisioning here — resolveAndActivateSession() runs from the
  // normal onAuthStateChanged listener since the account already exists.
  await signInWithEmailAndPassword(auth, email, password);
}

async function becomeCreator({ name, email, password }) {
  state.authInProgress = true; // block onAuthStateChanged until we've finished provisioning
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await set(ref(controlDb, `creators/${cred.user.uid}`), true);
    await set(ref(controlDb, `creatorProfiles/${cred.user.uid}`), { name, email, createdAt: Date.now() });
    await set(ref(controlDb, "platformBootstrapped"), true);
    await resolveAndActivateSession(cred.user);
  } finally {
    state.authInProgress = false;
  }
}

async function acceptInvite({ name, email, password }) {
  const emailKey = sanitizeEmailKey(email);
  state.authInProgress = true;
  let cred;
  try {
    // The invite must be read AFTER authenticating — the rule that lets someone
    // read a platformInvite requires it to match their own signed-in email, which
    // doesn't exist until the account itself is created.
    try {
      cred = await createUserWithEmailAndPassword(auth, email, password);
    } catch (err) {
      if (err.code === "auth/email-already-in-use") {
        // Most likely a previous attempt got as far as creating the login but
        // failed on a later step (e.g. rules not published yet at the time).
        // If the password just typed matches, sign into that same account and
        // pick up provisioning where it left off, instead of dead-ending here.
        try {
          cred = await signInWithEmailAndPassword(auth, email, password);
        } catch (signInErr) {
          throw new Error(
            "An account for this email already exists but that password didn't match it. " +
            "Use Sign In instead, or use Forgot Password to reset it."
          );
        }
      } else {
        throw err;
      }
    }

    const inviteSnap = await get(ref(controlDb, `platformInvites/${emailKey}`));
    if (!inviteSnap.exists()) {
      throw new Error(
        "No pending invite found for this email. If your admin already invited you, " +
        "this may mean your account is already active — try Sign In instead."
      );
    }
    const invite = inviteSnap.val();
    const tdb = getDatabase(app, invite.databaseURL);

    await set(ref(tdb, `users/${cred.user.uid}`), { email, name, role: invite.role, createdAt: Date.now() });
    await set(ref(controlDb, `memberCompany/${cred.user.uid}`), { companyId: invite.companyId, role: invite.role, email });

    if (invite.teamId) {
      const field = invite.role === "teamLead" ? "leadUids" : "memberUids";
      await update(ref(tdb, `teams/${invite.teamId}/${field}`), { [cred.user.uid]: true });
    }
    if (invite.role === "masterAdmin") {
      await set(ref(tdb, "meta"), { name: invite.companyName, createdAt: Date.now() });
    }
    await remove(ref(tdb, `pendingInvites/${emailKey}`));
    await remove(ref(controlDb, `platformInvites/${emailKey}`));
    await set(ref(controlDb, `userRouting/${emailKey}`), { companyId: invite.companyId, databaseURL: invite.databaseURL, email });

    await resolveAndActivateSession(cred.user);
  } finally {
    state.authInProgress = false;
  }
}

// ----------------------------------------------------------------------------
// 8. CRUD — Creator: Companies
// ----------------------------------------------------------------------------
async function registerCompany({ name, databaseURL, adminEmail }) {
  const companyId = "company_" + uid();
  await set(ref(controlDb, `companies/${companyId}`), {
    name, databaseURL, createdAt: Date.now(), createdBy: state.user.email,
  });
  const emailKey = sanitizeEmailKey(adminEmail);
  await set(ref(controlDb, `platformInvites/${emailKey}`), {
    email: adminEmail, role: "masterAdmin", companyId, companyName: name, databaseURL,
    invitedAt: Date.now(), invitedBy: state.user.email,
  });
  return companyId;
}
async function inviteAdditionalMasterAdmin(companyId, companyName, databaseURL, email) {
  const emailKey = sanitizeEmailKey(email);
  await set(ref(controlDb, `platformInvites/${emailKey}`), {
    email, role: "masterAdmin", companyId, companyName, databaseURL,
    invitedAt: Date.now(), invitedBy: state.user.email,
  });
}
async function deleteCompany(companyId) {
  // Only removes the company from the platform registry — Taskshi never writes
  // to a company's own tenant database from the Creator side, so its actual
  // teams/projects data (and any already-activated logins to it) are untouched.
  await remove(ref(controlDb, `companies/${companyId}`));
}

// ----------------------------------------------------------------------------
// 9. CRUD — Tenant: Teams / Projects / Stages  (all against `tenantDb`)
// ----------------------------------------------------------------------------
async function createTeam(name) {
  const id = "team_" + uid();
  await set(ref(tenantDb, `teams/${id}`), {
    name, createdAt: Date.now(),
    leadEmails: { [myEmailKey()]: true }, leadUids: { [state.user.uid]: true },
    memberEmails: {}, memberUids: {},
  });
  return id;
}
async function inviteToTeam(teamId, email, teamRole) {
  const emailKey = sanitizeEmailKey(email);
  const field = teamRole === "teamLead" ? "leadEmails" : "memberEmails";
  await update(ref(tenantDb, `teams/${teamId}/${field}`), { [emailKey]: true });
  await set(ref(tenantDb, `pendingInvites/${emailKey}`), {
    email, role: teamRole, teamId, invitedAt: Date.now(), invitedBy: state.user.email,
  });
  await set(ref(controlDb, `platformInvites/${emailKey}`), {
    email, role: teamRole, companyId: state.company.id, companyName: state.company.name,
    databaseURL: state.company.databaseURL, teamId, invitedAt: Date.now(), invitedBy: state.user.email,
  });
}
async function removeFromTeam(teamId, emailKey, field) {
  await remove(ref(tenantDb, `teams/${teamId}/${field}/${emailKey}`));
}
async function inviteCoAdmin(email) {
  const emailKey = sanitizeEmailKey(email);
  await set(ref(controlDb, `platformInvites/${emailKey}`), {
    email, role: "masterAdmin", companyId: state.company.id, companyName: state.company.name,
    databaseURL: state.company.databaseURL, invitedAt: Date.now(), invitedBy: state.user.email,
  });
}

async function createProject({ name, description, teamId, assignedEmails }) {
  const id = "project_" + uid();
  const assigned = {};
  assignedEmails.forEach(e => { if (validEmail(e)) assigned[sanitizeEmailKey(e)] = true; });
  await set(ref(tenantDb, `projects/${id}`), {
    name, description: description || "", teamId,
    status: "active", createdBy: state.user.email, createdAt: Date.now(),
    assignedEmails: assigned, stages: {},
  });
  await mirrorProjectIndex(id, assigned);
  return id;
}
async function mirrorProjectIndex(projectId, assignedEmailsObj) {
  const updates = {};
  Object.keys(assignedEmailsObj).forEach(key => { updates[`userProjectIndex/${key}/${projectId}`] = true; });
  if (Object.keys(updates).length) await update(ref(tenantDb), updates);
}
async function addProjectAssignee(projectId, email) {
  if (!validEmail(email)) throw new Error("Enter a valid email address.");
  const emailKey = sanitizeEmailKey(email);
  await update(ref(tenantDb, `projects/${projectId}/assignedEmails`), { [emailKey]: true });
  await update(ref(tenantDb), { [`userProjectIndex/${emailKey}/${projectId}`]: true });
}
async function removeProjectAssignee(projectId, emailKey) {
  await remove(ref(tenantDb, `projects/${projectId}/assignedEmails/${emailKey}`));
  await remove(ref(tenantDb, `userProjectIndex/${emailKey}/${projectId}`));
}
async function archiveProject(projectId, archived) {
  await update(ref(tenantDb, `projects/${projectId}`), { status: archived ? "archived" : "active" });
}
async function deleteProject(projectId) {
  const project = state.projects[projectId];
  const updates = { [`projects/${projectId}`]: null };
  Object.keys((project && project.assignedEmails) || {}).forEach(k => { updates[`userProjectIndex/${k}/${projectId}`] = null; });
  await update(ref(tenantDb), updates);
}
async function addStage(projectId, name, dueDate) {
  const stageRef = push(ref(tenantDb, `projects/${projectId}/stages`));
  const stages = (state.projects[projectId] && state.projects[projectId].stages) || {};
  await set(stageRef, { name, dueDate: dueDate || "", completed: false, order: Object.keys(stages).length, createdAt: Date.now() });
}
async function toggleStage(projectId, stageId, completed) { await update(ref(tenantDb, `projects/${projectId}/stages/${stageId}`), { completed }); }
async function updateStageDate(projectId, stageId, dueDate) { await update(ref(tenantDb, `projects/${projectId}/stages/${stageId}`), { dueDate }); }
async function deleteStage(projectId, stageId) { await remove(ref(tenantDb, `projects/${projectId}/stages/${stageId}`)); }

// ============================================================================
// 10. RENDERING
// ============================================================================
function render() {
  const authScreen = document.getElementById("auth-screen");
  const appShell = document.getElementById("app-shell");
  if (!state.user || !state.profile) {
    authScreen.classList.remove("hidden");
    appShell.classList.add("hidden");
    renderAuthScreen();
    return;
  }
  authScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  renderHeader();
  renderSidebar();
  renderMain();
}

// ---------------------------- Auth screen ----------------------------------
function renderAuthScreen() {
  const tabsAvailable = [
    { id: "signin", label: "Sign In" },
    { id: "invite", label: "Accept Invite" },
  ];
  if (state.creatorBootstrapAvailable) tabsAvailable.push({ id: "creator-bootstrap", label: "Become Creator" });
  if (!tabsAvailable.find(t => t.id === state.authTab)) state.authTab = "signin";

  const tabsEl = document.getElementById("auth-tabs");
  tabsEl.innerHTML = tabsAvailable.map(t => `
    <button type="button" class="tab-btn flex-1 ${state.authTab === t.id ? "active" : ""}" data-action="auth-tab" data-tab="${t.id}">${t.label}</button>
  `).join("");

  const panels = document.getElementById("auth-panels");
  if (state.authTab === "signin") {
    panels.innerHTML = `
      <form data-form="signin" class="flex flex-col gap-4">
        <div>
          <label class="field-label">Work email</label>
          <input type="email" name="email" required placeholder="you@company.com" autocomplete="username">
        </div>
        <div>
          <label class="field-label">Password</label>
          <input type="password" name="password" required placeholder="••••••••" autocomplete="current-password">
        </div>
        <button type="submit" class="btn btn-primary w-full mt-1">Sign In</button>
        <button type="button" data-action="forgot-password" class="text-xs text-navy-600 hover:text-brand-blue text-center">Forgot password?</button>
      </form>`;
  } else if (state.authTab === "invite") {
    panels.innerHTML = `
      <p class="text-sm text-navy-600 mb-4">Your admin invited you by email. Enter that same email and choose a password to activate your account.</p>
      <form data-form="invite-signup" class="flex flex-col gap-4">
        <div>
          <label class="field-label">Your name</label>
          <input type="text" name="name" required placeholder="Jane Doe">
        </div>
        <div>
          <label class="field-label">Invited email</label>
          <input type="email" name="email" required placeholder="you@company.com" autocomplete="username">
        </div>
        <div>
          <label class="field-label">Create password</label>
          <input type="password" name="password" required minlength="6" placeholder="At least 6 characters" autocomplete="new-password">
        </div>
        <button type="submit" class="btn btn-primary w-full mt-1">Activate Account</button>
      </form>`;
  } else if (state.authTab === "creator-bootstrap") {
    panels.innerHTML = `
      <p class="text-sm text-navy-600 mb-4">No platform Creator exists yet. This one-time step makes you the Creator, able to register companies and assign their Master Admins. It can only be done once.</p>
      <form data-form="creator-bootstrap" class="flex flex-col gap-4">
        <div>
          <label class="field-label">Your name</label>
          <input type="text" name="name" required placeholder="Jane Doe">
        </div>
        <div>
          <label class="field-label">Your email</label>
          <input type="email" name="email" required placeholder="you@company.com" autocomplete="username">
        </div>
        <div>
          <label class="field-label">Create password</label>
          <input type="password" name="password" required minlength="6" placeholder="At least 6 characters" autocomplete="new-password">
        </div>
        <button type="submit" class="btn btn-primary w-full mt-1">Become Creator</button>
      </form>`;
  }
}

// ---------------------------- Header ----------------------------------
function renderHeader() {
  const badge = document.getElementById("company-switcher-wrap");
  if (isCreator()) {
    badge.innerHTML = `<div class="flex items-center gap-2"><span class="w-2 h-2 rounded-full brand-gradient flex-shrink-0"></span><span class="text-sm font-semibold text-navy-800 truncate">Platform Console</span></div>`;
  } else {
    badge.innerHTML = `<div class="flex items-center gap-2"><span class="w-2 h-2 rounded-full brand-gradient flex-shrink-0"></span><span class="text-sm font-semibold text-navy-800 truncate">${escapeHtml(state.company.name || "Your Company")}</span></div>`;
  }

  const menu = document.getElementById("user-menu");
  const name = state.profile.name || state.user.email;
  menu.innerHTML = `
    <div class="flex items-center gap-2 sm:gap-3">
      <span class="badge badge-role hidden sm:inline-flex">${escapeHtml(roleLabel(state.profile.role))}</span>
      <div class="hidden sm:flex flex-col items-end leading-tight">
        <span class="text-sm font-semibold text-navy-800">${escapeHtml(name)}</span>
        <span class="text-xs text-navy-600">${escapeHtml(state.user.email)}</span>
      </div>
      <div class="avatar">${escapeHtml(initials(name))}</div>
      <button data-action="sign-out" class="btn btn-ghost btn-sm !p-2" aria-label="Sign out" title="Sign out">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      </button>
    </div>`;
}

// ---------------------------- Sidebar ----------------------------------
const ICONS = {
  dashboard: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>`,
  teams: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  companies: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><line x1="9" y1="9" x2="9" y2="9.01"/><line x1="9" y1="12" x2="9" y2="12.01"/><line x1="9" y1="15" x2="9" y2="15.01"/></svg>`,
};

function renderSidebar() {
  const nav = document.getElementById("sidebar-nav");
  const items = [];
  if (isCreator()) {
    items.push({ id: "companies", label: "Companies", icon: ICONS.companies });
  } else {
    items.push({ id: "dashboard", label: "Projects", icon: ICONS.dashboard });
    items.push({ id: "teams", label: "Teams", icon: ICONS.teams });
    if (isMasterAdmin()) items.push({ id: "company", label: "Company", icon: ICONS.companies });
  }

  nav.innerHTML = items.map(i => `
    <button data-action="nav" data-view="${i.id}" class="nav-link ${state.currentView === i.id ? "active" : ""}">
      ${i.icon}<span>${i.label}</span>
    </button>`).join("");

  const teamsBlock = document.getElementById("sidebar-teams-block");
  if (!isCreator()) {
    const teams = getVisibleTeams().slice(0, 6);
    if (teams.length) {
      teamsBlock.innerHTML = `
        <p class="text-xs font-bold text-navy-600 uppercase tracking-wide px-2 mb-2">My Teams</p>
        <div class="flex flex-col gap-1">
          ${teams.map(t => `
            <button data-action="open-team" data-id="${t.id}" class="nav-link !font-medium !text-navy-600 justify-between">
              <span class="truncate">${escapeHtml(t.name)}</span>
              <span class="text-[10px] bg-navy-100 text-navy-600 px-1.5 py-0.5 rounded-full">${teamProjectCount(t.id)}</span>
            </button>`).join("")}
        </div>`;
    } else {
      teamsBlock.innerHTML = "";
    }
  } else {
    teamsBlock.innerHTML = "";
  }

  const overlay = document.getElementById("sidebar-overlay");
  const sidebar = document.getElementById("sidebar");
  sidebar.classList.toggle("open", state.sidebarOpen);
  overlay.classList.toggle("open", state.sidebarOpen);
}

// ---------------------------- Main router ----------------------------------
function renderMain() {
  const main = document.getElementById("main-content");
  if (isCreator()) { main.innerHTML = renderCreatorCompaniesView(); return; }
  if (state.currentView === "teams") main.innerHTML = renderTeamsView();
  else if (state.currentView === "company" && isMasterAdmin()) main.innerHTML = renderCompanySettingsView();
  else main.innerHTML = renderDashboard();
}

// ---------------------------- Dashboard / Projects ----------------------------------
function canCreateProject() {
  return isMasterAdmin() || Object.keys(state.teams).some(isTeamLead);
}

function renderDashboard() {
  const projects = getVisibleProjects();
  const filters = [["active", "Active"], ["archived", "Archived"], ["all", "All"]];

  return `
    <div class="flex flex-col gap-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 class="font-display text-2xl font-extrabold text-navy-800">Projects</h2>
          <p class="text-sm text-navy-600 mt-0.5">Organize. Assign. Track. Achieve.</p>
        </div>
        ${canCreateProject() ? `
        <button data-action="new-project" class="btn btn-primary shadow-soft">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Project
        </button>` : ``}
      </div>

      <div class="flex flex-col sm:flex-row gap-3 sm:items-center justify-between">
        <div class="flex bg-navy-100 rounded-lg p-1 w-fit">
          ${filters.map(([id, label]) => `
            <button data-action="filter-projects" data-filter="${id}" class="tab-btn ${state.projectFilter === id ? "active" : ""}">${label}</button>
          `).join("")}
        </div>
        <div class="relative sm:w-64">
          <input type="text" id="project-search" value="${escapeHtml(state.searchTerm)}" placeholder="Search projects…" class="!pl-9">
          <svg class="absolute left-3 top-1/2 -translate-y-1/2 text-navy-600" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </div>
      </div>

      ${projects.length ? `
        <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          ${projects.map(renderProjectCard).join("")}
        </div>` : renderEmptyState()}
    </div>`;
}

function renderEmptyState() {
  return `
    <div class="card p-10 flex flex-col items-center text-center gap-3 mt-2">
      <div class="w-14 h-14 rounded-2xl brand-gradient flex items-center justify-center">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
      </div>
      <h3 class="font-display font-bold text-lg">${state.searchTerm ? "No matching projects" : "No projects here yet"}</h3>
      <p class="text-sm text-navy-600 max-w-sm">${state.searchTerm ? "Try a different search term or clear your filters." : (canCreateProject() ? "Create your first project to define stages, set dates, and assign your team." : "Projects you're assigned to will show up here once your team lead adds you.")}</p>
      ${(!state.searchTerm && canCreateProject()) ? `<button data-action="new-project" class="btn btn-primary mt-1">Create a Project</button>` : ``}
    </div>`;
}

function renderProjectCard(project) {
  const progress = computeProgress(project);
  const overall = projectOverallStatus(project);
  const stageCount = Object.keys(project.stages || {}).length;
  const memberCount = Object.keys(project.assignedEmails || {}).length;
  const archived = project.status === "archived";

  return `
    <button data-action="open-project" data-id="${project.id}" class="project-card card p-4 text-left flex flex-col gap-3 ${archived ? "opacity-70" : ""}">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <h3 class="font-display font-bold text-navy-800 truncate">${escapeHtml(project.name)}</h3>
          <p class="text-xs text-navy-600 truncate mt-0.5">${escapeHtml(teamName(project.teamId))}</p>
        </div>
        ${archived ? `<span class="badge badge-archived flex-shrink-0">Archived</span>` : `<span class="badge ${overall.cls} flex-shrink-0">${overall.label}</span>`}
      </div>

      <div>
        <div class="flex justify-between text-xs text-navy-600 mb-1">
          <span>${stageCount} stage${stageCount === 1 ? "" : "s"}</span>
          <span class="font-semibold text-navy-800">${progress}%</span>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
      </div>

      <div class="flex items-center justify-between mt-1">
        <div class="flex items-center gap-1.5 text-xs text-navy-600">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
          ${memberCount} assigned
        </div>
      </div>
    </button>`;
}

// ---------------------------- Teams view ----------------------------------
function renderTeamsView() {
  const teams = getVisibleTeams();
  return `
    <div class="flex flex-col gap-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 class="font-display text-2xl font-extrabold text-navy-800">Teams</h2>
          <p class="text-sm text-navy-600 mt-0.5">Marketing, Engineering, Design — organize your company into teams.</p>
        </div>
        ${isMasterAdmin() ? `<button data-action="new-team" class="btn btn-primary shadow-soft">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Team
        </button>` : ``}
      </div>

      ${teams.length ? `
        <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          ${teams.map(renderTeamCard).join("")}
        </div>` : `
        <div class="card p-10 flex flex-col items-center text-center gap-3">
          <h3 class="font-display font-bold text-lg">No teams yet</h3>
          <p class="text-sm text-navy-600 max-w-sm">${isMasterAdmin() ? "Create a team to start organizing projects and inviting members." : "You haven't been added to a team yet. Ask your admin to invite you."}</p>
          ${isMasterAdmin() ? `<button data-action="new-team" class="btn btn-primary mt-1">Create a Team</button>` : ``}
        </div>`}
    </div>`;
}

function renderTeamCard(team) {
  const leadCount = Object.keys(team.leadEmails || {}).length;
  const memberCount = Object.keys(team.memberEmails || {}).length;
  return `
    <button data-action="open-team" data-id="${team.id}" class="project-card card p-4 text-left flex flex-col gap-3">
      <div class="flex items-start justify-between gap-2">
        <h3 class="font-display font-bold text-navy-800 truncate">${escapeHtml(team.name)}</h3>
        <span class="badge badge-neutral flex-shrink-0">${teamProjectCount(team.id)} projects</span>
      </div>
      <div class="flex items-center gap-3 text-xs text-navy-600 mt-1">
        <span>${leadCount} lead${leadCount === 1 ? "" : "s"}</span>
        <span class="w-1 h-1 rounded-full bg-navy-100"></span>
        <span>${memberCount} member${memberCount === 1 ? "" : "s"}</span>
      </div>
    </button>`;
}

// ---------------------------- Company Settings (tenant, Master Admin only) ----------------------------------
function renderCompanySettingsView() {
  const admins = Object.entries(state.tenantUsers || {}).filter(([, u]) => u.role === "masterAdmin");
  return `
    <div class="flex flex-col gap-6 max-w-2xl">
      <div>
        <h2 class="font-display text-2xl font-extrabold text-navy-800">Company</h2>
        <p class="text-sm text-navy-600 mt-0.5">Your company's own isolated Taskshi database.</p>
      </div>

      <div class="card p-5 flex flex-col gap-3">
        <div>
          <p class="field-label mb-1">Company name</p>
          <p class="text-sm font-semibold text-navy-800">${escapeHtml(state.company.name || "—")}</p>
        </div>
        <div>
          <p class="field-label mb-1">Database</p>
          <p class="text-xs text-navy-600 break-all">${escapeHtml(state.company.databaseURL)}</p>
        </div>
      </div>

      <div class="card p-5 flex flex-col gap-3">
        <h3 class="font-display font-bold text-sm text-navy-800">Master Admins</h3>
        <div class="flex flex-wrap gap-2">
          ${admins.length ? admins.map(([, u]) => `<span class="chip">${escapeHtml(u.name || u.email)}</span>`).join("") : `<p class="text-sm text-navy-600 italic">Just you, so far.</p>`}
        </div>
        <form data-form="invite-co-admin" class="flex gap-2 mt-1">
          <input type="email" name="email" required placeholder="newadmin@company.com" class="flex-1">
          <button type="submit" class="btn btn-secondary whitespace-nowrap">Invite Master Admin</button>
        </form>
      </div>
    </div>`;
}

// ---------------------------- Creator: Companies view ----------------------------------
function renderCreatorCompaniesView() {
  const companies = Object.entries(state.companies).map(([id, c]) => ({ id, ...c }));
  return `
    <div class="flex flex-col gap-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 class="font-display text-2xl font-extrabold text-navy-800">Companies</h2>
          <p class="text-sm text-navy-600 mt-0.5">Register a company and assign its first Master Admin. Taskshi never reads a company's own project data from here.</p>
        </div>
        <button data-action="new-company" class="btn btn-primary shadow-soft">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Company
        </button>
      </div>
      ${companies.length ? `
        <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          ${companies.map(renderCompanyCard).join("")}
        </div>` : `
        <div class="card p-10 flex flex-col items-center text-center gap-3">
          <h3 class="font-display font-bold text-lg">No companies yet</h3>
          <p class="text-sm text-navy-600 max-w-sm">Register your first company to invite its Master Admin.</p>
          <button data-action="new-company" class="btn btn-primary mt-1">Register a Company</button>
        </div>`}
    </div>`;
}
function renderCompanyCard(company) {
  return `
    <button data-action="open-company" data-id="${company.id}" class="project-card card p-4 text-left flex flex-col gap-2">
      <h3 class="font-display font-bold text-navy-800 truncate">${escapeHtml(company.name)}</h3>
      <p class="text-xs text-navy-600 break-all line-clamp-2">${escapeHtml(company.databaseURL)}</p>
      <p class="text-xs text-navy-600 mt-1">Registered ${formatDate(new Date(company.createdAt).toISOString().slice(0, 10))}</p>
    </button>`;
}

// ============================================================================
// 11. MODALS
// ============================================================================
function openModal(html) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="modal-panel">${html}</div>`;
}
function closeModal() {
  document.getElementById("modal-root").innerHTML = "";
}
document.getElementById("modal-root").addEventListener("click", (e) => {
  if (e.target.id === "modal-root") closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});
function modalHeader(title, subtitle) {
  return `
    <div class="flex items-start justify-between p-5 border-b border-navy-100">
      <div>
        <h3 class="font-display font-bold text-lg text-navy-800">${escapeHtml(title)}</h3>
        ${subtitle ? `<p class="text-xs text-navy-600 mt-0.5">${escapeHtml(subtitle)}</p>` : ""}
      </div>
      <button data-action="close-modal" class="btn btn-ghost btn-sm !p-1.5" aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
}

// ---------------------------- Creator modals ----------------------------------
function openNewCompanyModal() {
  openModal(`
    ${modalHeader("Register Company", "Provide a database you've already created for this company (see README).")}
    <form data-form="new-company" class="p-5 flex flex-col gap-4">
      <div>
        <label class="field-label">Company name</label>
        <input type="text" name="name" required placeholder="e.g. Reconense">
      </div>
      <div>
        <label class="field-label">Database URL</label>
        <input type="text" name="databaseURL" required placeholder="https://reconense-default-rtdb.region.firebasedatabase.app/">
        <p class="text-xs text-navy-600 mt-1">For a quick test you can reuse your default database URL. For real isolation, create a dedicated Realtime Database instance in the Firebase Console first.</p>
      </div>
      <div>
        <label class="field-label">Initial Master Admin email</label>
        <input type="email" name="adminEmail" required placeholder="admin@reconense.com">
      </div>
      <div class="flex gap-2 justify-end mt-2">
        <button type="button" data-action="close-modal" class="btn btn-secondary">Cancel</button>
        <button type="submit" class="btn btn-primary">Register Company</button>
      </div>
    </form>`);
}
function openCompanyModal(companyId) {
  const company = state.companies[companyId];
  if (!company) return;
  openModal(`
    ${modalHeader(company.name, "Registered " + formatDate(new Date(company.createdAt).toISOString().slice(0, 10)))}
    <div class="p-5 flex flex-col gap-6">
      <div>
        <p class="field-label mb-1">Database</p>
        <p class="text-xs text-navy-600 break-all">${escapeHtml(company.databaseURL)}</p>
      </div>
      <form data-form="invite-master-admin" data-company-id="${companyId}" class="flex flex-col gap-2">
        <label class="field-label">Invite another Master Admin</label>
        <div class="flex gap-2">
          <input type="email" name="email" required placeholder="newadmin@company.com" class="flex-1">
          <button type="submit" class="btn btn-secondary whitespace-nowrap">Invite</button>
        </div>
      </form>
    </div>
    <div class="p-5 border-t border-navy-100 flex flex-wrap gap-2 justify-end">
      <button data-action="delete-company" data-id="${companyId}" class="btn btn-danger">Delete Company</button>
      <button data-action="close-modal" class="btn btn-primary">Done</button>
    </div>`);
}

// ---------------------------- New Project modal ----------------------------------
function openNewProjectModal() {
  const teamOptions = Object.entries(state.teams).filter(([id]) => isMasterAdmin() || isTeamLead(id));
  if (!teamOptions.length) { toast("You need to lead a team before creating a project.", "error"); return; }
  openModal(`
    ${modalHeader("New Project", "Set up stages and assign teammates after creating it.")}
    <form data-form="new-project" class="p-5 flex flex-col gap-4">
      <div>
        <label class="field-label">Project name</label>
        <input type="text" name="name" required placeholder="e.g. Website Redesign">
      </div>
      <div>
        <label class="field-label">Description</label>
        <textarea name="description" rows="2" placeholder="What is this project about?"></textarea>
      </div>
      <div>
        <label class="field-label">Team</label>
        <select name="teamId" required>
          ${teamOptions.map(([id, t]) => `<option value="${id}">${escapeHtml(t.name)}</option>`).join("")}
        </select>
      </div>
      <div>
        <label class="field-label">Assign members by email (optional — you can add more later)</label>
        <input type="text" name="assignees" placeholder="jane@company.com, sam@company.com">
      </div>
      <div class="flex gap-2 justify-end mt-2">
        <button type="button" data-action="close-modal" class="btn btn-secondary">Cancel</button>
        <button type="submit" class="btn btn-primary">Create Project</button>
      </div>
    </form>`);
}

// ---------------------------- Project detail modal ----------------------------------
function openProjectModal(projectId) {
  const project = state.projects[projectId];
  if (!project) { toast("Project not found.", "error"); return; }
  const manage = canManageProject(project);
  const canCheck = canToggleStage(project);
  const stages = Object.entries(project.stages || {})
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const progress = computeProgress(project);
  const assignees = Object.keys(project.assignedEmails || {});

  openModal(`
    ${modalHeader(project.name, teamName(project.teamId))}
    <div class="p-5 flex flex-col gap-6 max-h-[70vh] overflow-y-auto">

      ${project.status === "archived" ? `<span class="badge badge-archived w-fit">Archived project</span>` : ""}

      ${project.description ? `<p class="text-sm text-navy-600">${escapeHtml(project.description)}</p>` : ""}

      <div>
        <div class="flex justify-between text-xs text-navy-600 mb-1">
          <span>Overall progress</span><span class="font-semibold text-navy-800">${progress}%</span>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
      </div>

      <div>
        <div class="flex items-center justify-between mb-2">
          <h4 class="font-display font-bold text-sm text-navy-800">Stages</h4>
        </div>
        <div class="flex flex-col gap-2" id="stage-list">
          ${stages.length ? stages.map(s => renderStageRow(project.id, s, manage, canCheck)).join("") : `<p class="text-sm text-navy-600 italic">No stages yet.</p>`}
        </div>
        ${manage ? `
          <form data-form="add-stage" data-project-id="${project.id}" class="flex flex-col sm:flex-row gap-2 mt-3">
            <input type="text" name="stageName" required placeholder="Stage name (e.g. QA)" class="flex-1">
            <input type="date" name="stageDate" class="sm:w-40">
            <button type="submit" class="btn btn-secondary whitespace-nowrap">+ Add Stage</button>
          </form>` : ""}
      </div>

      <div>
        <h4 class="font-display font-bold text-sm text-navy-800 mb-2">Assigned Members</h4>
        <div class="flex flex-wrap gap-2 mb-2" id="assignee-chips">
          ${assignees.length ? assignees.map(k => renderAssigneeChip(project.id, k, manage)).join("") : `<p class="text-sm text-navy-600 italic">No one assigned yet.</p>`}
        </div>
        ${manage ? `
          <form data-form="add-assignee" data-project-id="${project.id}" class="flex gap-2">
            <input type="email" name="email" required placeholder="teammate@company.com" class="flex-1">
            <button type="submit" class="btn btn-secondary whitespace-nowrap">Invite</button>
          </form>` : ""}
      </div>
    </div>

    ${manage ? `
    <div class="p-5 border-t border-navy-100 flex flex-wrap gap-2 justify-end">
      <button data-action="delete-project" data-id="${project.id}" class="btn btn-danger">Delete</button>
      <button data-action="toggle-archive" data-id="${project.id}" data-archived="${project.status === "archived"}" class="btn btn-secondary">
        ${project.status === "archived" ? "Restore" : "Archive"}
      </button>
      <button data-action="close-modal" class="btn btn-primary">Done</button>
    </div>` : `
    <div class="p-5 border-t border-navy-100 flex justify-end">
      <button data-action="close-modal" class="btn btn-primary">Close</button>
    </div>`}
  `);
}

function renderStageRow(projectId, stage, manage, canCheck) {
  const status = getStageStatus(stage);
  return `
    <div class="stage-row ${stage.completed ? "completed" : ""} flex items-center gap-3 border border-navy-100 rounded-lg px-3 py-2.5">
      <input type="checkbox" ${stage.completed ? "checked" : ""} ${canCheck ? "" : "disabled"}
        data-action="toggle-stage" data-project-id="${projectId}" data-stage-id="${stage.id}"
        class="w-4 h-4 accent-[#2563EB] flex-shrink-0">
      <div class="flex-1 min-w-0">
        <p class="stage-name text-sm font-semibold text-navy-800 truncate">${escapeHtml(stage.name)}</p>
        <p class="text-xs text-navy-600">${formatDate(stage.dueDate)}</p>
      </div>
      <span class="badge ${status.cls} flex-shrink-0">${status.label}</span>
      ${manage ? `
        <button data-action="edit-stage-date" data-project-id="${projectId}" data-stage-id="${stage.id}" data-current="${stage.dueDate || ""}" class="btn btn-ghost btn-sm !p-1.5" title="Change date" aria-label="Change date">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        </button>
        <button data-action="delete-stage" data-project-id="${projectId}" data-stage-id="${stage.id}" class="btn btn-ghost btn-sm !p-1.5" title="Delete stage" aria-label="Delete stage">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>` : ""}
    </div>`;
}
function renderAssigneeChip(projectId, emailKey, manage) {
  const display = emailKey.replace(/,/g, ".");
  return `
    <span class="chip">
      ${escapeHtml(display)}
      ${manage ? `<button data-action="remove-assignee" data-project-id="${projectId}" data-email-key="${emailKey}" aria-label="Remove">✕</button>` : ""}
    </span>`;
}

// ---------------------------- New Team modal ----------------------------------
function openNewTeamModal() {
  openModal(`
    ${modalHeader("New Team", "Teams organize members and projects within your company.")}
    <form data-form="new-team" class="p-5 flex flex-col gap-4">
      <div>
        <label class="field-label">Team name</label>
        <input type="text" name="name" required placeholder="e.g. Engineering">
      </div>
      <p class="text-xs text-navy-600">You'll be added as the initial Team Lead.</p>
      <div class="flex gap-2 justify-end mt-2">
        <button type="button" data-action="close-modal" class="btn btn-secondary">Cancel</button>
        <button type="submit" class="btn btn-primary">Create Team</button>
      </div>
    </form>`);
}

// ---------------------------- Team detail modal ----------------------------------
function openTeamModal(teamId) {
  const team = state.teams[teamId];
  if (!team) { toast("Team not found.", "error"); return; }
  const manage = isMasterAdmin() || isTeamLead(teamId);
  const leads = Object.keys(team.leadEmails || {});
  const members = Object.keys(team.memberEmails || {});
  const projectCount = teamProjectCount(teamId);

  openModal(`
    ${modalHeader(team.name, `${projectCount} active project${projectCount === 1 ? "" : "s"}`)}
    <div class="p-5 flex flex-col gap-6 max-h-[70vh] overflow-y-auto">
      <div>
        <h4 class="font-display font-bold text-sm text-navy-800 mb-2">Team Leads</h4>
        <div class="flex flex-wrap gap-2">
          ${leads.length ? leads.map(k => `
            <span class="chip">${escapeHtml(k.replace(/,/g, "."))}
              ${manage && leads.length > 1 ? `<button data-action="remove-team-member" data-team-id="${teamId}" data-email-key="${k}" data-field="leadEmails" aria-label="Remove">✕</button>` : ""}
            </span>`).join("") : `<p class="text-sm text-navy-600 italic">No leads yet.</p>`}
        </div>
      </div>

      <div>
        <h4 class="font-display font-bold text-sm text-navy-800 mb-2">Team Members</h4>
        <div class="flex flex-wrap gap-2">
          ${members.length ? members.map(k => `
            <span class="chip">${escapeHtml(k.replace(/,/g, "."))}
              ${manage ? `<button data-action="remove-team-member" data-team-id="${teamId}" data-email-key="${k}" data-field="memberEmails" aria-label="Remove">✕</button>` : ""}
            </span>`).join("") : `<p class="text-sm text-navy-600 italic">No members yet.</p>`}
        </div>
      </div>

      ${manage ? `
      <form data-form="invite-team" data-team-id="${teamId}" class="flex flex-col sm:flex-row gap-2">
        <input type="email" name="email" required placeholder="teammate@company.com" class="flex-1">
        <select name="role" class="sm:w-40">
          <option value="teamMember">Team Member</option>
          <option value="teamLead">Team Lead</option>
        </select>
        <button type="submit" class="btn btn-secondary whitespace-nowrap">Invite</button>
      </form>` : ""}
    </div>
    <div class="p-5 border-t border-navy-100 flex justify-end">
      <button data-action="close-modal" class="btn btn-primary">Done</button>
    </div>`);
}

// ---------------------------- Small prompt modal (edit date) ----------------------------------
function openDatePromptModal(projectId, stageId, current) {
  openModal(`
    ${modalHeader("Update Due Date")}
    <form data-form="update-stage-date" data-project-id="${projectId}" data-stage-id="${stageId}" class="p-5 flex flex-col gap-4">
      <div>
        <label class="field-label">New due date</label>
        <input type="date" name="dueDate" value="${current || ""}">
      </div>
      <div class="flex gap-2 justify-end mt-2">
        <button type="button" data-action="close-modal" class="btn btn-secondary">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>`);
}

// ============================================================================
// 12. EVENT HANDLING (delegated)
// ============================================================================
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;

  try {
    switch (action) {
      case "auth-tab":
        state.authTab = el.dataset.tab; renderAuthScreen(); break;

      case "forgot-password": {
        const email = document.querySelector('#auth-panels input[name="email"]')?.value;
        if (!email || !validEmail(email)) { toast("Enter your email above first.", "error"); return; }
        await sendPasswordResetEmail(auth, email);
        toast("Password reset email sent.", "success");
        break;
      }

      case "sign-out":
        await signOut(auth); closeModal(); toast("Signed out."); break;

      case "nav":
        state.currentView = el.dataset.view; state.sidebarOpen = false; render(); break;

      case "filter-projects":
        state.projectFilter = el.dataset.filter; renderMain(); break;

      case "new-project": openNewProjectModal(); break;
      case "new-team": openNewTeamModal(); break;
      case "new-company": openNewCompanyModal(); break;
      case "open-project": openProjectModal(el.dataset.id); break;
      case "open-team": openTeamModal(el.dataset.id); break;
      case "open-company": openCompanyModal(el.dataset.id); break;
      case "close-modal": closeModal(); break;

      case "toggle-stage":
        await toggleStage(el.dataset.projectId, el.dataset.stageId, el.checked);
        break;

      case "edit-stage-date":
        openDatePromptModal(el.dataset.projectId, el.dataset.stageId, el.dataset.current);
        break;

      case "delete-stage":
        if (confirm("Delete this stage? This cannot be undone.")) {
          await deleteStage(el.dataset.projectId, el.dataset.stageId);
          toast("Stage deleted.");
          openProjectModal(el.dataset.projectId);
        }
        break;

      case "remove-assignee":
        await removeProjectAssignee(el.dataset.projectId, el.dataset.emailKey);
        toast("Member removed from project.");
        openProjectModal(el.dataset.projectId);
        break;

      case "remove-team-member":
        await removeFromTeam(el.dataset.teamId, el.dataset.emailKey, el.dataset.field);
        toast("Member removed from team.");
        openTeamModal(el.dataset.teamId);
        break;

      case "toggle-archive": {
        const archived = el.dataset.archived === "true";
        await archiveProject(el.dataset.id, !archived);
        toast(archived ? "Project restored." : "Project archived.");
        closeModal();
        break;
      }

      case "delete-company":
        if (confirm("Remove this company from your registry? This only unlists it here — it does NOT delete the company's own database, teams, projects, or its Master Admin's ability to keep using it at the same URL. This cannot be undone from within Taskshi.")) {
          await deleteCompany(el.dataset.id);
          toast("Company removed from registry.");
          closeModal();
        }
        break;

      case "delete-project":
        if (confirm("Permanently delete this project and all its stages? This cannot be undone.")) {
          await deleteProject(el.dataset.id);
          toast("Project deleted.");
          closeModal();
        }
        break;
    }
  } catch (err) {
    console.error(err);
    toast(err.message || "Something went wrong.", "error");
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "project-search") {
    state.searchTerm = e.target.value;
    renderMain();
    const input = document.getElementById("project-search");
    if (input) { input.focus(); input.selectionStart = input.selectionEnd = input.value.length; }
  }
});

document.getElementById("hamburger-btn").addEventListener("click", () => {
  state.sidebarOpen = !state.sidebarOpen; renderSidebar();
});
document.getElementById("sidebar-overlay").addEventListener("click", () => {
  state.sidebarOpen = false; renderSidebar();
});

// ---------------------------- Forms ----------------------------------
document.addEventListener("submit", async (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const type = form.dataset.form;
  const fd = new FormData(form);
  const btn = form.querySelector('button[type="submit"]');

  try {
    setBusy(btn, true, "Please wait…");

    if (type === "signin") {
      await handleSignIn(fd.get("email").trim(), fd.get("password"));
    }

    else if (type === "invite-signup") {
      await acceptInvite({ email: fd.get("email").trim(), password: fd.get("password"), name: fd.get("name").trim() });
    }

    else if (type === "creator-bootstrap") {
      await becomeCreator({ name: fd.get("name").trim(), email: fd.get("email").trim(), password: fd.get("password") });
    }

    else if (type === "new-company") {
      const databaseURL = fd.get("databaseURL").trim();
      if (!validDbUrl(databaseURL)) throw new Error("Enter a valid https:// database URL.");
      await registerCompany({ name: fd.get("name").trim(), databaseURL, adminEmail: fd.get("adminEmail").trim() });
      toast("Company registered — invite sent to the Master Admin."); closeModal(); render();
    }

    else if (type === "invite-master-admin") {
      const company = state.companies[form.dataset.companyId];
      await inviteAdditionalMasterAdmin(form.dataset.companyId, company.name, company.databaseURL, fd.get("email").trim());
      toast("Master Admin invited."); form.reset();
    }

    else if (type === "invite-co-admin") {
      await inviteCoAdmin(fd.get("email").trim());
      toast("Master Admin invited."); form.reset();
    }

    else if (type === "new-project") {
      const assignees = (fd.get("assignees") || "").split(",").map(s => s.trim()).filter(Boolean);
      const invalid = assignees.filter(a => !validEmail(a));
      if (invalid.length) throw new Error(`Invalid email(s): ${invalid.join(", ")}`);
      await createProject({
        name: fd.get("name").trim(), description: fd.get("description").trim(),
        teamId: fd.get("teamId"), assignedEmails: assignees,
      });
      toast("Project created."); closeModal(); state.currentView = "dashboard"; render();
    }

    else if (type === "add-stage") {
      await addStage(form.dataset.projectId, fd.get("stageName").trim(), fd.get("stageDate") || "");
      form.reset(); openProjectModal(form.dataset.projectId);
    }

    else if (type === "add-assignee") {
      await addProjectAssignee(form.dataset.projectId, fd.get("email").trim());
      toast("Member invited to project."); openProjectModal(form.dataset.projectId);
    }

    else if (type === "update-stage-date") {
      await updateStageDate(form.dataset.projectId, form.dataset.stageId, fd.get("dueDate") || "");
      toast("Due date updated."); openProjectModal(form.dataset.projectId);
    }

    else if (type === "new-team") {
      const id = await createTeam(fd.get("name").trim());
      toast("Team created."); closeModal(); state.currentView = "teams"; render();
      openTeamModal(id);
    }

    else if (type === "invite-team") {
      await inviteToTeam(form.dataset.teamId, fd.get("email").trim(), fd.get("role"));
      toast("Invite sent."); form.reset(); openTeamModal(form.dataset.teamId);
    }

  } catch (err) {
    console.error(err);
    toast(err.message || "Something went wrong.", "error");
  } finally {
    setBusy(btn, false);
  }
});

// ============================================================================
// 13. BOOT
// ============================================================================
onAuthStateChanged(auth, async (firebaseUser) => {
  if (state.authInProgress) return; // a signup flow is manually provisioning right now
  if (firebaseUser) {
    try {
      const activated = await resolveAndActivateSession(firebaseUser);
      if (!activated) {
        toast("Your account has no access assigned yet. Contact your admin.", "error");
        await signOut(auth);
        render();
      }
    } catch (err) {
      console.error(err);
      toast("Could not load your session — signed out. Please sign in again.", "error");
      stopAllListeners();
      state.user = null;
      state.profile = null;
      state.company = null;
      tenantDb = null;
      try { await signOut(auth); } catch (e) { /* already signed out */ }
      render();
    }
  } else {
    stopAllListeners();
    state.user = null;
    state.profile = null;
    state.company = null;
    tenantDb = null;
    render();
  }
});

(async function boot() {
  await checkCreatorBootstrap();
  render();
  window.__taskshiBooted = true;
})();
