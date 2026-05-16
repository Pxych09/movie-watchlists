window.APP_CONFIG = {
  API_URL: "https://script.google.com/macros/s/AKfycbzPER-flrF1jIbkicpGHELNLmWbqob2q6_ACSHV3eRMR_fgBlml2TsKne8xPcQTxnPPbg/exec"
};

const $ = (id) => document.getElementById(id);
const API_URL = window.APP_CONFIG.API_URL;
const STORAGE_KEY = "movieFeedUser";

// ─────────────────────────────────────────
// Chart.js instance registry
// Destroy old chart before re-creating on the same canvas.
// ─────────────────────────────────────────
const _charts = {};
function destroyChart(id) {
  if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
}
function createChart(id, config) {
  destroyChart(id);
  const canvas = $(id);
  if (!canvas) return null;
  const chart = new Chart(canvas, config);
  _charts[id] = chart;
  return chart;
}

// ─────────────────────────────────────────
// Dashboard chart colour palette
// ─────────────────────────────────────────
const DB_COLORS = [
  "#7F77DD", "#1D9E75", "#BA7517",
  "#378ADD", "#D85A30", "#639922",
  "#D4537E", "#E24B4A", "#888780"
];

const RATING_COLORS = ["#E24B4A", "#D85A30", "#BA7517", "#1D9E75", "#7F77DD"];

const state = {
  currentUser: null,
  feed: [],
  feedFilter: "all",      // "all" | "mine"
  subGenreSortAZ: false,
  subGenreSortDir: "asc",   // "asc" | "desc"
  subGenreDrafts: [],
  feedSort: "newest",     // "newest" | "oldest" | "rating" | "comments"
  feedPage: 0,            // current infinite-scroll page (0-based)
  feedPageSize: 10,       // posts per page
  todos: [],
  todoDrafts: [],
  selectedTodoId: "",
  dashboard: {
    genres: [],
    topRated: [],
    watchedByMonth: [],
    userTotals: []
  },
  dashboardHidden: true,
  dashboardScope: "all",        // "all" | "mine" | "other"
  dashboardOtherUser: "",       // username string when scope === "other"
  guidelinesHidden: false,
  isEditing: false,
  alertTimers: new Map(),
  loadingCount: 0,
  notifications: [],
  notifOpen: false,
  subGenres: [],
  // FIX 2: track selected sub-genres in state instead of reading from DOM
  selectedSubGenres: new Set(),
  todoRouletteTimer: null,
  todoRouletteSpinning: false,
  todoRouletteValue: "",
  todoRouletteTrackOffset: 0,
  todoRouletteTrackIndex: 0,
  // Track which tab is active in the monthly chart
  dashboardMonthTab: "count",
  notifShowUnreadOnly: false,
};

document.addEventListener("DOMContentLoaded", bootstrap);

async function bootstrap() {
  bindEvents();
  await restoreSession();
}

function bindEvents() {
  const bind = (id, eventName, handler) => {
    const el = $(id);
    if (!el) { console.warn(`Missing element: #${id}`); return; }
    el.addEventListener(eventName, handler);
  };

  bind("loginForm",      "submit",  handleLogin);
  bind("logoutBtn",      "click",   handleLogout);
  bind("postForm",       "submit",  handleSavePost);
  bind("cancelEditBtn",  "click",   resetPostForm);
  bind("feedSearch",     "input",   handleFeedSearch);
  bind("notifBtn",       "click",   toggleNotifications);
  bind("toggleDashboardBtn", "click", toggleDashboard);
  bind("toggleSidebarBtn",   "click", toggleSidebar);
  bind("togglePostBtn",      "click", togglePost);
  bind("addTodoBtn",     "click",   handleAddTodoDraft);
  bind("saveTodoBtn",    "click",   handleSaveTodoDrafts);
  bind("todoInput",      "keydown", handleTodoInputKeydown);

  bind("addSubGenreBtn",    "click",   handleAddSubGenreDraft);
  bind("saveSubGenreBtn",   "click",   handleSaveSubGenreDrafts);
  bind("subGenreInput",     "keydown", handleSubGenreInputKeydown);
  bind("subGenreSearch",    "input",   handleSubGenreSearch);

  bind("subGenreFilterInput",  "input",  () => renderSubGenreCheckboxes());
  bind("subGenreShowSelected", "change", () => renderSubGenreCheckboxes());

  // FIX 2: use event delegation on the subGenreGroup container so clicks
  // survive re-renders and always update state.selectedSubGenres
  const subGenreGroup = $("subGenreGroup");
  if (subGenreGroup) {
    subGenreGroup.addEventListener("change", (e) => {
      const cb = e.target.closest('input[name="subGenre"]');
      if (!cb) return;
      if (cb.checked) {
        state.selectedSubGenres.add(cb.value);
      } else {
        state.selectedSubGenres.delete(cb.value);
      }
      // If "show selected only" is active, re-render so deselected items disappear
      if ($("subGenreShowSelected")?.checked) {
        renderSubGenreCheckboxes();
      }
    });
  }

  const sortBtn = $("subGenreSortBtn");
  if (sortBtn) {
    sortBtn.addEventListener("click", () => {
      if (!state.subGenreSortAZ) {
        state.subGenreSortAZ  = true;
        state.subGenreSortDir = "asc";
      } else if (state.subGenreSortDir === "asc") {
        state.subGenreSortDir = "desc";
      } else {
        state.subGenreSortAZ  = false;
        state.subGenreSortDir = "asc";
      }
      updateSubGenreSortBtn(sortBtn);
      renderSubGenreCheckboxes();
    });
  }
    
  bind("savedTodoSearch","input",   handleSavedTodoSearch);
  bind("spinTodoBtn",    "click",   handleSpinTodoRoulette);
  
  // Dashboard scope tabs
  document.getElementById("dbScopeTabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".db-scope-tab");
    if (!btn) return;
    document.querySelectorAll(".db-scope-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.dashboardScope = btn.dataset.scope;

    const picker = $("dbOtherPicker");
    if (state.dashboardScope === "other") {
      populateOtherUserPicker();
      picker?.classList.remove("d-none");
      return;
    }

    picker?.classList.add("d-none");
    state.dashboardOtherUser = "";
    renderDashboard();
  });

  // "Other" user select
  document.getElementById("dbOtherSelect")?.addEventListener("change", (e) => {
    state.dashboardOtherUser = e.target.value;
    if (state.dashboardOtherUser) renderDashboard();
  });

  // Feed retry button
  bind("feedRetryBtn", "click", () => refreshFeed());

  bind("feedSort", "change", handleFeedSort);

  // Feed filter tabs (event delegation)
  document.getElementById("feedFilterTabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".feed-tab");
    if (!btn) return;
    document.querySelectorAll(".feed-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.feedFilter = btn.dataset.filter;
    state.feedPage   = 0;
    
    $("feedError")?.classList.add("d-none");
    applyFeedFilter();
  });

  // Scroll to top
  const scrollBtn = $("scrollTopBtn");
  if (scrollBtn) {
    window.addEventListener("scroll", () => {
      scrollBtn.classList.toggle("visible", window.scrollY > 300);
    }, { passive: true });

    scrollBtn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "instant" });
    });
  }

  document.addEventListener("click", (event) => {
    const wrap = document.querySelector(".notif-wrap");
    if (!wrap) return;
    if (!wrap.contains(event.target)) closeNotifications();
  });

  // Mobile nav menu
  const mobileNavBtn      = $("mobileNavBtn");
  const mobileNavDropdown = $("mobileNavDropdown");
  const mobileLogoutBtn   = $("mobileLogoutBtn");

  if (mobileNavBtn && mobileNavDropdown) {
    mobileNavBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = mobileNavDropdown.classList.toggle("open");
      mobileNavBtn.setAttribute("aria-expanded", String(isOpen));
      mobileNavBtn.querySelector("i").className = isOpen
        ? "bi bi-x"
        : "bi bi-list";
    });

    document.addEventListener("click", (e) => {
      if (!mobileNavDropdown.contains(e.target) && e.target !== mobileNavBtn) {
        mobileNavDropdown.classList.remove("open");
        mobileNavBtn.setAttribute("aria-expanded", "false");
        mobileNavBtn.querySelector("i").className = "bi bi-list";
      }
    });
  }
  
  bind("toggleGuidelinesBtn", "click", toggleGuidelines);
  const guidelinesNavBtn = $("guidelinesNavBtn");
  guidelinesNavBtn?.addEventListener("click", () => {
    if (state.guidelinesHidden) {
      state.guidelinesHidden = false;
      applyGuidelinesVisibility(true);
    }
    const card = $("guidelinesCard");
    if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  mobileLogoutBtn?.addEventListener("click", handleLogout);
  bindPostToggle();
  bindToolsToggle();
  bindDashboardToggle();
  bindGuidelinesToggle();
}

// ─────────────────────────────────────────
// POST PANEL TOGGLE
// ─────────────────────────────────────────
const POST_STORAGE_KEY = "postPanelVisible";

function bindPostToggle() {
  const toggle = $("postToggle");
  if (!toggle) return;

  const saved     = localStorage.getItem(POST_STORAGE_KEY);
  const isVisible = saved === null ? false : saved === "true";
  applyPostState(isVisible, false);

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const current = toggle.getAttribute("aria-checked") === "true";
    applyPostState(!current, true);
  });
}

function applyPostState(visible, save) {
  const toggle     = $("postToggle");
  const content    = $("postContent");
  const btn        = $("togglePostBtn");
  const headerCard = $("postHeaderCard");

  if (toggle)     toggle.setAttribute("aria-checked", String(visible));
  if (content)    content.classList.toggle("d-none", !visible);
  if (headerCard) headerCard.classList.toggle("d-none", !visible);
  if (btn)        btn.innerHTML = visible ? `<i class="bi bi-eye"></i>` : `<i class="bi bi-eye-slash"></i>`;

  if (save) localStorage.setItem(POST_STORAGE_KEY, String(visible));
}

// ─────────────────────────────────────────
// TOOLS PANEL TOGGLE
// ─────────────────────────────────────────
const TOOLS_STORAGE_KEY = "toolsPanelVisible";

function bindToolsToggle() {
  const toggle = $("toolsToggle");
  if (!toggle) return;

  // FIX 1: read from localStorage but will be overridden to false on login
  const saved     = localStorage.getItem(TOOLS_STORAGE_KEY);
  const isVisible = saved === null ? false : saved === "true";
  applyToolsState(isVisible, false);

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const current = toggle.getAttribute("aria-checked") === "true";
    applyToolsState(!current, true);
  });
}

// FIX 1: extracted so login can call it directly
function applyToolsState(visible, save) {
  const toggle     = $("toolsToggle");
  const content    = $("sidebarContent");
  const btn        = $("toggleSidebarBtn");
  const headerCard = $("toolsHeaderCard");

  if (toggle)     toggle.setAttribute("aria-checked", String(visible));
  if (content)    content.classList.toggle("d-none", !visible);
  if (headerCard) headerCard.classList.toggle("d-none", !visible);
  if (btn)        btn.innerHTML = visible ? `<i class="bi bi-eye"></i>` : `<i class="bi bi-eye-slash"></i>`;

  if (save) localStorage.setItem(TOOLS_STORAGE_KEY, String(visible));
}

// ─────────────────────────────────────────
// DASHBOARD PANEL TOGGLE
// ─────────────────────────────────────────
const DASHBOARD_STORAGE_KEY = "dashboardPanelVisible";

function bindDashboardToggle() {
  const toggle = $("dashboardToggle");
  if (!toggle) return;

  const saved     = localStorage.getItem(DASHBOARD_STORAGE_KEY);
  const isVisible = saved === null ? true : saved === "true";
  applyDashboardToggleState(isVisible, false);

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const current = toggle.getAttribute("aria-checked") === "true";
    applyDashboardToggleState(!current, true);
  });
}

// FIX 1: extracted so login can call it directly
function applyDashboardToggleState(visible, save) {
  const toggle = $("dashboardToggle");
  if (toggle) toggle.setAttribute("aria-checked", String(visible));
  state.dashboardHidden = !visible;
  const dashboardCard = $("dashboardCard");
  if (dashboardCard) dashboardCard.classList.toggle("d-none", !visible);
  applyDashboardVisibility();
  if (save) localStorage.setItem(DASHBOARD_STORAGE_KEY, String(visible));
}

// ─────────────────────────────────────────
// GUIDELINES PANEL TOGGLE
// ─────────────────────────────────────────
const GUIDELINES_STORAGE_KEY = "guidelinesPanelVisible";

function bindGuidelinesToggle() {
  const toggle = $("guidelinesToggle");
  if (!toggle) return;

  const saved     = localStorage.getItem(GUIDELINES_STORAGE_KEY);
  const isVisible = saved === null ? true : saved === "true";
  applyGuidelinesToggleState(isVisible, false);

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const current = toggle.getAttribute("aria-checked") === "true";
    applyGuidelinesToggleState(!current, true);
  });
}

// FIX 1: extracted so login can call it directly
function applyGuidelinesToggleState(visible, save) {
  const toggle = $("guidelinesToggle");
  if (toggle) toggle.setAttribute("aria-checked", String(visible));
  state.guidelinesHidden = !visible;
  const guidelinesCard = $("guidelinesCard");
  if (guidelinesCard) guidelinesCard.classList.toggle("d-none", !visible);
  applyGuidelinesVisibility(visible);
  if (save) localStorage.setItem(GUIDELINES_STORAGE_KEY, String(visible));
}

function toggleGuidelines() {
  state.guidelinesHidden = !state.guidelinesHidden;
  const visible = !state.guidelinesHidden;
  localStorage.setItem(GUIDELINES_STORAGE_KEY, String(visible));
  const toggle = $("guidelinesToggle");
  if (toggle) toggle.setAttribute("aria-checked", String(visible));
  const guidelinesCard = $("guidelinesCard");
  if (guidelinesCard) guidelinesCard.classList.toggle("d-none", !visible);
  applyGuidelinesVisibility(visible);
}

function applyGuidelinesVisibility(visible) {
  const content = $("guidelinesContent");
  const btn     = $("toggleGuidelinesBtn");
  if (!content || !btn) return;
  content.classList.toggle("d-none", !visible);
  btn.innerHTML = visible ? `<i class="bi bi-eye"></i>` : `<i class="bi bi-eye-slash"></i>`;
}

// ─────────────────────────────────────────
// FIX 1: reset all panel toggles to OFF for a fresh session
// ─────────────────────────────────────────
function resetPanelTogglesToDefault() {
  localStorage.removeItem(POST_STORAGE_KEY);
  localStorage.removeItem(TOOLS_STORAGE_KEY);
  localStorage.removeItem(DASHBOARD_STORAGE_KEY);
  localStorage.removeItem(GUIDELINES_STORAGE_KEY);

  applyPostState(false, false);
  applyToolsState(false, false);
  applyDashboardToggleState(false, false);
  applyGuidelinesToggleState(false, false);
}

// ─────────────────────────────────────────
// API
// ─────────────────────────────────────────
async function api(method, ...args) {
  if (!API_URL || API_URL.includes("PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE")) {
    throw new Error("Set your Apps Script Web App URL in app.js first.");
  }

  const body = new URLSearchParams({ method, args: JSON.stringify(args) });
  const response = await fetch(API_URL, { method: "POST", body });
  const text = await response.text();

  if (!response.ok) throw new Error(`Request failed: ${response.status}`);

  let result;
  try { result = JSON.parse(text); }
  catch (error) {
    console.error("Non-JSON response:", text);
    throw new Error("Backend did not return valid JSON.");
  }

  if (!result.ok) throw new Error(result.error || "Something went wrong.");
  return result.data;
}

// ─────────────────────────────────────────
// LOADING HELPERS
// ─────────────────────────────────────────
function withOverlay(fn) {
  return async (...args) => {
    try {
      showOverlay(true);
      return await fn(...args);
    } finally {
      showOverlay(false);
    }
  };
}

function showOverlay(show) {
  const overlay = $("loadingOverlay");
  if (!overlay) return;
  state.loadingCount += show ? 1 : -1;
  state.loadingCount = Math.max(0, state.loadingCount);
  overlay.classList.toggle("d-none", state.loadingCount === 0);
}

function withLoading(fn) {
  return async (...args) => {
    try {
      showOverlay(true);
      return await fn(...args);
    } finally {
      showOverlay(false);
    }
  };
}

// ─────────────────────────────────────────
// SKELETON HELPERS
// ─────────────────────────────────────────
function showFeedSkeleton(count = 3) {
  const feedList = $("feedList");
  if (!feedList) return;

  feedList.innerHTML = Array.from({ length: count }).map(() => `
    <div class="skel-post-card">
      <div class="skel-post-header">
        <div class="skel skel-avatar"></div>
        <div class="skel-post-meta">
          <div class="skel skel-line skel-w-40"></div>
          <div class="skel skel-line-sm skel-w-55"></div>
        </div>
      </div>
      <div class="skel skel-line-lg skel-post-title"></div>
      <div class="skel-pills">
        <div class="skel skel-pill" style="width:80px"></div>
        <div class="skel skel-pill" style="width:60px"></div>
        <div class="skel skel-pill" style="width:70px"></div>
        <div class="skel skel-pill" style="width:110px"></div>
      </div>
      <div class="skel skel-caption skel-w-90"></div>
      <div class="skel skel-caption skel-w-75"></div>
      <div class="skel skel-caption skel-w-65"></div>
      <div class="skel-divider"></div>
      <div class="skel-comment-row">
        <div class="skel skel-comment-avatar"></div>
        <div class="skel-comment-body">
          <div class="skel skel-line skel-w-40"></div>
          <div class="skel skel-line-sm skel-w-65"></div>
        </div>
      </div>
      <div class="skel-comment-row">
        <div class="skel skel-comment-avatar"></div>
        <div class="skel-comment-body">
          <div class="skel skel-line skel-w-55"></div>
          <div class="skel skel-line-sm skel-w-80"></div>
        </div>
      </div>
    </div>
  `).join("");

  $("emptyFeed")?.classList.add("d-none");
  if ($("feedCountBadge")) $("feedCountBadge").textContent = "loading…";
}

function showDashboardSkeleton() {
  const content = $("dashboardContent");
  if (!content || state.dashboardHidden) return;

  const cardSkel = (rows, useBars = false) => `
    <div class="skel-dashboard-card">
      <div class="skel skel-dashboard-title"></div>
      <div class="skel-bar-row">
        ${Array.from({ length: rows }).map(() =>
          useBars
            ? `<div class="skel-bar-item">
                <div class="skel-bar-label">
                  <div class="skel skel-line" style="width:55%;height:11px"></div>
                  <div class="skel skel-line" style="width:25%;height:11px"></div>
                </div>
                <div class="skel skel-bar-track"></div>
               </div>`
            : `<div class="skel skel-list-item"></div>`
        ).join("")}
      </div>
    </div>
  `;

  content.innerHTML = `
    <div class="skel-dashboard-grid">
      ${cardSkel(4, true)}
      ${cardSkel(4)}
      ${cardSkel(3)}
      ${cardSkel(3)}
    </div>
  `;
}

function showSidebarSkeleton(containerId, count = 3, type = "todo") {
  const el = $(containerId);
  if (!el) return;

  if (type === "subgenre") {
    el.innerHTML = `
      <div class="skel-subgenre-pills">
        ${Array.from({ length: count }).map((_, i) => {
          const w = [60, 80, 72, 90, 65][i % 5];
          return `<div class="skel skel-subgenre-pill" style="width:${w}px"></div>`;
        }).join("")}
      </div>
    `;
  } else {
    el.innerHTML = Array.from({ length: count })
      .map(() => `<div class="skel skel-todo-item"></div>`)
      .join("");
  }
}

// ─────────────────────────────────────────
// SECTIONS
// ─────────────────────────────────────────
function showSection(isLoggedIn) {
  $("loginSection")?.classList.toggle("d-none",  isLoggedIn);
  $("appSection")?.classList.toggle("d-none", !isLoggedIn);
}

// ── TOAST SYSTEM ──────────────────────────────────────────────────────────────
(function () {
  const DURATION = 6000;
  const MAX      = 5;
  const TYPES = {
    success: { icon: "bi-check-circle-fill", label: "Success" },
    danger:  { icon: "bi-x-circle-fill",     label: "Error"   },
    warning: { icon: "bi-exclamation-circle-fill", label: "Warning" },
    info:    { icon: "bi-info-circle-fill",   label: "Info"   },
  };

  function getStack() {
    let el = document.getElementById("toastStack");
    if (!el) {
      el = document.createElement("div");
      el.id        = "toastStack";
      el.className = "toast-stack";
      el.setAttribute("aria-live", "polite");
      el.setAttribute("aria-atomic", "false");
      document.body.appendChild(el);
    }
    return el;
  }

  function removeToast(id) {
    const el = document.getElementById(id);
    if (!el) return;
    clearTimeout(el._autoTimer);
    el.classList.remove("toast-in");
    el.classList.add("toast-out");
    setTimeout(() => el.remove(), 300);
  }

  window.showAlert = function (message, type = "danger", duration = DURATION) {
    const stack = getStack();
    const existing = stack.querySelectorAll(".toast-item");
    if (existing.length >= MAX) removeToast(existing[existing.length - 1].id);

    const cfg = TYPES[type] || TYPES.info;
    const id  = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const el  = document.createElement("div");
    el.id        = id;
    el.className = `toast-item toast-${type}`;
    el.setAttribute("role", "alert");
    el.innerHTML = `
      <div class="toast-icon"><i class="bi ${cfg.icon}"></i></div>
      <div class="toast-body">
        <div class="toast-title">${cfg.label}</div>
        <div class="toast-msg">${escapeHtml(message)}</div>
      </div>
      <button class="toast-close" aria-label="Dismiss"><i class="bi bi-x"></i></button>
      <div class="toast-progress" style="animation-duration:${duration}ms"></div>
    `;

    el.querySelector(".toast-close").addEventListener("click", () => removeToast(id));
    el.addEventListener("mouseenter", () => {
      clearTimeout(el._autoTimer);
      el.querySelector(".toast-progress").style.animationPlayState = "paused";
    });
    el.addEventListener("mouseleave", () => {
      el.querySelector(".toast-progress").style.animationPlayState = "running";
      el._autoTimer = setTimeout(() => removeToast(id), 2000);
    });

    stack.prepend(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("toast-in")));
    el._autoTimer = setTimeout(() => removeToast(id), duration);
  };

  window.removeAlert = function (id) { removeToast(id); };

  window.hideAlerts = function () {
    const stack = document.getElementById("toastStack");
    if (!stack) return;
    stack.querySelectorAll(".toast-item").forEach(el => {
      clearTimeout(el._autoTimer);
      el.remove();
    });
  };
})();

// ─────────────────────────────────────────
// SESSION
// ─────────────────────────────────────────
function saveSession(user)  { localStorage.setItem(STORAGE_KEY, JSON.stringify(user)); }
function clearSession()     { localStorage.removeItem(STORAGE_KEY); }
function getSessionToken()  { return state.currentUser?.sessionToken || ""; }

// ─────────────────────────────────────────
// LOGIN / LOGOUT
// ─────────────────────────────────────────
async function handleLogin(event) {
  event.preventDefault();
  hideAlerts();

  const username  = $("loginUsername")?.value.trim() || "";
  const password  = $("loginPassword")?.value.trim() || "";
  const submitBtn = event.submitter;

  try {
    toggleButton(submitBtn, true);
    const user = await withOverlay(() => api("login", username, password))();
    state.currentUser = user;
    saveSession(user);
    setProfile(user);

    // FIX 1: always start with all panels OFF on a fresh login
    resetPanelTogglesToDefault();

    showSection(true);
    await refreshFeed();
    showAlert(`Welcome back, ${user.name || user.username}!`, "success");
  } catch (error) {
    showAlert(error.message, "danger");
  } finally {
    toggleButton(submitBtn, false);
  }
}

async function handleLogout() {
  try {
    if (getSessionToken()) {
      await withOverlay(() => api("logout", getSessionToken()))();
    }
  } catch (error) {
    console.warn("Logout request failed:", error);
  }

  // Destroy all Chart.js instances to free memory
  ["dbRatingChart", "dbMonthChart", "dbTrendChart"].forEach(destroyChart);

  state.currentUser    = null;
  state.feed           = [];
  state.dashboard      = { topRated: [], watchedByMonth: [], userTotals: [] };
  state.dashboardHidden = false;
  state.isEditing      = false;
  state.notifications  = [];
  state.notifOpen      = false;
  state.todos          = [];
  state.todoDrafts     = [];
  state.selectedTodoId = "";
  state.subGenres      = [];
  // FIX 2: clear selected sub-genres on logout
  state.selectedSubGenres = new Set();
  state.dashboardMonthTab = "count";
  state.notifShowUnreadOnly = false;
  state.feedFilter = "all";
  state.feedSort   = "newest";
  state.feedPage   = 0;
  state.dashboardScope = "all";
  document.querySelectorAll(".db-scope-tab").forEach((b, i) => b.classList.toggle("active", i === 0));
  state.dashboardOtherUser = "";
  $("dbOtherPicker")?.classList.add("d-none");
  const otherSel = $("dbOtherSelect");
  if (otherSel) otherSel.innerHTML = `<option value="">— pick a user —</option>`;
  // Reset toolbar UI
  document.querySelectorAll(".feed-tab").forEach((b, i) => b.classList.toggle("active", i === 0));
  const sortEl = $("feedSort");
  if (sortEl) sortEl.value = "newest";

  clearSession();
  $("loginForm")?.reset();
  resetPostForm();
  setProfile(null);

  if (state.todoRouletteTimer) { clearTimeout(state.todoRouletteTimer); state.todoRouletteTimer = null; }
  state.todoRouletteSpinning   = false;
  state.todoRouletteValue      = "";
  state.todoRouletteTrackOffset = 0;
  state.todoRouletteTrackIndex  = 0;

  if ($("feedList"))       $("feedList").innerHTML = "";
  if ($("feedCountBadge")) $("feedCountBadge").textContent = "0 posts";
  $("emptyFeed")?.classList.add("d-none");

  if ($("subGenrePreviewList")) $("subGenrePreviewList").innerHTML = `<div class="text-secondary-light small">No sub-genres yet.</div>`;
  if ($("subGenreCount"))       $("subGenreCount").textContent = "0 items";
  
  if ($("subGenreInput"))        $("subGenreInput").value = "";
  if ($("subGenreFilterInput"))  $("subGenreFilterInput").value = "";
  if ($("subGenreShowSelected")) $("subGenreShowSelected").checked = false;
  state.subGenreSortAZ  = false;
  state.subGenreSortDir = "asc";
  state.subGenreDrafts  = [];
  const subSortBtn = $("subGenreSortBtn");
  if (subSortBtn) updateSubGenreSortBtn(subSortBtn);
  if ($("subGenreDraftList"))  $("subGenreDraftList").innerHTML = `<div class="text-secondary small">No draft items yet.</div>`;
  if ($("subGenreDraftCount")) $("subGenreDraftCount").textContent = "0 drafts";

  if ($("topRatedList"))     $("topRatedList").innerHTML = "";
  if ($("watchedStatsList")) $("watchedStatsList").innerHTML = "";
  if ($("userTotalsList"))   $("userTotalsList").innerHTML = "";
  if ($("dashboardContent")) $("dashboardContent").classList.remove("d-none");
  if ($("toggleDashboardBtn")) $("toggleDashboardBtn").innerHTML = `<i class="bi bi-eye"></i>`;

  // Reset Post panel
  applyPostState(false, false);

  if ($("sidebarContent")) $("sidebarContent").classList.add("d-none");
  if ($("toggleSidebarBtn")) $("toggleSidebarBtn").textContent = "Show Tools";
  if ($("genreStatsList"))   $("genreStatsList").innerHTML = "";
  if ($("savedTodoList"))    $("savedTodoList").innerHTML = `<div class="text-secondary-light small">No saved watchlists yet.</div>`;
  if ($("draftTodoList"))    $("draftTodoList").innerHTML = `<div class="text-secondary-light small">|&nbsp;No draft items yet.</div>`;
  if ($("savedTodoCount"))   $("savedTodoCount").textContent = "0 items";
  if ($("draftTodoCount"))   $("draftTodoCount").textContent = "0 draft";
  if ($("todoInput"))        $("todoInput").value = "";
  if ($("savedTodoSearch"))  $("savedTodoSearch").value = "";

  // Reset metric cards
  ["dbMetricPosts", "dbMetricHours", "dbMetricAvgRating", "dbMetricUsers"].forEach((id) => {
    if ($(id)) $(id).textContent = "—";
  });
  if ($("dbStreakList"))     $("dbStreakList").innerHTML = `<div class="text-secondary-light small">No streak data yet.</div>`;
  if ($("dbSubGenreCloud"))  $("dbSubGenreCloud").innerHTML = `<div class="text-secondary-light small">No sub-genre data yet.</div>`;
  if ($("ratingLegend"))     $("ratingLegend").innerHTML = "";

  if ($("todoSlotTrack")) {
    $("todoSlotTrack").innerHTML = `<div class="todo-slot-item is-empty">No candidates yet.</div>`;
    $("todoSlotTrack").style.transform = `translateX(0px)`;
  }
  if ($("todoRouletteResult"))     $("todoRouletteResult").classList.add("d-none");
  if ($("todoRouletteResultText")) $("todoRouletteResultText").textContent = "";

  $("notifDropdown")?.classList.remove("open");
  if ($("notifList")) $("notifList").innerHTML = `<div class="p-3 text-secondary-light small">No notifications yet.</div>`;
  $("notifBadge")?.classList.add("d-none");

  if ($("subGenreSearch")) $("subGenreSearch").value = "";
  state.guidelinesHidden = false;
  if ($("guidelinesContent")) $("guidelinesContent").classList.remove("d-none");
  if ($("toggleGuidelinesBtn")) $("toggleGuidelinesBtn").innerHTML = `<i class="bi bi-eye"></i>`;
  const guidelinesCard = $("guidelinesCard");
  if (guidelinesCard) guidelinesCard.classList.remove("d-none");

  hideAlerts();
  showSection(false);
}

// ─────────────────────────────────────────
// SESSION RESTORE
// ─────────────────────────────────────────
async function restoreSession() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) { showSection(false); return; }

  try {
    state.currentUser = JSON.parse(saved);
    setProfile(state.currentUser);

    // FIX 1: also reset toggles on session restore (e.g. after a session expiry
    // that left the user auto-logged-out and now logging back in)
    resetPanelTogglesToDefault();

    showSection(true);
    await refreshFeed();
  } catch (error) {
    console.warn("Failed to restore session:", error);
    clearSession();
    state.currentUser = null;
    showSection(false);
  }
}

function setProfile(user) {
  const displayName    = $("displayName");
  const profileAvatar  = $("profileAvatar");
  const fallbackAvatar = $("fallbackAvatar");

  if (displayName) displayName.textContent = user?.name || user?.username || "User";
  if (!profileAvatar || !fallbackAvatar) return;

  if (user?.avatar) {
    profileAvatar.src = user.avatar;
    profileAvatar.classList.remove("d-none");
    fallbackAvatar.classList.add("d-none");
  } else {
    profileAvatar.removeAttribute("src");
    profileAvatar.classList.add("d-none");
    fallbackAvatar.classList.remove("d-none");
  }
}

// ─────────────────────────────────────────
// REFRESH FEED
// ─────────────────────────────────────────
async function refreshFeed() {
  if (!state.currentUser) return;

  $("feedError")?.classList.add("d-none");

  showFeedSkeleton(3);
  showDashboardSkeleton();
  showSidebarSkeleton("savedTodoList",      3, "todo");
  showSidebarSkeleton("subGenrePreviewList", 6, "subgenre");

  try {
    const [feed, notifications, dashboard, todos, subGenres] = await Promise.all([
      api("getFeed",           getSessionToken()),
      api("getNotifications",  getSessionToken()),
      api("getDashboardData",  getSessionToken()),
      api("getTodos",          getSessionToken()),
      api("getSubGenres",      getSessionToken()),
    ]);

    state.feed          = Array.isArray(feed)          ? feed          : [];
    state.notifications = Array.isArray(notifications) ? notifications : [];
    state.todos         = Array.isArray(todos)         ? todos         : [];
    state.subGenres     = Array.isArray(subGenres)     ? subGenres     : [];
    state.dashboard     = dashboard || { genres: [], topRated: [], watchedByMonth: [], userTotals: [] };

    $("feedError")?.classList.add("d-none");

    renderSavedTodos();
    renderDraftTodos();
    renderSubGenrePreview();
    renderSubGenreCheckboxes();
    renderDashboard();
    applyFeedFilter();
    renderNotifications();
  } catch (error) {
    showFeedError(error.message);
    showAlert(error.message, "danger");
    if (/Session expired/i.test(error.message)) await handleLogout();
  }
}

async function silentRefresh() {
  if (!state.currentUser) return;
  try {
    const [feed, dashboard] = await Promise.all([
      api("getFeed",          getSessionToken()),
      api("getDashboardData", getSessionToken()),
    ]);
    state.feed      = Array.isArray(feed) ? feed : [];
    state.dashboard = dashboard || state.dashboard;
    renderDashboard();
    applyFeedFilter();
  } catch (_) {
    // silent
  }
}

function showFeedError(message) {
  const feedList = $("feedList");
  if (feedList) feedList.innerHTML = "";
  $("emptyFeed")?.classList.add("d-none");
  if ($("feedCountBadge")) $("feedCountBadge").textContent = "0 posts";

  const card = $("feedError");
  if (!card) return;
  card.classList.remove("d-none");

  const sub = card.querySelector(".feed-error-sub");
  if (sub && message) {
    sub.textContent = message.length > 120 ? message.slice(0, 117) + "…" : message;
  }
}

// ─────────────────────────────────────────
// SEARCH HANDLERS
// ─────────────────────────────────────────
function handleSavedTodoSearch() { renderSavedTodos(); }
function handleSubGenreSearch()  { renderSubGenrePreview(); }

// ─────────────────────────────────────────
// ROULETTE
// ─────────────────────────────────────────
function getTodoRouletteCandidates() {
  return (state.todos || []).map((t) => (t.movieName || "").trim()).filter(Boolean);
}

function buildTodoSlotItems(candidates, repeatCount = 12) {
  if (!candidates.length) return [`No candidates yet.`];
  const items = [];
  for (let i = 0; i < repeatCount; i++) items.push(...candidates);
  return items;
}

function renderTodoSlotMachine() {
  const track = $("todoSlotTrack");
  if (!track) return;

  const candidates = getTodoRouletteCandidates();

  if (!candidates.length) {
    track.innerHTML = `<div class="todo-slot-item is-empty">No candidates yet.</div>`;
    track.style.transform = `translateX(0px)`;
    renderTodoRouletteResult("");
    return;
  }

  const repeated = buildTodoSlotItems(candidates, 12);
  track.innerHTML = repeated.map((title) => `
    <div class="todo-slot-item">${escapeHtml(title)}</div>
  `).join("");
  track.style.transform = `translateX(-${state.todoRouletteTrackOffset}px)`;
}

function renderTodoRouletteResult(text) {
  const resultWrap = $("todoRouletteResult");
  const resultText = $("todoRouletteResultText");
  if (!resultWrap || !resultText) return;

  if (!text) { resultWrap.classList.add("d-none"); resultText.textContent = ""; return; }
  resultText.textContent = text;
  resultWrap.classList.remove("d-none");
}

function resetTodoSlotMachine() {
  state.todoRouletteTrackOffset = 0;
  state.todoRouletteTrackIndex  = 0;
  state.todoRouletteValue       = "";
  renderTodoSlotMachine();
  renderTodoRouletteResult("");
}

function handleSpinTodoRoulette() {
  const candidates = getTodoRouletteCandidates();
  const spinBtn    = $("spinTodoBtn");
  const track      = $("todoSlotTrack");

  if (!candidates.length) {
    showAlert("No saved watchlists available to spin.", "danger");
    resetTodoSlotMachine();
    return;
  }

  if (state.todoRouletteSpinning || !track) return;

  state.todoRouletteSpinning = true;
  renderTodoRouletteResult("");
  toggleButton(spinBtn, true);

  const itemWidth   = 220;
  const totalSteps  = 30 + Math.floor(Math.random() * 12);
  const chosenIndex = Math.floor(Math.random() * candidates.length);

  let step = 0, delay = 45;

  const spinStep = () => {
    state.todoRouletteTrackIndex  += 1;
    state.todoRouletteTrackOffset  = state.todoRouletteTrackIndex * itemWidth;
    track.style.transform = `translateX(-${state.todoRouletteTrackOffset}px)`;
    step++;

    if (step < totalSteps) {
      if (step > totalSteps * 0.55) delay += 12;
      state.todoRouletteTimer = setTimeout(spinStep, delay);
      return;
    }

    const remainder   = state.todoRouletteTrackIndex % candidates.length;
    const extraOffset = (chosenIndex - remainder + candidates.length) % candidates.length;
    state.todoRouletteTrackIndex  += extraOffset;
    state.todoRouletteTrackOffset  = state.todoRouletteTrackIndex * itemWidth;
    track.style.transform = `translateX(-${state.todoRouletteTrackOffset}px)`;

    state.todoRouletteValue    = candidates[chosenIndex];
    state.todoRouletteSpinning = false;
    state.todoRouletteTimer    = null;
    toggleButton(spinBtn, false);
    renderTodoRouletteResult(state.todoRouletteValue);
  };

  spinStep();
}

// ─────────────────────────────────────────
// FEED SEARCH HANDLER
// ─────────────────────────────────────────
function handleFeedSearch() {
  state.feedPage = 0;
  applyFeedFilter();
}

function handleFeedSort() {
  state.feedSort = $("feedSort")?.value || "newest";
  state.feedPage = 0;
  applyFeedFilter();
}

// ─────────────────────────────────────────
// FEED FILTER + SORT + PAGINATE
// ─────────────────────────────────────────
function applyFeedFilter() {
  const query = ($("feedSearch")?.value || "").trim().toLowerCase();

  let result = query
    ? state.feed.filter((post) => {
        const haystack = [
          post.movieName, post.genre,
          ...(post.subGenres || []),
          post.caption, post.username, post.name, post.duration,
          ...(post.comments || []).map((c) => `${c.name} ${c.username} ${c.comment}`)
        ].join(" ").toLowerCase();
        return haystack.includes(query);
      })
    : [...state.feed];

  if (state.feedFilter === "mine" && state.currentUser) {
    result = result.filter((p) => p.username === state.currentUser.username);
  }

  result = sortFeed(result, state.feedSort);
  renderFeedPaginated(result);
}

function sortFeed(feed, mode) {
  const arr = [...feed];
  switch (mode) {
    case "oldest":
      return arr.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    case "rating":
      return arr.sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0));
    case "comments":
      return arr.sort((a, b) => (b.comments?.length || 0) - (a.comments?.length || 0));
    case "newest":
    default:
      return arr.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
}

// ─────────────────────────────────────────
// TO-DO DRAFTS
// ─────────────────────────────────────────
function handleTodoInputKeydown(event) {
  if (event.key === "Enter") { event.preventDefault(); handleAddTodoDraft(); }
}

function handleAddTodoDraft() {
  const input = $("todoInput");
  const value = input?.value.trim() || "";
  if (!value) return;
  state.todoDrafts.push(value);
  input.value = "";
  renderDraftTodos();
}

async function handleSaveTodoDrafts() {
  if (!state.todoDrafts.length) { showAlert("Add at least one to-do item first.", "danger"); return; }

  try {
    await withLoading(() => api("saveTodos", getSessionToken(), state.todoDrafts))();
    state.todoDrafts = [];
    renderDraftTodos();
    await refreshFeed();
    showAlert("To-do watchlists saved successfully.", "success");
  } catch (error) {
    showAlert(error.message, "danger");
  }
}

function renderDraftTodos() {
  const list  = $("draftTodoList");
  const count = $("draftTodoCount");
  if (!list || !count) return;

  count.textContent = `${state.todoDrafts.length} draft${state.todoDrafts.length !== 1 ? "s" : ""}`;

  if (!state.todoDrafts.length) {
    list.innerHTML = `<div class="text-secondary small">|&nbsp;No draft items yet.</div>`;
    return;
  }

  list.innerHTML = "";
  state.todoDrafts.forEach((movieName, index) => {
    const item = document.createElement("div");
    item.className = "todo-item";
    item.innerHTML = `
      <div class="todo-item-left">
        <div>
          <div class="todo-item-title">${escapeHtml(movieName)}</div>
          <div class="todo-item-meta">Draft item</div>
        </div>
      </div>
      <button type="button" class="todo-remove-btn align-self-center" data-draft-index="${index}">
        <i class="bi bi-x-circle"></i>
      </button>
    `;
    item.querySelector(".todo-remove-btn")?.addEventListener("click", () => {
      state.todoDrafts.splice(index, 1);
      renderDraftTodos();
    });
    list.appendChild(item);
  });
}

// ─────────────────────────────────────────
// SAVED TO-DOS
// ─────────────────────────────────────────
function renderSavedTodos() {
  const list  = $("savedTodoList");
  const count = $("savedTodoCount");
  const query = ($("savedTodoSearch")?.value || "").trim().toLowerCase();
  if (!list || !count) return;

  const allTodos      = Array.isArray(state.todos) ? state.todos : [];
  const filteredTodos = query
    ? allTodos.filter((t) => [t.movieName, t.createdBy, t.createdAt].join(" ").toLowerCase().includes(query))
    : allTodos;

  count.textContent = `${filteredTodos.length} item${filteredTodos.length !== 1 ? "s" : ""}`;

  if (!allTodos.length) {
    list.innerHTML = `<div class="text-secondary-light small">No saved watchlists yet.</div>`;
    return;
  }

  if (!filteredTodos.length) {
    list.innerHTML = `<div class="text-secondary-light small">No matching saved watchlists found.</div>`;
    return;
  }

  list.innerHTML = "";
  filteredTodos.forEach((todo) => {
    const checked = state.selectedTodoId === todo.todoId;
    const item    = document.createElement("div");
    item.className = `todo-item ${checked ? "todo-linked" : ""}`;
    item.innerHTML = `
      <div class="todo-item-left">
        <input class="align-self-center form-check-input todo-item-check" type="checkbox" ${checked ? "checked" : ""}>
        <div class="ms-2">
          <div class="todo-item-title">${escapeHtml(todo.movieName)}</div>
          <div class="todo-item-meta">
            added by: ${escapeHtml(todo.createdBy || "-")}
            ${todo.createdAt ? `<span class="todo-item-ts">&nbsp;·&nbsp;${formatDate(todo.createdAt)}</span>` : ""}
          </div>
        </div>
      </div>
    `;
    item.querySelector(".todo-item-check")?.addEventListener("change", (e) => {
      handleSavedTodoToggle(todo, e.target.checked);
    });
    list.appendChild(item);
  });

  const candidates = getTodoRouletteCandidates();
  if (!candidates.length) {
    resetTodoSlotMachine();
  } else if (!state.todoRouletteSpinning) {
    if (state.todoRouletteValue && !candidates.includes(state.todoRouletteValue)) {
      state.todoRouletteValue = "";
      renderTodoRouletteResult("");
    }
    renderTodoSlotMachine();
  }
}

function handleSavedTodoToggle(todo, checked) {
  if (checked) {
    state.selectedTodoId = todo.todoId;
    $("movieName").value = todo.movieName || "";

    const formCard = $("postForm")?.closest(".glass-card");
    if (formCard) {
      // Open the Post panel if it's hidden
      const postContent = $("postContent");
      if (postContent?.classList.contains("d-none")) {
        applyPostState(true, true);
      }

      setTimeout(() => {
        formCard.scrollIntoView({ behavior: "smooth", block: "start" });
        formCard.classList.add("todo-linked-flash");
        setTimeout(() => formCard.classList.remove("todo-linked-flash"), 1200);
      }, 60);
    }
  } else if (state.selectedTodoId === todo.todoId) {
    state.selectedTodoId = "";
    $("movieName").value = "";
  }
  renderSavedTodos();
}

// ─────────────────────────────────────────
// DASHBOARD — CLIENT-SIDE COMPUTATIONS
// ─────────────────────────────────────────
function parseDurationToMinutes(str) {
  if (!str) return 0;
  const s = String(str);
  const h = s.match(/(\d+)\s*h/i);
  const m = s.match(/(\d+)\s*m/i);
  if (!h && !m) {
    const num = parseFloat(s);
    return isNaN(num) ? 0 : Math.round(num);
  }
  return (h ? parseInt(h[1], 10) * 60 : 0) + (m ? parseInt(m[1], 10) : 0);
}

function groupFeedByMonth(feed) {
  const byMonth = {};
  feed.forEach((post) => {
    const iso = normalizeDateWatched(post.dateWatched);
    const key = iso.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(key)) return;
    if (!byMonth[key]) byMonth[key] = [];
    byMonth[key].push(post);
  });
  return byMonth;
}

function computeStreakData(feed) {
  const byUser = {};
  feed.forEach((post) => {
    if (!post.username) return;
    if (!byUser[post.username]) byUser[post.username] = { name: post.name || post.username, dates: [] };
    const d = post.dateWatched ? new Date(post.dateWatched) : null;
    if (d && !isNaN(d.getTime())) byUser[post.username].dates.push(d);
  });

  return Object.entries(byUser).map(([username, { name, dates }]) => {
    dates.sort((a, b) => a - b);

    let maxStreak = dates.length > 0 ? 1 : 0;
    let currentStreak = 1;
    let maxGapDays = 0;

    for (let i = 1; i < dates.length; i++) {
      const diffDays = Math.round((dates[i] - dates[i - 1]) / 86_400_000);
      maxGapDays = Math.max(maxGapDays, diffDays);
      if (diffDays <= 8) {
        currentStreak++;
        maxStreak = Math.max(maxStreak, currentStreak);
      } else {
        currentStreak = 1;
      }
    }

    return {
      username,
      name,
      streak: maxStreak,
      gapWeeks: Math.round(maxGapDays / 7),
    };
  }).sort((a, b) => b.streak - a.streak);
}

function computeMonthlyAvgRating(feed) {
  const byMonth = groupFeedByMonth(feed);
  return Object.keys(byMonth).sort().map((month) => {
    const posts = byMonth[month];
    const avg = posts.reduce((s, p) => s + Number(p.rating || 0), 0) / posts.length;
    return { month, avg: parseFloat(avg.toFixed(2)) };
  });
}

function computeSubGenreCounts(feed) {
  const counts = {};
  feed.forEach((post) => {
    (post.subGenres || []).forEach((sg) => {
      const key = (sg || "").trim();
      if (key) counts[key] = (counts[key] || 0) + 1;
    });
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

// ─────────────────────────────────────────
// DASHBOARD — RENDER (scope-aware)
// ─────────────────────────────────────────
function renderDashboard() {
  if (!$("genreStatsList")) return;

  const dashboard      = state.dashboard || {};
  const allFeed        = Array.isArray(state.feed) ? state.feed : [];
  const isMyScope    = state.dashboardScope === "mine";
  const isOtherScope = state.dashboardScope === "other";
  const currentUser  = state.currentUser;

  const feed = isMyScope && currentUser
    ? allFeed.filter(p => p.username === currentUser.username)
    : isOtherScope && state.dashboardOtherUser
      ? allFeed.filter(p => p.username === state.dashboardOtherUser)
      : allFeed;

  if (isOtherScope && !state.dashboardOtherUser) {
    ["dbMetricPosts","dbMetricHours","dbMetricAvgRating","dbMetricUsers"]
      .forEach(id => { if ($(id)) $(id).textContent = "—"; });
    $("genreStatsList").innerHTML  = `<div class="text-secondary-light small">Select a user above.</div>`;
    $("userTotalsList").innerHTML  = `<div class="text-secondary-light small">Select a user above.</div>`;
    $("topRatedList").innerHTML    = `<div class="text-secondary-light small">Select a user above.</div>`;
    $("watchedStatsList").innerHTML = `<div class="text-secondary-light small">Select a user above.</div>`;
    $("dbStreakList").innerHTML    = `<div class="text-secondary-light small">Select a user above.</div>`;
    $("dbSubGenreCloud").innerHTML = `<div class="text-secondary-light small">Select a user above.</div>`;
    destroyChart("dbRatingChart");
    destroyChart("dbMonthChart");
    destroyChart("dbTrendChart");
    applyDashboardVisibility();
    return;
  }

  const genres = Array.isArray(dashboard.genres) ? dashboard.genres : [];
  const topRated = Array.isArray(dashboard.topRated) ? dashboard.topRated : [];
  const watchedByMonth = Array.isArray(dashboard.watchedByMonth) ? dashboard.watchedByMonth : [];
  const userTotals = Array.isArray(dashboard.userTotals) ? dashboard.userTotals : [];

  let displayGenres = genres;
  let displayWatchedByMonth = watchedByMonth;
  let displayTopRated = topRated;
  let displayUserTotals = userTotals;

  if ((isMyScope && currentUser) || (isOtherScope && state.dashboardOtherUser)) {
    const scopedUsername = isMyScope ? currentUser.username : state.dashboardOtherUser;
    const scopedName     = isMyScope
      ? (currentUser.name || currentUser.username)
      : (state.feed.find(p => p.username === scopedUsername)?.name || scopedUsername);

    const genreMap = {};
    feed.forEach(p => {
      if (p.genre) { genreMap[p.genre] = (genreMap[p.genre] || 0) + 1; }
    });
    displayGenres = Object.entries(genreMap)
      .map(([genre, total]) => ({ genre, total }))
      .sort((a, b) => b.total - a.total);

    const monthMap = {};
    feed.forEach(p => {
      const iso = normalizeDateWatched(p.dateWatched);
      const key = iso.slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(key)) return;
      if (!monthMap[key]) monthMap[key] = { month: key, total: 0, movies: [] };
      monthMap[key].total++;
      monthMap[key].movies.push({
        postId: p.postId, username: p.username, name: p.name,
        movieName: p.movieName, genre: p.genre, rating: p.rating,
        dateWatched: p.dateWatched
      });
    });
    displayWatchedByMonth = Object.keys(monthMap).sort()
      .map(k => { monthMap[k].movies.sort((a,b) => a.movieName.localeCompare(b.movieName)); return monthMap[k]; });

    const rMap = { 5:[], 4:[], 3:[], 2:[], 1:[] };
    feed.forEach(p => { if (rMap[p.rating]) rMap[p.rating].push(p); });
    displayTopRated = [5,4,3,2,1].map(stars => ({
      stars,
      total: rMap[stars].length,
      movies: rMap[stars].slice().sort((a,b) => a.movieName.localeCompare(b.movieName))
    }));

    displayUserTotals = feed.length
      ? [{ username: scopedUsername, name: scopedName, totalPosts: feed.length }]
      : [];
  }

  const totalPosts  = feed.length;
  const totalMins   = feed.reduce((s, p) => s + parseDurationToMinutes(p.duration), 0);
  const totalHrs    = Math.round(totalMins / 60);
  const avgRating   = totalPosts
    ? (feed.reduce((s, p) => s + Number(p.rating || 0), 0) / totalPosts).toFixed(1)
    : "—";
  const activeUsers = isMyScope ? 1 : new Set(feed.map(p => p.username).filter(Boolean)).size;

  if ($("dbMetricPosts"))     $("dbMetricPosts").textContent     = totalPosts;
  if ($("dbMetricHours"))     $("dbMetricHours").textContent     = totalHrs + "h";
  if ($("dbMetricAvgRating")) $("dbMetricAvgRating").textContent = avgRating !== "—" ? avgRating + " ★" : "—";
  if ($("dbMetricUsers"))     $("dbMetricUsers").textContent     = activeUsers;

  const usersLabel = document.querySelector("#dbMetricUsers + .db-metric-sub") ||
    $("dbMetricUsers")?.closest(".db-metric-card")?.querySelector(".db-metric-sub");
  
  if (usersLabel) {
    if (isMyScope)         usersLabel.textContent = "just you";
    else if (isOtherScope) usersLabel.textContent = "this user";
    else                   usersLabel.textContent = "with posts";
  }

  $("genreStatsList").innerHTML = renderGenreStats(displayGenres);

  renderRatingDonut(feed);
  renderMonthlyChart(feed);

  $("userTotalsList").innerHTML = displayUserTotals.length
    ? displayUserTotals.map(item => `
        <div class="dashboard-list-item">
          <div class="dashboard-item-title">${escapeHtml(item.name)}</div>
          <div class="dashboard-pill">${item.totalPosts} posts</div>
        </div>
      `).join("")
    : `<div class="text-secondary-light small">No user post data yet.</div>`;

  renderStreaks(feed);

  $("topRatedList").innerHTML = renderTopRatedByStars(displayTopRated);

  renderRatingTrend(feed);

  $("watchedStatsList").innerHTML = renderWatchedStatsByYear(displayWatchedByMonth);

  renderSubGenreCloud(feed);

  applyDashboardVisibility();
}

function populateOtherUserPicker() {
  const select = $("dbOtherSelect");
  if (!select) return;

  const others = [...new Map(
    state.feed
      .filter(p => p.username !== state.currentUser?.username)
      .map(p => [p.username, { username: p.username, name: p.name || p.username }])
  ).values()].sort((a, b) => a.name.localeCompare(b.name));

  select.innerHTML = `<option value="">— pick a user —</option>` +
    others.map(u => `<option value="${escapeHtml(u.username)}">${escapeHtml(u.name)}</option>`).join("");

  if (state.dashboardOtherUser) {
    const still = others.find(u => u.username === state.dashboardOtherUser);
    if (still) select.value = state.dashboardOtherUser;
    else       state.dashboardOtherUser = "";
  }
}

function renderRatingDonut(feed) {
  const counts = [0, 0, 0, 0, 0];
  feed.forEach((p) => {
    const r = Number(p.rating || 0);
    if (r >= 1 && r <= 5) counts[r - 1]++;
  });

  const legendEl = $("ratingLegend");
  if (legendEl) {
    const labels = ["1★", "2★", "3★", "4★", "5★"];
    legendEl.innerHTML = labels.map((l, i) => `
      <div class="db-legend-item">
        <div class="db-legend-sq" style="background:${RATING_COLORS[i]}"></div>
        ${escapeHtml(l)} (${counts[i]})
      </div>
    `).join("");
  }

  createChart("dbRatingChart", {
    type: "doughnut",
    data: {
      labels: ["1 Star", "2 Stars", "3 Stars", "4 Stars", "5 Stars"],
      datasets: [{
        data: counts,
        backgroundColor: RATING_COLORS,
        borderWidth: 2,
        borderColor: "rgba(30,30,30,0.6)",
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "60%",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.parsed} post${ctx.parsed !== 1 ? "s" : ""}`,
          },
        },
      },
    },
  });
}

function renderMonthlyChart(feed) {
  const byMonth  = groupFeedByMonth(feed);
  const months   = Object.keys(byMonth).sort();
  const labels   = months.map((m) => {
    const [y, mo] = m.split("-").map(Number);
    return new Date(y, mo - 1, 1).toLocaleDateString("en-PH", { month: "short", year: "2-digit" });
  });
  const countData      = months.map((m) => byMonth[m].length);
  const avgRatingData  = months.map((m) => {
    const posts = byMonth[m];
    return parseFloat((posts.reduce((s, p) => s + Number(p.rating || 0), 0) / posts.length).toFixed(2));
  });

  const isRating = state.dashboardMonthTab === "rating";

  createChart("dbMonthChart", {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: isRating ? "Avg rating" : "Movies watched",
        data: isRating ? avgRatingData : countData,
        backgroundColor: isRating ? "#BA7517" : "#7F77DD",
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: true,
          max: isRating ? 5 : undefined,
          ticks: {
            stepSize: isRating ? 1 : 1,
            color: "rgba(255,255,255,0.5)",
            font: { size: 11 },
          },
          grid: { color: "rgba(255,255,255,0.06)" },
        },
        x: {
          ticks: {
            color: "rgba(255,255,255,0.5)",
            font: { size: 10 },
            autoSkip: false,
            maxRotation: 45,
          },
          grid: { display: false },
        },
      },
    },
  });
}

function renderRatingTrend(feed) {
  const monthly = computeMonthlyAvgRating(feed);
  const labels  = monthly.map(({ month }) => {
    const [y, mo] = month.split("-").map(Number);
    return new Date(y, mo - 1, 1).toLocaleDateString("en-PH", { month: "short", year: "2-digit" });
  });
  const data = monthly.map(({ avg }) => avg);

  const hasData = data.length > 0;
  const dataMin = hasData ? Math.min(...data) : 0;
  const dataMax = hasData ? Math.max(...data) : 5;
  const yMin    = hasData ? Math.max(0, Math.floor(dataMin) - 1) : 0;
  const yMax    = hasData ? Math.min(5, Math.ceil(dataMax)  + 1) : 5;

  createChart("dbTrendChart", {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Avg rating",
        data,
        borderColor: "#1D9E75",
        backgroundColor: "rgba(29,158,117,0.12)",
        borderWidth: 2,
        pointBackgroundColor: "#1D9E75",
        pointRadius: hasData ? 4 : 0,
        fill: true,
        tension: 0.35,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        ...(hasData ? {} : {
          beforeDraw(chart) {
            const { ctx, chartArea: { left, top, width, height } } = chart;
            ctx.save();
            ctx.fillStyle = "rgba(255,255,255,0.25)";
            ctx.font = "13px Poppins, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("No rating data yet", left + width / 2, top + height / 2);
            ctx.restore();
          }
        })
      },
      scales: {
        y: {
          min: yMin,
          max: yMax,
          ticks: {
            stepSize: 1,
            color: "rgba(255,255,255,0.5)",
            font: { size: 11 },
          },
          grid: { color: "rgba(255,255,255,0.06)" },
        },
        x: {
          ticks: {
            color: "rgba(255,255,255,0.5)",
            font: { size: 10 },
            autoSkip: false,
            maxRotation: 45,
          },
          grid: { display: false },
        },
      },
    },
  });
}

function renderStreaks(feed) {
  const el = $("dbStreakList");
  if (!el) return;

  const streaks = computeStreakData(feed);
  if (!streaks.length) {
    el.innerHTML = `<div class="text-secondary-light small">No streak data yet.</div>`;
    return;
  }

  el.innerHTML = streaks.map(({ name, streak, gapWeeks }) => `
    <div class="db-streak-row">
      <div class="db-streak-name">${escapeHtml(name)}</div>
      <div class="db-streak-badge">🔥 ${streak} in a row</div>
      <div class="db-streak-badge gap-badge">⏸ ${gapWeeks}w gap</div>
    </div>
  `).join("");
}

function renderSubGenreCloud(feed) {
  const el = $("dbSubGenreCloud");
  if (!el) return;

  const pairs = computeSubGenreCounts(feed);
  if (!pairs.length) {
    el.innerHTML = `<div class="text-secondary-light small">No sub-genre data yet.</div>`;
    return;
  }

  const max = pairs[0][1];
  el.innerHTML = pairs.map(([sg, count]) => {
    const size = 11 + Math.round((count / max) * 5);
    return `<span class="db-sg-pill" style="font-size:${size}px">
      ${escapeHtml(sg)}<span class="db-sg-count">${count}</span>
    </span>`;
  }).join("");
}

// ─────────────────────────────────────────
// DASHBOARD TAB SWITCH
// ─────────────────────────────────────────
function switchDashboardTab(mode) {
  state.dashboardMonthTab = mode;

  const tabCount  = $("tabCount");
  const tabRating = $("tabRating");
  if (tabCount)  tabCount.classList.toggle("active",  mode === "count");
  if (tabRating) tabRating.classList.toggle("active", mode === "rating");

  renderMonthlyChart(state.feed);
}
window.switchDashboardTab = switchDashboardTab;

// ─────────────────────────────────────────
// GENRE STATS
// ─────────────────────────────────────────
function renderGenreStats(genres) {
  if (!genres.length) return `<div class="text-secondary-light small">No genre data yet.</div>`;

  const max = Math.max(...genres.map((item) => item.total), 1);
  return genres.map((item) => {
    const width = (item.total / max) * 100;
    return `
      <div class="genre-stat-item">
        <div class="genre-stat-top">
          <div class="genre-stat-name">${escapeHtml(item.genre)}</div>
          <div class="genre-stat-count">${item.total} post${item.total !== 1 ? "s" : ""}</div>
        </div>
        <div class="genre-stat-bar">
          <div class="genre-stat-bar-fill" style="width: ${width}%;"></div>
        </div>
      </div>
    `;
  }).join("");
}

// ─────────────────────────────────────────
// TOP RATED ACCORDION
// ─────────────────────────────────────────
function renderTopRatedByStars(groups) {
  if (!groups.length) return `<div class="text-secondary-light small">No rating data yet.</div>`;

  return groups.map((group) => {
    const label   = `${numberToWord(group.stars)} Stars`;
    const panelId = `rating-panel-${group.stars}`;
    return `
      <div class="dashboard-month-item">
        <button type="button" class="dashboard-month-toggle" data-rating-toggle="${group.stars}"
          aria-expanded="false" aria-controls="${panelId}">
          <div class="dashboard-month-left">
            <span class="dashboard-month-name">${renderStars(group.stars)} ${escapeHtml(label)}</span>
            <span class="dashboard-month-count">(${group.total} post${group.total !== 1 ? "s" : ""})</span>
          </div>
          <i class="bi bi-chevron-down dashboard-month-icon"></i>
        </button>
        <div id="${panelId}" class="dashboard-month-panel">
          ${group.movies.length
            ? `<div class="dashboard-movie-list">
                ${group.movies.map((movie) => `
                  <div class="dashboard-movie-entry">
                    <div class="dashboard-movie-title">${escapeHtml(movie.movieName)}</div>
                    <div class="dashboard-movie-meta">
                      ${escapeHtml(movie.name || movie.username)} • ${escapeHtml(movie.genre || "-")} • ${escapeHtml(formatDate(movie.dateWatched))}
                    </div>
                  </div>
                `).join("")}
               </div>`
            : `<div class="dashboard-empty-month">No movie posts in this rating.</div>`}
        </div>
      </div>
    `;
  }).join("");
}

// ─────────────────────────────────────────
// WATCHED BY MONTH ACCORDION
// ─────────────────────────────────────────
function renderWatchedStatsByYear(items) {
  if (!items.length) return `<div class="text-secondary-light small">No monthly watched data yet.</div>`;

  const grouped = groupWatchedStatsByYear(items);
  return Object.keys(grouped).sort().map((year) => {
    const months = grouped[year];
    return `
      <div class="dashboard-year-block">
        <div class="dashboard-year-header">[${escapeHtml(year)}]</div>
        <div class="dashboard-year-body">
          ${months.map((monthItem) => {
            const panelId = `month-panel-${escapeHtml(monthItem.month).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
            return `
              <div class="dashboard-month-item">
                <button type="button" class="dashboard-month-toggle"
                  data-month-toggle="${escapeHtml(monthItem.month)}"
                  aria-expanded="false" aria-controls="${panelId}">
                  <div class="dashboard-month-left">
                    <span class="dashboard-month-name">${escapeHtml(formatMonthShortLabel(monthItem.month))}</span>
                    <span class="dashboard-month-count">(${monthItem.total} post${monthItem.total !== 1 ? "s" : ""})</span>
                  </div>
                  <i class="bi bi-chevron-down dashboard-month-icon"></i>
                </button>
                <div id="${panelId}" class="dashboard-month-panel">
                  <div class="dashboard-movie-list">
                    ${monthItem.movies.map((movie) => `
                      <div class="dashboard-movie-entry">
                        <div class="dashboard-movie-title">${escapeHtml(movie.movieName)}</div>
                        <div class="dashboard-movie-meta">
                          ${escapeHtml(movie.name || movie.username)} • ${escapeHtml(movie.genre || "-")} • ⭐ ${movie.rating} • ${escapeHtml(formatDate(movie.dateWatched))}
                        </div>
                      </div>
                    `).join("")}
                  </div>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }).join("");
}

function groupWatchedStatsByYear(items) {
  const byYear = {};
  items.forEach((item) => {
    const monthKey = String(item.month || "");
    if (!/^\d{4}-\d{2}$/.test(monthKey)) return;
    const [year] = monthKey.split("-");
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(item);
  });
  Object.keys(byYear).forEach((year) => {
    byYear[year].sort((a, b) => a.month.localeCompare(b.month));
  });
  return byYear;
}

// ─────────────────────────────────────────
// SUB-GENRES (sidebar)
// ─────────────────────────────────────────
function handleSubGenreInputKeydown(event) {
  if (event.key === "Enter") { event.preventDefault(); handleAddSubGenreDraft(); }
}

function handleAddSubGenreDraft() {
  const input = $("subGenreInput");
  const value = (input?.value || "").trim();
  if (!value) return;

  const existsInDB = (state.subGenres || []).some(
    (item) => (item.name || "").trim().toLowerCase() === value.toLowerCase()
  );
  if (existsInDB) {
    showAlert(`"${value}" already exists in sub-genres.`, "warning");
    return;
  }

  const existsInDraft = state.subGenreDrafts.some(
    (d) => d.toLowerCase() === value.toLowerCase()
  );
  if (existsInDraft) {
    showAlert(`"${value}" is already in your draft list.`, "warning");
    return;
  }

  state.subGenreDrafts.push(value);
  input.value = "";
  renderSubGenreDrafts();
}

async function handleSaveSubGenreDrafts() {
  if (!state.subGenreDrafts.length) {
    showAlert("Add at least one sub-genre draft first.", "danger");
    return;
  }

  try {
    await withLoading(async () => {
      for (const name of state.subGenreDrafts) {
        await api("addSubGenre", getSessionToken(), name);
      }
    })();
    state.subGenreDrafts = [];
    renderSubGenreDrafts();
    if ($("subGenreSearch")) $("subGenreSearch").value = "";
    await refreshFeed();
    showAlert(
      `${state.subGenreDrafts.length === 0 ? "Sub-genres" : "Sub-genre"} saved successfully.`,
      "success"
    );
  } catch (error) {
    showAlert(error.message, "danger");
  }
}

function renderSubGenreDrafts() {
  const list  = $("subGenreDraftList");
  const count = $("subGenreDraftCount");
  if (!list || !count) return;

  count.textContent = `${state.subGenreDrafts.length} draft${state.subGenreDrafts.length !== 1 ? "s" : ""}`;

  if (!state.subGenreDrafts.length) {
    list.innerHTML = `<div class="text-secondary small">No draft items yet.</div>`;
    return;
  }

  list.innerHTML = "";
  state.subGenreDrafts.forEach((name, index) => {
    const item = document.createElement("div");
    item.className = "todo-item";
    item.innerHTML = `
      <div class="todo-item-left">
        <div>
          <div class="todo-item-title">${escapeHtml(name)}</div>
          <div class="todo-item-meta">Draft sub-genre</div>
        </div>
      </div>
      <button type="button" class="todo-remove-btn align-self-center" data-sg-draft-index="${index}">
        <i class="bi bi-x-circle"></i>
      </button>
    `;
    item.querySelector(".todo-remove-btn")?.addEventListener("click", () => {
      state.subGenreDrafts.splice(index, 1);
      renderSubGenreDrafts();
    });
    list.appendChild(item);
  });
}

// ─────────────────────────────────────────
// DASHBOARD VISIBILITY
// ─────────────────────────────────────────
function toggleDashboard() {
  state.dashboardHidden = !state.dashboardHidden;
  const visible = !state.dashboardHidden;
  localStorage.setItem(DASHBOARD_STORAGE_KEY, String(visible));
  const toggle = $("dashboardToggle");
  if (toggle) toggle.setAttribute("aria-checked", String(visible));
  const dashboardCard = $("dashboardCard");
  if (dashboardCard) dashboardCard.classList.toggle("d-none", !visible);
  applyDashboardVisibility();
}

function togglePost() {
  const content    = $("postContent");
  const btn        = $("togglePostBtn");
  const headerCard = $("postHeaderCard");
  if (!content || !btn) return;
  const isHidden = content.classList.toggle("d-none");
  const visible  = !isHidden;
  if (headerCard) headerCard.classList.toggle("d-none", !visible);
  btn.innerHTML = isHidden ? `<i class="bi bi-eye-slash"></i>` : `<i class="bi bi-eye"></i>`;
  localStorage.setItem(POST_STORAGE_KEY, String(visible));
  const toggle = $("postToggle");
  if (toggle) toggle.setAttribute("aria-checked", String(visible));
}

function toggleSidebar() {
  const content    = $("sidebarContent");
  const btn        = $("toggleSidebarBtn");
  const headerCard = $("toolsHeaderCard");
  if (!content || !btn) return;
  const isHidden = content.classList.toggle("d-none");
  const visible  = !isHidden;
  if (headerCard) headerCard.classList.toggle("d-none", !visible);
  btn.innerHTML = isHidden ? `<i class="bi bi-eye-slash"></i>` : `<i class="bi bi-eye"></i>`;
  localStorage.setItem(TOOLS_STORAGE_KEY, String(visible));
  const toggle = $("toolsToggle");
  if (toggle) toggle.setAttribute("aria-checked", String(visible));
}

function applyDashboardVisibility() {
  const content = $("dashboardContent");
  const btn     = $("toggleDashboardBtn");
  if (!content || !btn) return;

  content.classList.toggle("d-none", state.dashboardHidden);
  btn.innerHTML = state.dashboardHidden ? `<i class="bi bi-eye-slash"></i>` : `<i class="bi bi-eye"></i>`;
  bindDashboardMonthToggles();
}

function bindDashboardMonthToggles() {
  document.querySelectorAll("[data-month-toggle], [data-rating-toggle]").forEach((btn) => {
    btn.onclick = () => {
      const item   = btn.closest(".dashboard-month-item");
      const isOpen = item.classList.toggle("open");
      btn.setAttribute("aria-expanded", String(isOpen));
    };
  });
}

// ─────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────
function toggleNotifications() {
  state.notifOpen = !state.notifOpen;
  const dropdown = $("notifDropdown");
  if (!dropdown) return;
  if (state.notifOpen) {
    dropdown.classList.add("open");
    markNotificationsRead();
  } else {
    dropdown.classList.remove("open");
  }
}

function closeNotifications() {
  if (!state.notifOpen) return;
  state.notifOpen = false;
  $("notifDropdown")?.classList.remove("open");
}

function renderNotifications() {
  const notifList      = $("notifList");
  const notifBadge     = $("notifBadge");
  const notifPanelBadge = $("notifPanelBadge");
  const toggleBtn      = $("notifToggleReadBtn");
  if (!notifList || !notifBadge) return;

  const items       = Array.isArray(state.notifications) ? state.notifications : [];
  const unreadCount = items.filter(n => !n.isRead).length;

  notifBadge.textContent = String(unreadCount);
  notifBadge.classList.toggle("d-none", unreadCount === 0);

  if (notifPanelBadge) {
    notifPanelBadge.textContent = unreadCount > 0
      ? `${unreadCount} unread`
      : "0 unread";
    notifPanelBadge.classList.toggle("is-empty", unreadCount === 0);
  }

  const showingUnread = state.notifShowUnreadOnly || false;
  if (toggleBtn) {
    toggleBtn.textContent = showingUnread ? "Show all" : `Unread (${unreadCount})`;
    toggleBtn.classList.toggle("is-active", showingUnread);

    toggleBtn.onclick = () => {
      state.notifShowUnreadOnly = !state.notifShowUnreadOnly;
      renderNotifications();
    };
  }

  const visible = showingUnread ? items.filter(n => !n.isRead) : items;

  if (!visible.length) {
    notifList.innerHTML = `
      <div class="notif-empty">
        <i class="bi bi-bell-slash"></i>
        ${showingUnread && items.length ? "No unread notifications." : "No notifications yet."}
      </div>`;
    return;
  }

  notifList.innerHTML = "";
  visible.forEach(item => {
    const btn = document.createElement("button");
    btn.type      = "button";
    btn.className = `notif-item${item.isRead ? "" : " unread"}`;
    btn.innerHTML = `
      <div class="notif-item-title">${escapeHtml(item.message || "")}</div>
      <div class="notif-item-time">${formatDateTime(item.createdAt)}</div>
    `;
    btn.addEventListener("click", () => {
      closeNotifications();
      if (item.postId) scrollToPost(item.postId);
    });
    notifList.appendChild(btn);
  });
}

async function markNotificationsRead() {
  const unread = state.notifications.filter((item) => !item.isRead);
  if (!unread.length) return;

  try {
    await api("markNotificationsRead", getSessionToken());
    state.notifications = state.notifications.map((item) => ({ ...item, isRead: true }));
    renderNotifications();
  } catch (error) {
    console.error("Failed to mark notifications as read:", error);
  }
}

function scrollToPost(postId) {
  const selector = `[data-post-id="${cssEscape(postId)}"]`;
  const postEl   = document.querySelector(selector);
  if (!postEl) return;
  postEl.scrollIntoView({ behavior: "smooth", block: "start" });
  postEl.classList.add("post-highlight");
  setTimeout(() => postEl.classList.remove("post-highlight"), 1800);
}

// ─────────────────────────────────────────
// POST CRUD
// ─────────────────────────────────────────
async function handleSavePost(event) {
  event.preventDefault();
  hideAlerts();

  const postId      = $("postId")?.value.trim() || "";
  const movieName   = $("movieName")?.value.trim() || "";
  const genre       = $("genre")?.value || "";
  // FIX 2: read from state instead of DOM
  const subGenres   = getSelectedSubGenres();
  const rating      = $("rating")?.value || "";
  const dateWatched = $("dateWatched")?.value || "";
  const duration    = $("duration")?.value.trim() || "";
  const caption     = $("caption")?.value.trim() || "";
  const submitBtn   = event.submitter;

  try {
    toggleButton(submitBtn, true);

    await withLoading(async () => {
      if (state.isEditing && postId) {
        await api("updatePost", getSessionToken(), postId, movieName, genre, subGenres, rating, dateWatched, duration, caption);
        showAlert("Post updated successfully.", "success");
      } else {
        await api("createPost", getSessionToken(), movieName, genre, subGenres, rating, dateWatched, duration, caption);

        const linkedTodo = state.todos.find((t) => t.todoId === state.selectedTodoId);
        if (linkedTodo && linkedTodo.movieName.trim().toLowerCase() === movieName.trim().toLowerCase()) {
          await api("deleteTodo", getSessionToken(), linkedTodo.todoId);
          state.selectedTodoId = "";
        }

        showAlert("Movie posted successfully.", "success");
      }
    })();

    const wasEditing = state.isEditing;
    resetPostForm();
    await refreshFeed();
    if (!wasEditing) {
      setTimeout(() => {
        const firstCard = $("feedList")?.querySelector(".post-card");
        if (firstCard) {
          firstCard.scrollIntoView({ behavior: "smooth", block: "start" });
          firstCard.classList.add("post-highlight");
          setTimeout(() => firstCard.classList.remove("post-highlight"), 1800);
        }
      }, 120);
    }
    
  } catch (error) {
    showAlert(error.message, "danger");
  } finally {
    toggleButton(submitBtn, false);
  }
}

// ─────────────────────────────────────────
// RENDER FEED (paginated / infinite scroll)
// ─────────────────────────────────────────
let _infiniteObserver = null;

function renderFeedPaginated(feed) {
  const feedList       = $("feedList");
  const emptyFeed      = $("emptyFeed");
  const feedCountBadge = $("feedCountBadge");
  const sentinel       = $("feedSentinel");
  if (!feedList || !emptyFeed || !feedCountBadge) return;

  if (_infiniteObserver) { _infiniteObserver.disconnect(); _infiniteObserver = null; }

  feedList.innerHTML = "";
  feedCountBadge.textContent = `${feed.length} post${feed.length !== 1 ? "s" : ""}`;
  emptyFeed.classList.toggle("d-none", feed.length > 0);
  if (!feed.length) { if (sentinel) sentinel.style.display = "none"; return; }

  feedList._pagedFeed = feed;
  feedList._pagedIndex = 0;

  const renderNextPage = () => {
    const { _pagedFeed: f, _pagedIndex: idx } = feedList;
    if (idx >= f.length) { if (sentinel) sentinel.style.display = "none"; return; }
    const slice = f.slice(idx, idx + state.feedPageSize);
    slice.forEach((post) => feedList.appendChild(renderPostCard(post)));
    feedList._pagedIndex += slice.length;
    if (feedList._pagedIndex >= f.length) {
      if (sentinel) sentinel.style.display = "none";
    } else {
      if (sentinel) sentinel.style.display = "block";
    }
  };

  renderNextPage();

  if (sentinel && "IntersectionObserver" in window) {
    _infiniteObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) renderNextPage();
    }, { rootMargin: "200px" });
    _infiniteObserver.observe(sentinel);
  }
}

function renderFeed(feed) { renderFeedPaginated(feed); }

function replacePostCard(postId) {
  const existing = document.querySelector(`[data-post-id="${CSS.escape(postId)}"]`);
  const postData = state.feed.find(p => p.postId === postId);
  if (!existing) { applyFeedFilter(); return; }
  if (!postData) { existing.remove(); return; }
  const fresh = renderPostCard(postData);
  existing.replaceWith(fresh);
}

function renderPostCard(post) {
  const card     = document.createElement("div");
  card.className = "glass-card post-card mb-4";
  card.setAttribute("data-post-id", post.postId);

  const canEditPost   = state.currentUser && state.currentUser.username === post.username;
  const subGenrePills = (post.subGenres || [])
    .map((sg) => `<span class="pc-pill pc-pill--sub">${escapeHtml(sg)}</span>`)
    .join("");

  const displayName  = post.name || post.username || "?";
  const initials     = displayName.trim().charAt(0).toUpperCase();
  const avatarHtml   = post.avatar
    ? `<img src="${escapeHtml(post.avatar)}" class="pc-avatar pc-avatar--img" alt="avatar">`
    : `<div class="pc-avatar pc-avatar--init">${escapeHtml(initials)}</div>`;

  const rating    = Number(post.rating || 0);
  const starsHtml = [1,2,3,4,5]
    .map((n) => `<span class="pc-star${n <= rating ? " pc-star--on" : ""}">${n <= rating ? "★" : "☆"}</span>`)
    .join("");

  const durationHtml = post.duration
    ? `<span class="pc-meta-chip"><i class="bi bi-clock"></i> ${escapeHtml(post.duration)}</span>`
    : "";
  const watchedHtml  = post.dateWatched
    ? `<span class="pc-meta-chip"><i class="bi bi-eye"></i> ${escapeHtml(formatDate(post.dateWatched))}</span>`
    : "";

  const genrePills = post.genre
    ? `<span class="pc-pill pc-pill--genre">${escapeHtml(post.genre)}</span>`
    : "";

  const captionHtml = post.caption
    ? `<blockquote class="pc-caption">${escapeHtml(post.caption)}</blockquote>`
    : "";

  const actionsHtml = canEditPost
    ? `<div class="pc-actions">
         <button class="pc-action-btn pc-action-btn--edit edit-post-btn" type="button" title="Edit">
           <i class="bi bi-pencil-square"></i>
         </button>
         <button class="pc-action-btn pc-action-btn--del delete-post-btn" type="button" title="Delete">
           <i class="bi bi-trash"></i>
         </button>
       </div>`
    : "";

  const editedHtml = (post.updatedAt && post.updatedAt !== post.createdAt)
    ? `<span class="pc-edited d-block" title="Edited ${formatDateTime(post.updatedAt)}">(Last edited ${timeAgo(post.updatedAt)})</span>`
    : "";

  card.innerHTML = `
    <div class="pc-header">
      <div class="pc-header-left">
        ${avatarHtml}
        <div class="pc-header-meta">
          <span class="pc-author">${escapeHtml(displayName)}</span>
          <span class="pc-date">${escapeHtml(formatDateTime(post.createdAt))}${editedHtml}</span>
        </div>
      </div>
      ${actionsHtml}
    </div>

    <div class="pc-body">
      <h3 class="pc-title">${escapeHtml(post.movieName)}</h3>

      <div class="pc-stars-row">
        ${starsHtml}
        ${durationHtml}
        ${watchedHtml}
      </div>

      <div class="pc-pills-row">
        ${genrePills}
        ${subGenrePills}
      </div>

      ${captionHtml}
    </div>

    <div class="pc-comments">
      <div class="pc-comments-header">
        <i class="bi bi-chat-square-dots"></i>
        <span>${post.comments.length} COMMENT${post.comments.length !== 1 ? "S" : ""}</span>
      </div>

      <div class="pc-comments-list"></div>

      <form class="pc-comment-form">
        <input type="text" class="pc-comment-input comment-input" placeholder="Write a comment..." required>
        <button type="submit" class="pc-comment-submit" aria-label="Send">
          <i class="bi bi-send"></i>
        </button>
      </form>
    </div>
  `;

  const commentsList = card.querySelector(".pc-comments-list");
  const COMMENTS_PREVIEW = 2;

  function renderCommentList() {
    commentsList.innerHTML = "";
    if (!post.comments.length) {
      commentsList.innerHTML = `<p class="pc-no-comments">No comments yet.</p>`;
      return;
    }

    const isExpanded = commentsList.dataset.expanded === "true";
    const visible = isExpanded ? post.comments : post.comments.slice(0, COMMENTS_PREVIEW);
    const hidden = post.comments.length - COMMENTS_PREVIEW;

    visible.forEach((c) => commentsList.appendChild(renderCommentItem(c)));

    if (post.comments.length > COMMENTS_PREVIEW) {
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.style.cssText = `
        background: none; border: none; padding: 0.25rem 0;
        font-size: 0.75rem; font-family: 'Poppins', sans-serif;
        color: rgba(255,255,255,0.4); cursor: pointer;
        transition: color 0.15s; display: block; margin-top: 0.25rem;
      `;
      toggleBtn.textContent = isExpanded
        ? "Show less"
        : `Show ${hidden} more comment${hidden !== 1 ? "s" : ""}…`;
      toggleBtn.addEventListener("mouseenter", () => toggleBtn.style.color = "rgba(255,255,255,0.75)");
      toggleBtn.addEventListener("mouseleave", () => toggleBtn.style.color = "rgba(255,255,255,0.4)");
      toggleBtn.addEventListener("click", () => {
        commentsList.dataset.expanded = isExpanded ? "false" : "true";
        renderCommentList();
      });
      commentsList.appendChild(toggleBtn);
    }
  }

  renderCommentList();

  const commentForm  = card.querySelector(".pc-comment-form");
  const commentInput = card.querySelector(".comment-input");
  commentForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text      = commentInput.value.trim();
    const submitBtn = commentForm.querySelector("button[type='submit']");
    if (!text) return;

    const tempId  = "temp-" + Date.now();
    const tempComment = {
      commentId:  tempId,
      postId:     post.postId,
      username:   state.currentUser.username,
      name:       state.currentUser.name || state.currentUser.username,
      avatar:     state.currentUser.avatar || "",
      comment:    text,
      createdAt:  new Date().toISOString(),
    };

    const postInState = state.feed.find(p => p.postId === post.postId);
    
    if (postInState) postInState.comments = [...(postInState.comments || []), tempComment];

    commentInput.value = "";
    toggleButton(submitBtn, true);

    // Auto-expand so the new optimistic comment is visible
    const cl = card.querySelector(".pc-comments-list");
    if (cl) cl.dataset.expanded = "true";

    replacePostCard(post.postId);

    try {
      await api("addComment", getSessionToken(), post.postId, text);
      showAlert("Comment posted successfully.", "success");
      silentRefresh();
    } catch (error) {
      if (postInState) {
        postInState.comments = (postInState.comments || []).filter(c => c.commentId !== tempId);
      }
      replacePostCard(post.postId);
      showAlert(error.message, "danger");
    } finally {
      const newCard = document.querySelector(`[data-post-id="${CSS.escape(post.postId)}"]`);
      const newBtn  = newCard?.querySelector(".pc-comment-form button[type='submit']");
      if (newBtn) toggleButton(newBtn, false);
    }
  });

  card.querySelectorAll(".delete-comment-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const commentId = btn.dataset.commentId;

      const postInState = state.feed.find(p => p.postId === post.postId);
      let removedComment = null;
      let removedIndex   = -1;
      if (postInState) {
        removedIndex   = postInState.comments.findIndex(c => c.commentId === commentId);
        if (removedIndex !== -1) {
          removedComment = postInState.comments[removedIndex];
          postInState.comments = postInState.comments.filter(c => c.commentId !== commentId);
        }
      }

      replacePostCard(post.postId);

      try {
        await api("deleteComment", getSessionToken(), commentId);
        showAlert("Comment deleted successfully.", "success");
        silentRefresh();
      } catch (error) {
        if (postInState && removedComment && removedIndex !== -1) {
          postInState.comments.splice(removedIndex, 0, removedComment);
        }
        replacePostCard(post.postId);
        showAlert(error.message, "danger");
      }
    });
  });

  if (!canEditPost) return card;

  card.querySelector(".edit-post-btn")?.addEventListener("click", () => startEdit(post));
  card.querySelector(".delete-post-btn")?.addEventListener("click", async (event) => {
    if (!confirm(`Delete post for "${post.movieName}"?`)) return;

    const idx = state.feed.findIndex(p => p.postId === post.postId);
    let removed = null;
    if (idx !== -1) { removed = state.feed[idx]; state.feed.splice(idx, 1); }

    applyFeedFilter();
    renderDashboard();

    try {
      await api("deletePost", getSessionToken(), post.postId);
      showAlert("Post deleted successfully.", "success");
      silentRefresh();
    } catch (error) {
      if (removed && idx !== -1) state.feed.splice(idx, 0, removed);
      applyFeedFilter();
      renderDashboard();
      showAlert(error.message, "danger");
    }
  });

  return card;
}

function renderCommentItem(comment) {
  const item = document.createElement("div");
  item.className = "pc-comment-item";

  const canDelete   = state.currentUser && state.currentUser.username === comment.username;
  const displayName = comment.name || comment.username || "?";
  const initials    = displayName.trim().charAt(0).toUpperCase();
  const avatarHtml  = comment.avatar
    ? `<img src="${escapeHtml(comment.avatar)}" class="pc-comment-avatar pc-comment-avatar--img" alt="avatar">`
    : `<div class="pc-comment-avatar pc-comment-avatar--init">${escapeHtml(initials)}</div>`;

  item.innerHTML = `
    <div class="pc-comment-row">
      ${avatarHtml}
      <div class="pc-comment-body">
        <span class="pc-comment-author">${escapeHtml(displayName)}</span>
        <p class="pc-comment-text">${escapeHtml(comment.comment)}</p>
        <span class="pc-comment-time">${escapeHtml(formatDateTime(comment.createdAt))}</span>
      </div>
      ${canDelete
        ? `<button class="pc-comment-del delete-comment-btn" type="button"
             data-comment-id="${escapeHtml(comment.commentId)}" title="Delete">
             <i class="bi bi-x-circle"></i>
           </button>`
        : ""}
    </div>
  `;
  return item;
}

// ─────────────────────────────────────────
// SUB-GENRE CHECKBOXES / PREVIEW (sidebar)
// FIX 2: all selection reads/writes go through state.selectedSubGenres
// ─────────────────────────────────────────

/** Read selection from state (source of truth) */
function getSelectedSubGenres() {
  return [...state.selectedSubGenres];
}

/** Set selection in state and re-render checkboxes */
function setSelectedSubGenres(values) {
  state.selectedSubGenres = new Set(Array.isArray(values) ? values : []);
  renderSubGenreCheckboxes();
}

function renderSubGenrePreview() {
  const list  = $("subGenrePreviewList");
  const count = $("subGenreCount");
  const query = ($("subGenreSearch")?.value || "").trim().toLowerCase();
  if (!list || !count) return;

  const allItems      = Array.isArray(state.subGenres) ? state.subGenres : [];
  const filteredItems = query
    ? allItems.filter((item) => (item.name || "").toLowerCase().includes(query))
    : allItems;

  count.textContent = `${filteredItems.length} item${filteredItems.length !== 1 ? "s" : ""}`;

  if (!allItems.length) {
    list.innerHTML = `<div class="text-secondary-light small">No sub-genres yet.</div>`;
    return;
  }

  if (!filteredItems.length) {
    list.innerHTML = `<div class="text-secondary-light small">No matching sub-genres found.</div>`;
    return;
  }

  list.innerHTML = filteredItems
    .map((item) => `<span class="subgenre-preview-pill">${escapeHtml(item.name)}</span>`)
    .join("");
}

function renderSubGenreCheckboxes() {
  const group = $("subGenreGroup");
  if (!group) return;

  // FIX 2: read from state, not DOM — survives re-renders
  const selected      = state.selectedSubGenres;
  const filterQuery   = ($("subGenreFilterInput")?.value || "").trim().toLowerCase();
  const showSelected  = $("subGenreShowSelected")?.checked || false;

  if (!state.subGenres.length) {
    group.innerHTML = `<div class="subgenre-empty-msg">No sub-genres available yet.</div>`;
    return;
  }

  let items = [...state.subGenres];

  if (showSelected) {
    items = items.filter((item) => selected.has(item.name));
  }

  if (filterQuery) {
    items = items.filter((item) => (item.name || "").toLowerCase().includes(filterQuery));
  }

  if (state.subGenreSortAZ) {
    items = items.slice().sort((a, b) => {
      const cmp = (a.name || "").localeCompare(b.name || "");
      return state.subGenreSortDir === "desc" ? -cmp : cmp;
    });
  }

  if (!items.length) {
    const msg = showSelected
      ? "No sub-genres selected yet."
      : "No matching sub-genres.";
    group.innerHTML = `<div class="subgenre-empty-msg">${msg}</div>`;
    return;
  }

  // FIX 2: render checkboxes reflecting state.selectedSubGenres
  group.innerHTML = items.map((item) => `
    <label class="subgenre-chip">
      <input type="checkbox" name="subGenre" value="${escapeHtml(item.name)}" ${selected.has(item.name) ? "checked" : ""}>
      <span>${escapeHtml(item.name)}</span>
    </label>
  `).join("");
  // NOTE: change events bubble up to the delegated listener on #subGenreGroup
  // bound in bindEvents(), so no per-checkbox listeners needed here.
}

function updateSubGenreSortBtn(btn) {
  if (!btn) return;
  const icon = btn.querySelector("i");
  if (!state.subGenreSortAZ) {
    btn.classList.remove("is-active");
    btn.title = "Sort A–Z";
    if (icon) icon.className = "bi bi-sort-alpha-down";
  } else if (state.subGenreSortDir === "asc") {
    btn.classList.add("is-active");
    btn.title = "Sort Z–A";
    if (icon) icon.className = "bi bi-sort-alpha-down";
  } else {
    btn.classList.add("is-active");
    btn.title = "Clear sort";
    if (icon) icon.className = "bi bi-sort-alpha-up-alt";
  }
}

// ─────────────────────────────────────────
// POST FORM STATE
// ─────────────────────────────────────────
function startEdit(post) {
  state.isEditing = true;
  $("postId").value      = post.postId || "";
  $("movieName").value   = post.movieName || "";
  $("genre").value       = post.genre || "";
  setSelectedSubGenres(post.subGenres || []);
  $("rating").value      = String(post.rating || "");
  $("dateWatched").value = normalizeDateForInput(post.dateWatched);
  $("duration").value    = post.duration || "";
  $("caption").value     = post.caption || "";

  $("formTitle").textContent = "Edit Post";
  $("submitBtn").innerHTML   = `<i class="bi bi-save me-2"></i>Save Changes`;
  $("cancelEditBtn").classList.remove("d-none");

  // Open the Post panel if it's hidden
  const postContent = $("postContent");
  if (postContent && postContent.classList.contains("d-none")) {
    applyPostState(true, true);
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetPostForm() {
  state.isEditing = false;
  $("postForm")?.reset();
  $("postId").value = "";
  // FIX 2: clear via state, which re-renders checkboxes
  state.selectedSubGenres = new Set();
  if ($("subGenreFilterInput"))  $("subGenreFilterInput").value = "";
  if ($("subGenreShowSelected")) $("subGenreShowSelected").checked = false;
  renderSubGenreCheckboxes();
  $("formTitle").textContent = "Create Post";
  $("submitBtn").innerHTML   = `<i class="bi bi-send me-2"></i>Post Movie`;
  $("cancelEditBtn").classList.add("d-none");
  state.selectedTodoId = "";
  renderSavedTodos();
}

// ─────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────
function toggleButton(button, disabled) {
  if (!button) return;
  button.disabled = disabled;
  button.setAttribute("aria-disabled", String(disabled));
}

function renderStars(rating) {
  const n = Number(rating || 0);
  return n > 0 ? "⭐".repeat(n) : "-";
}

function formatMonthShortLabel(value) {
  if (!value || !/^\d{4}-\d{2}$/.test(String(value))) return value || "-";
  const [year, month] = String(value).split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-PH", { month: "short" });
}

function numberToWord(value) {
  return { 1:"One", 2:"Two", 3:"Three", 4:"Four", 5:"Five" }[value] || String(value);
}

function formatDate(value) {
  if (!value) return "-";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split("-").map(Number);
    return new Date(year, month - 1, day).toLocaleDateString("en-PH", { year:"numeric", month:"short", day:"numeric" });
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-PH", { year:"numeric", month:"short", day:"numeric" });
}

function timeAgo(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";

  const diffMs   = Date.now() - d.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHrs  = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHrs  / 24);
  const diffWks  = Math.floor(diffDays / 7);
  const diffMths = Math.floor(diffDays / 30);
  const diffYrs  = Math.floor(diffDays / 365);

  if (diffSecs <  60)  return "just now";
  if (diffMins <  60)  return diffMins + "m ago";
  if (diffHrs  <  24)  return diffHrs  + "hr ago";
  if (diffDays <   2)  return "1d ago";
  if (diffDays <   7)  return diffDays + "d ago";
  if (diffWks  <   5)  return diffWks  + "w ago";
  if (diffMths <  12)  return diffMths + "mo ago";
  return diffYrs + "yr ago";
}

function formatDateTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-PH", { year:"numeric", month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
}

function normalizeDateWatched(raw) {
  if (!raw) return "";
  const d = new Date(raw);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function normalizeDateForInput(value) {
  if (!value) return "";
  return normalizeDateWatched(value);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}
