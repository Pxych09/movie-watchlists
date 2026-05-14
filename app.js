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
  isEditing: false,
  alertTimers: new Map(),
  loadingCount: 0,
  notifications: [],
  notifOpen: false,
  subGenres: [],
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
  bind("addTodoBtn",     "click",   handleAddTodoDraft);
  bind("saveTodoBtn",    "click",   handleSaveTodoDrafts);
  bind("todoInput",      "keydown", handleTodoInputKeydown);
  bind("addSubGenreBtn", "click",   handleAddSubGenre);
  bind("subGenreInput",  "keydown", handleSubGenreInputKeydown);
  bind("subGenreSearch", "input",   handleSubGenreSearch);
  bind("savedTodoSearch","input",   handleSavedTodoSearch);
  bind("spinTodoBtn",    "click",   handleSpinTodoRoulette);

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

  mobileLogoutBtn?.addEventListener("click", handleLogout);
  bindToolsToggle();
  bindDashboardToggle();

}

// ─────────────────────────────────────────
// TOOLS PANEL TOGGLE
// ─────────────────────────────────────────
const TOOLS_STORAGE_KEY = "toolsPanelVisible";

function bindToolsToggle() {
  const toggle = $("toolsToggle");
  if (!toggle) return;

  const saved     = localStorage.getItem(TOOLS_STORAGE_KEY);
  const isVisible = saved === null ? false : saved === "true";
  applyToolsState(isVisible, false);

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const current = toggle.getAttribute("aria-checked") === "true";
    applyToolsState(!current, true);
  });

  function applyToolsState(visible, save) {
    toggle.setAttribute("aria-checked", String(visible));

    const content    = $("sidebarContent");
    const btn        = $("toggleSidebarBtn");
    const headerCard = $("toolsHeaderCard");
    if (content)    content.classList.toggle("d-none", !visible);
    if (headerCard) headerCard.classList.toggle("d-none", !visible);
    if (btn)        btn.textContent = visible ? "Hide Tools" : "Show Tools";

    if (save) localStorage.setItem(TOOLS_STORAGE_KEY, String(visible));
  }
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

  function applyDashboardToggleState(visible, save) {
    toggle.setAttribute("aria-checked", String(visible));
    state.dashboardHidden = !visible;
    const dashboardCard = $("dashboardCard");
    if (dashboardCard) dashboardCard.classList.toggle("d-none", !visible);
    applyDashboardVisibility();
    if (save) localStorage.setItem(DASHBOARD_STORAGE_KEY, String(visible));
  }
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

  // hideAlerts() is called on logout — clears all toasts at once
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
  state.dashboardMonthTab = "count";
  state.notifShowUnreadOnly = false;

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
  if ($("subGenreInput"))       $("subGenreInput").value = "";

  if ($("topRatedList"))     $("topRatedList").innerHTML = "";
  if ($("watchedStatsList")) $("watchedStatsList").innerHTML = "";
  if ($("userTotalsList"))   $("userTotalsList").innerHTML = "";
  if ($("dashboardContent")) $("dashboardContent").classList.remove("d-none");
  if ($("toggleDashboardBtn")) $("toggleDashboardBtn").textContent = "Hide Dashboard";
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

  $("notifDropdown")?.classList.add("d-none");
  if ($("notifList")) $("notifList").innerHTML = `<div class="p-3 text-secondary-light small">No notifications yet.</div>`;
  $("notifBadge")?.classList.add("d-none");

  if ($("subGenreSearch")) $("subGenreSearch").value = "";

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

    renderSavedTodos();
    renderDraftTodos();
    renderSubGenrePreview();
    renderSubGenreCheckboxes();
    renderDashboard();
    applyFeedFilter();
    renderNotifications();
  } catch (error) {
    showAlert(error.message, "danger");
    if (/Session expired/i.test(error.message)) await handleLogout();
  }
}

// ─────────────────────────────────────────
// SEARCH HANDLERS
// ─────────────────────────────────────────
function handleSavedTodoSearch() { renderSavedTodos(); }
function handleSubGenreSearch()  { renderSubGenrePreview(); }
function handleFeedSearch()      { applyFeedFilter(); }

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
// FEED FILTER
// ─────────────────────────────────────────
function applyFeedFilter() {
  const query = ($("feedSearch")?.value || "").trim().toLowerCase();

  if (!query) { renderFeed(state.feed); return; }

  const filteredFeed = state.feed.filter((post) => {
    const haystack = [
      post.movieName, post.genre,
      ...(post.subGenres || []),
      post.caption, post.username, post.name, post.duration,
      ...(post.comments || []).map((c) => `${c.name} ${c.username} ${c.comment}`)
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });

  renderFeed(filteredFeed);
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
          <div class="todo-item-meta">added by: ${escapeHtml(todo.createdBy || "-")}</div>
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
  } else if (state.selectedTodoId === todo.todoId) {
    state.selectedTodoId = "";
    $("movieName").value = "";
  }
  renderSavedTodos();
}

// ─────────────────────────────────────────
// DASHBOARD — CLIENT-SIDE COMPUTATIONS
// ─────────────────────────────────────────

/** Parse "2h 15m", "1h", "45m", "120" → total minutes */
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

/** Group feed posts by YYYY-MM key */
// function groupFeedByMonth(feed) {
//   const byMonth = {};
//   feed.forEach((post) => {
//     const raw = post.dateWatched || "";
//     const key = String(raw).slice(0, 7); // "YYYY-MM"
//     if (!/^\d{4}-\d{2}$/.test(key)) return;
//     if (!byMonth[key]) byMonth[key] = [];
//     byMonth[key].push(post);
//   });
//   return byMonth;
// }
function groupFeedByMonth(feed) {
  const byMonth = {};
  feed.forEach((post) => {
    const iso = normalizeDateWatched(post.dateWatched); // "YYYY-MM-DD"
    const key = iso.slice(0, 7); // "YYYY-MM"
    if (!/^\d{4}-\d{2}$/.test(key)) return;
    if (!byMonth[key]) byMonth[key] = [];
    byMonth[key].push(post);
  });
  return byMonth;
}
// function groupFeedByMonth(feed) {
//   const byMonth = {};
//   feed.forEach((post) => {
//     const raw = post.dateWatched;
//     if (!raw) return;

//     let key;
//     if (raw instanceof Date || (typeof raw === "object" && raw !== null)) {
//       // Already a Date object
//       const d = new Date(raw);
//       if (isNaN(d.getTime())) return;
//       key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
//     } else {
//       const s = String(raw);
//       // Full date string like "Mon May 11 2026 00:00:00 GMT+0800..."
//       if (!/^\d{4}-\d{2}/.test(s)) {
//         const d = new Date(s);
//         if (isNaN(d.getTime())) return;
//         key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
//       } else {
//         key = s.slice(0, 7);
//       }
//     }

//     if (!/^\d{4}-\d{2}$/.test(key)) return;
//     if (!byMonth[key]) byMonth[key] = [];
//     byMonth[key].push(post);
//   });
//   return byMonth;
// }

/** Compute watching streaks and longest gap per user from the full feed */
function computeStreakData(feed) {
  // Group posts by username → sorted dates
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
      // "Streak" = watched within 8 days of previous watch
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

/** Compute per-month average ratings from the full feed */
function computeMonthlyAvgRating(feed) {
  const byMonth = groupFeedByMonth(feed);
  return Object.keys(byMonth).sort().map((month) => {
    const posts = byMonth[month];
    const avg = posts.reduce((s, p) => s + Number(p.rating || 0), 0) / posts.length;
    return { month, avg: parseFloat(avg.toFixed(2)) };
  });
}

/** Count sub-genre occurrences across all posts */
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
// DASHBOARD — RENDER
// ─────────────────────────────────────────
function renderDashboard() {
  if (!$("genreStatsList")) return; // DOM not ready

  const dashboard     = state.dashboard || {};
  const genres        = Array.isArray(dashboard.genres)        ? dashboard.genres        : [];
  const topRated      = Array.isArray(dashboard.topRated)      ? dashboard.topRated      : [];
  const watchedByMonth = Array.isArray(dashboard.watchedByMonth) ? dashboard.watchedByMonth : [];
  const userTotals    = Array.isArray(dashboard.userTotals)    ? dashboard.userTotals    : [];
  const feed          = Array.isArray(state.feed)              ? state.feed              : [];

  //console.log(feed)
  console.log("feed length:", feed.length);
  console.log("sample dateWatched values:", feed.slice(0, 5).map(p => p.dateWatched));
  console.log("groupFeedByMonth result:", groupFeedByMonth(feed));

  // ── Metric cards (computed client-side from feed) ──
  const totalPosts  = feed.length;
  const totalMins   = feed.reduce((s, p) => s + parseDurationToMinutes(p.duration), 0);
  const totalHrs    = Math.round(totalMins / 60);
  const avgRating   = totalPosts
    ? (feed.reduce((s, p) => s + Number(p.rating || 0), 0) / totalPosts).toFixed(1)
    : "—";
  const activeUsers = new Set(feed.map((p) => p.username).filter(Boolean)).size;

  if ($("dbMetricPosts"))     $("dbMetricPosts").textContent     = totalPosts;
  if ($("dbMetricHours"))     $("dbMetricHours").textContent     = totalHrs + "h";
  if ($("dbMetricAvgRating")) $("dbMetricAvgRating").textContent = avgRating !== "—" ? avgRating + " ★" : "—";
  if ($("dbMetricUsers"))     $("dbMetricUsers").textContent     = activeUsers;

  // ── Genre bars (server data) ──
  $("genreStatsList").innerHTML = renderGenreStats(genres);

  // ── Rating donut chart ──
  renderRatingDonut(feed);

  // ── Monthly bar/line chart ──
  renderMonthlyChart(feed);

  // ── User totals (server data) ──
  $("userTotalsList").innerHTML = userTotals.length
    ? userTotals.map((item) => `
        <div class="dashboard-list-item">
          <div class="dashboard-item-title">${escapeHtml(item.name)}</div>
          <div class="dashboard-pill">${item.totalPosts} posts</div>
        </div>
      `).join("")
    : `<div class="text-secondary-light small">No user post data yet.</div>`;

  // ── Streaks (computed from feed) ──
  renderStreaks(feed);

  // ── Top rated accordion (server data) ──
  $("topRatedList").innerHTML = renderTopRatedByStars(topRated);

  // ── Rating trend line ──
  renderRatingTrend(feed);

  // ── Watched by month accordion (server data) ──
  $("watchedStatsList").innerHTML = renderWatchedStatsByYear(watchedByMonth);

  // ── Sub-genre cloud (computed from feed) ──
  renderSubGenreCloud(feed);

  applyDashboardVisibility();
}

// ── Rating donut ──
function renderRatingDonut(feed) {
  const counts = [0, 0, 0, 0, 0];
  feed.forEach((p) => {
    const r = Number(p.rating || 0);
    if (r >= 1 && r <= 5) counts[r - 1]++;
  });

  // Legend
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

// ── Monthly bar chart (count or avg rating) ──
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

// ── Avg rating trend line ──
function renderRatingTrend(feed) {
  const monthly = computeMonthlyAvgRating(feed);
  const labels  = monthly.map(({ month }) => {
    const [y, mo] = month.split("-").map(Number);
    return new Date(y, mo - 1, 1).toLocaleDateString("en-PH", { month: "short", year: "2-digit" });
  });
  const data = monthly.map(({ avg }) => avg);

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
        pointRadius: 4,
        fill: true,
        tension: 0.35,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          min: 1,
          max: 5,
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

// ── Streak rows ──
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

// ── Sub-genre cloud ──
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
// DASHBOARD TAB SWITCH (exposed globally for onclick)
// ─────────────────────────────────────────
function switchDashboardTab(mode) {
  state.dashboardMonthTab = mode;

  const tabCount  = $("tabCount");
  const tabRating = $("tabRating");
  if (tabCount)  tabCount.classList.toggle("active",  mode === "count");
  if (tabRating) tabRating.classList.toggle("active", mode === "rating");

  renderMonthlyChart(state.feed);
}
// Make it available globally for the onclick attribute in HTML
window.switchDashboardTab = switchDashboardTab;

// ─────────────────────────────────────────
// GENRE STATS (server data, bar style)
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
// TOP RATED ACCORDION (server data)
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
// WATCHED BY MONTH ACCORDION (server data)
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
  if (event.key === "Enter") { event.preventDefault(); handleAddSubGenre(); }
}

async function handleAddSubGenre() {
  const input = $("subGenreInput");
  const value = input?.value.trim() || "";
  if (!value) return;

  const exists = (state.subGenres || []).some(
    (item) => (item.name || "").trim().toLowerCase() === value.toLowerCase()
  );

  if (exists) { showAlert(`"${value}" already exists in sub-genres.`, "warning"); return; }

  try {
    await withLoading(() => api("addSubGenre", getSessionToken(), value))();
    input.value = "";
    if ($("subGenreSearch")) $("subGenreSearch").value = "";
    await refreshFeed();
    showAlert("Sub-genre added successfully.", "success");
  } catch (error) {
    showAlert(error.message, "danger");
  }
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

function toggleSidebar() {
  const content    = $("sidebarContent");
  const btn        = $("toggleSidebarBtn");
  const headerCard = $("toolsHeaderCard");
  if (!content || !btn) return;
  const isHidden = content.classList.toggle("d-none");
  const visible  = !isHidden;
  if (headerCard) headerCard.classList.toggle("d-none", !visible);
  btn.textContent = isHidden ? "Show Tools" : "Hide Tools";
  localStorage.setItem(TOOLS_STORAGE_KEY, String(visible));
  const toggle = $("toolsToggle");
  if (toggle) toggle.setAttribute("aria-checked", String(visible));
}

function applyDashboardVisibility() {
  const content = $("dashboardContent");
  const btn     = $("toggleDashboardBtn");
  if (!content || !btn) return;

  content.classList.toggle("d-none", state.dashboardHidden);
  btn.textContent = state.dashboardHidden ? "Show Dashboard" : "Hide Dashboard";
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
  dropdown?.classList.toggle("open", state.notifOpen);
  if (state.notifOpen) markNotificationsRead();
}

function closeNotifications() {
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

  // Bell badge
  notifBadge.textContent = String(unreadCount);
  notifBadge.classList.toggle("d-none", unreadCount === 0);

  // Panel header badge
  if (notifPanelBadge) {
    notifPanelBadge.textContent = unreadCount > 0
      ? `${unreadCount} unread`
      : "0 unread";
    notifPanelBadge.classList.toggle("is-empty", unreadCount === 0);
  }

  // Toggle button state — "Show unread" / "Show all"
  const showingUnread = state.notifShowUnreadOnly || false;
  if (toggleBtn) {
    toggleBtn.textContent = showingUnread ? "Show all" : `Unread (${unreadCount})`;
    toggleBtn.classList.toggle("is-active", showingUnread);

    toggleBtn.onclick = () => {
      state.notifShowUnreadOnly = !state.notifShowUnreadOnly;
      renderNotifications();
    };
  }

  // Filter list
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

    resetPostForm();
    await refreshFeed();
  } catch (error) {
    showAlert(error.message, "danger");
  } finally {
    toggleButton(submitBtn, false);
  }
}

// ─────────────────────────────────────────
// RENDER FEED
// ─────────────────────────────────────────
function renderFeed(feed) {
  const feedList       = $("feedList");
  const emptyFeed      = $("emptyFeed");
  const feedCountBadge = $("feedCountBadge");
  if (!feedList || !emptyFeed || !feedCountBadge) return;

  feedList.innerHTML = "";
  feedCountBadge.textContent = `${feed.length} post${feed.length !== 1 ? "s" : ""}`;
  emptyFeed.classList.toggle("d-none", feed.length > 0);

  feed.forEach((post) => feedList.appendChild(renderPostCard(post)));
}

function renderPostCard(post) {
  const card        = document.createElement("div");
  card.className    = "glass-card post-card p-4 mb-4";
  card.setAttribute("data-post-id", post.postId);

  const canEditPost    = state.currentUser && state.currentUser.username === post.username;
  const subGenrePills  = (post.subGenres || [])
    .map((sg) => `<span class="meta-pill">${escapeHtml(sg)}</span>`)
    .join("");

  card.innerHTML = `
    <div class="d-flex justify-content-between gap-3 flex-wrap">
      <div class="d-flex gap-3 align-items-start">
        ${post.avatar
          ? `<img src="${escapeHtml(post.avatar)}" class="avatar-img" alt="avatar">`
          : `<div class="avatar-fallback"><i class="bi bi-person-fill"></i></div>`}
        <div>
          <div class="fw-bold">${escapeHtml(post.name || post.username)}</div>
          <div class="text-secondary-light small" hidden>@${escapeHtml(post.username)}</div>
          <div class="text-secondary-light small mt-1">${formatDateTime(post.createdAt)}</div>
          ${post.updatedAt && post.updatedAt !== post.createdAt
            ? `<div class="text-secondary-light small mt-1" style="color: wheat; font-size: .70rem !important;">
                Last edited ${formatDateTime(post.updatedAt)}
               </div>`
            : ""}
        </div>
      </div>
      ${canEditPost
        ? `<div class="d-flex gap-2">
             <button class="btn btn-sm btn-warning-soft edit-post-btn align-self-start" type="button">
               <i class="bi bi-pencil-square"></i>
             </button>
             <button class="btn btn-sm btn-danger-soft delete-post-btn align-self-start" type="button">
               <i class="bi bi-trash"></i>
             </button>
           </div>`
        : ""}
    </div>

    <div class="mt-4">
      <h3 class="h4 fw-bold mb-2">${escapeHtml(post.movieName)}</h3>
      <div class="post-meta mb-3">
        <span class="meta-pill meta-pill-genre">${escapeHtml(post.genre || "-")}</span>
        ${subGenrePills}
        <span class="meta-pill">${renderStars(post.rating)}</span>
        <span class="meta-pill">${escapeHtml(post.duration || "-")}</span>
        <span class="meta-pill">Watched: ${formatDate(post.dateWatched)}</span>
      </div>
      ${post.caption ? `<p class="post-caption mb-0">${escapeHtml(post.caption)}</p>` : ""}
    </div>

    <hr class="custom-divider">

    <div class="comments-wrap">
      <h4 class="h6 fw-bold mb-3">
        <i class="bi bi-chat-dots me-2"></i>Comments (${post.comments.length})
      </h4>
      <div class="comments-list mb-3"></div>
      <form class="comment-form d-flex gap-2">
        <input type="text" class="form-control custom-input comment-input" placeholder="Write a comment..." required>
        <button type="submit" class="btn btn-primary custom-btn comment-btn">
          <i class="bi bi-send"></i>
        </button>
      </form>
    </div>
  `;

  const commentsList = card.querySelector(".comments-list");
  if (!post.comments.length) {
    commentsList.innerHTML = `<div class="text-secondary-light small">No comments yet.</div>`;
  } else {
    post.comments.forEach((comment) => commentsList.appendChild(renderCommentItem(comment)));
  }

  bindPostCardEvents(card, post, canEditPost);
  return card;
}

function renderCommentItem(comment) {
  const item = document.createElement("div");
  item.className = "comment-item";

  const canDeleteComment = state.currentUser && state.currentUser.username === comment.username;
  item.innerHTML = `
    <div class="d-flex justify-content-between gap-3">
      <div class="d-flex gap-2">
        ${comment.avatar
          ? `<img src="${escapeHtml(comment.avatar)}" class="comment-avatar" alt="avatar">`
          : `<div class="comment-avatar fallback"><i class="bi bi-person-fill"></i></div>`}
        <div>
          <div class="small fw-semibold">${escapeHtml(comment.name || comment.username)}</div>
          <div class="small text-secondary-light smx-font">${escapeHtml(comment.comment)}</div>
          <div class="small smx-font mt-1">${formatDateTime(comment.createdAt)}</div>
        </div>
      </div>
      ${canDeleteComment
        ? `<button class="btn btn-sm btn-link text-danger delete-comment-btn p-3 align-self-center" type="button" data-comment-id="${escapeHtml(comment.commentId)}">
             <i class="bi bi-x-circle lgx-font"></i>
           </button>`
        : ""}
    </div>
  `;
  return item;
}

function bindPostCardEvents(card, post, canEditPost) {
  const commentForm  = card.querySelector(".comment-form");
  const commentInput = card.querySelector(".comment-input");

  commentForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text      = commentInput.value.trim();
    const submitBtn = commentForm.querySelector("button[type='submit']");
    if (!text) return;

    try {
      toggleButton(submitBtn, true);
      await withLoading(() => api("addComment", getSessionToken(), post.postId, text))();
      commentInput.value = "";
      showAlert("Comment posted successfully.", "success");
      await refreshFeed();
    } catch (error) {
      showAlert(error.message, "danger");
    } finally {
      toggleButton(submitBtn, false);
    }
  });

  card.querySelectorAll(".delete-comment-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const commentId = btn.dataset.commentId;
      try {
        toggleButton(btn, true);
        await withLoading(() => api("deleteComment", getSessionToken(), commentId))();
        showAlert("Comment deleted successfully.", "success");
        await refreshFeed();
      } catch (error) {
        showAlert(error.message, "danger");
      } finally {
        toggleButton(btn, false);
      }
    });
  });

  if (!canEditPost) return;

  card.querySelector(".edit-post-btn")?.addEventListener("click", () => startEdit(post));

  card.querySelector(".delete-post-btn")?.addEventListener("click", async (event) => {
    if (!confirm(`Delete post for "${post.movieName}"?`)) return;
    const btn = event.currentTarget;
    try {
      toggleButton(btn, true);
      await withLoading(() => api("deletePost", getSessionToken(), post.postId))();
      showAlert("Post deleted successfully.", "success");
      await refreshFeed();
    } catch (error) {
      showAlert(error.message, "danger");
    } finally {
      toggleButton(btn, false);
    }
  });
}

// ─────────────────────────────────────────
// SUB-GENRE CHECKBOXES / PREVIEW (sidebar)
// ─────────────────────────────────────────
function getSelectedSubGenres() {
  return Array.from(document.querySelectorAll('input[name="subGenre"]:checked'))
    .map((input) => input.value.trim())
    .filter(Boolean);
}

function setSelectedSubGenres(values) {
  const selected = new Set(Array.isArray(values) ? values : []);
  document.querySelectorAll('input[name="subGenre"]').forEach((input) => {
    input.checked = selected.has(input.value);
  });
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

  const selected = new Set(getSelectedSubGenres());

  if (!state.subGenres.length) {
    group.innerHTML = `<div class="text-secondary-light small">No sub-genres available yet.</div>`;
    return;
  }

  group.innerHTML = state.subGenres.map((item) => `
    <label class="subgenre-chip">
      <input type="checkbox" name="subGenre" value="${escapeHtml(item.name)}" ${selected.has(item.name) ? "checked" : ""}>
      <span>${escapeHtml(item.name)}</span>
    </label>
  `).join("");
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

    // Force-open the tools sidebar if it's hidden
  const content = $("sidebarContent");
  const btn     = $("toggleSidebarBtn");
  if (content && content.classList.contains("d-none")) {  // ← add
    content.classList.remove("d-none");                   // ← add
    if (btn) btn.textContent = "Hide Tools";              // ← add
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetPostForm() {
  state.isEditing = false;
  $("postForm")?.reset();
  $("postId").value = "";
  setSelectedSubGenres([]);
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

function formatDateTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-PH", { year:"numeric", month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
}
function normalizeDateWatched(raw) {
  if (!raw) return "";
  const d = new Date(raw); // handles Date objects, ISO strings, and full date strings
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// function normalizeDateForInput(value) {
//   if (!value) return "";
//   if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
//   const d = new Date(value);
//   if (Number.isNaN(d.getTime())) return "";
//   return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
// }
function normalizeDateForInput(value) {
  if (!value) return "";
  return normalizeDateWatched(value); // reuse the same logic
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
