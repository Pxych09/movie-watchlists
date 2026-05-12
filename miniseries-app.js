// ─────────────────────────────────────────
// CONFIG  (reuse the same Apps Script URL)
// ─────────────────────────────────────────
window.APP_CONFIG = window.APP_CONFIG || {};
const API_URL = window.APP_CONFIG.API_URL ||
  "https://script.google.com/macros/s/AKfycbzPER-flrF1jIbkicpGHELNLmWbqob2q6_ACSHV3eRMR_fgBlml2TsKne8xPcQTxnPPbg/exec";

const STORAGE_KEY = "movieFeedUser";

// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────
const state = {
  currentUser: null,
  series: [],            // [{seriesId, username, name, title, genre, numSeasons, seasonEpisodes, createdAt}]
  episodes: {},          // episodeKey(seriesId,season,ep) → {remarks,duration,rating,dateWatched,savedAt}
  pendingChanges: {},
  alertTimers: new Map(),
  loadingCount: 0,
};

// ─────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  restoreSession();
});

function bindEvents() {
  $("loginForm")?.addEventListener("submit", handleLogin);
  $("logoutBtn")?.addEventListener("click", handleLogout);
  $("createSeriesForm")?.addEventListener("submit", handleCreateSeries);
  $("seriesSearch")?.addEventListener("input", renderSeriesList);
  $("seriesFilter")?.addEventListener("change", renderSeriesList);

  // Step 1: wire the "Set Episodes" button
  $("buildSeasonsBtn")?.addEventListener("click", handleBuildSeasons);

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

  // Info tooltips
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".info-tip-btn");
    if (btn) {
      e.stopPropagation();
      const box = btn.nextElementSibling;
      const isOpen = box.classList.contains("open");
      document.querySelectorAll(".info-tip-box.open").forEach(b => b.classList.remove("open"));
      if (!isOpen) box.classList.add("open");
      return;
    }
    if (!e.target.closest(".info-tip-wrap")) {
      document.querySelectorAll(".info-tip-box.open").forEach(b => b.classList.remove("open"));
    }
  });
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function epKey(seriesId, season, ep) { return `${seriesId}::s${season}::e${ep}`; }

/**
 * Get the episode count for a specific season.
 * Works with both old data (flat numEpisodes) and new (seasonEpisodes map).
 */
function getEpsForSeason(series, season) {
  if (series.seasonEpisodes) {
    const map = typeof series.seasonEpisodes === "string"
      ? JSON.parse(series.seasonEpisodes)
      : series.seasonEpisodes;
    return parseInt(map[season] ?? map[String(season)] ?? series.numEpisodes ?? 1, 10);
  }
  return parseInt(series.numEpisodes ?? 1, 10);
}

/**
 * Get the custom title for a season, falling back to "Season N".
 * Works with both stored seasonTitles JSON and a plain object.
 */
function getSeasonLabel(series, season) {
  if (series.seasonTitles) {
    const map = typeof series.seasonTitles === "string"
      ? JSON.parse(series.seasonTitles)
      : series.seasonTitles;
    const custom = (map[season] ?? map[String(season)] ?? "").trim();
    if (custom) return custom;
  }
  return `Season ${season}`;
}

/**
 * Build the seasonEpisodes map from the dynamic form inputs.
 * Accepts an optional container element; defaults to global #seasonEpisodesList.
 * Returns an object like { "1": 16, "2": 20, "3": 12 }
 */
function readSeasonEpisodesFromForm(container) {
  const list = container || $("seasonEpisodesList");
  if (!list) return null;
  const inputs = list.querySelectorAll(".season-ep-input");
  if (!inputs.length) return null;
  const map = {};
  inputs.forEach(input => {
    const s   = input.dataset.season;
    const val = parseInt(input.value, 10);
    map[s]    = isNaN(val) || val < 1 ? 1 : val;
  });
  return map;
}

/**
 * Build the seasonTitles map from the dynamic form title inputs.
 * Returns null if the toggle is off or no inputs exist.
 * Returns an object like { "1": "The Beginning", "2": "" }
 */
function readSeasonTitlesFromForm(container) {
  const list = container || $("seasonEpisodesList");
  if (!list) return null;
  const inputs = list.querySelectorAll(".season-title-input");
  if (!inputs.length) return null;
  const map = {};
  inputs.forEach(input => {
    const s = input.dataset.season;
    map[s]  = input.value.trim();
  });
  return map;
}

// ─────────────────────────────────────────
// API
// ─────────────────────────────────────────
async function api(method, ...args) {
  const body = new URLSearchParams({ method, args: JSON.stringify(args) });
  const res  = await fetch(API_URL, { method: "POST", body });
  const text = await res.text();
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  let result;
  try { result = JSON.parse(text); } catch { throw new Error("Backend did not return valid JSON."); }
  if (!result.ok) throw new Error(result.error || "Something went wrong.");
  return result.data;
}

// ─────────────────────────────────────────
// OVERLAY / LOADING
// ─────────────────────────────────────────
function showOverlay(show) {
  state.loadingCount += show ? 1 : -1;
  state.loadingCount  = Math.max(0, state.loadingCount);
  $("loadingOverlay")?.classList.toggle("d-none", state.loadingCount === 0);
}

async function withLoading(fn) {
  try { showOverlay(true); return await fn(); }
  finally { showOverlay(false); }
}

function toggleBtn(btn, disabled) {
  if (!btn) return;
  btn.disabled = disabled;
  btn.setAttribute("aria-disabled", String(disabled));
}

// ─────────────────────────────────────────
// ALERTS
// ─────────────────────────────────────────
function showAlert(message, type = "danger", duration = 5000) {
  const wrap = $("globalAlertWrap");
  if (!wrap) return;
  const id  = `alert-${Date.now()}`;
  const el  = document.createElement("div");
  el.id        = id;
  el.className = `alert alert-${type} alert-dismissible fade show`;
  el.role      = "alert";
  el.innerHTML = `<div class="d-flex align-items-start justify-content-between gap-3">
    <div>${escapeHtml(message)}</div>
    <button type="button" class="btn-close ${type === "success" ? "" : "btn-close-white"}" aria-label="Close"></button>
  </div>`;
  el.querySelector(".btn-close")?.addEventListener("click", () => removeAlert(id));
  wrap.appendChild(el);
  const timer = setTimeout(() => removeAlert(id), duration);
  state.alertTimers.set(id, timer);
}

function removeAlert(id) {
  const el = document.getElementById(id);
  if (!el) return;
  clearTimeout(state.alertTimers.get(id));
  state.alertTimers.delete(id);
  el.classList.remove("show");
  setTimeout(() => el.remove(), 200);
}

// ─────────────────────────────────────────
// SECTIONS
// ─────────────────────────────────────────
function showSection(loggedIn) {
  $("loginSection")?.classList.toggle("d-none",  loggedIn);
  $("appSection")?.classList.toggle("d-none",  !loggedIn);
}

function setProfile(user) {
  if ($("displayName")) $("displayName").textContent = user?.name || user?.username || "User";
}

// ─────────────────────────────────────────
// SESSION
// ─────────────────────────────────────────
function saveSession(user) { localStorage.setItem(STORAGE_KEY, JSON.stringify(user)); }
function clearSession()    { localStorage.removeItem(STORAGE_KEY); }
function token()           { return state.currentUser?.sessionToken || ""; }

async function restoreSession() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) { showSection(false); return; }
  try {
    state.currentUser = JSON.parse(saved);
    setProfile(state.currentUser);
    showSection(true);
    await refresh();
  } catch {
    clearSession();
    state.currentUser = null;
    showSection(false);
  }
}

// ─────────────────────────────────────────
// LOGIN / LOGOUT
// ─────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  const username = $("loginUsername")?.value.trim() || "";
  const password = $("loginPassword")?.value.trim() || "";
  const btn      = e.submitter;
  try {
    toggleBtn(btn, true);
    const user = await withLoading(() => api("login", username, password));
    state.currentUser = user;
    saveSession(user);
    setProfile(user);
    showSection(true);
    await refresh();
    showAlert(`Welcome, ${user.name || user.username}!`, "success");
  } catch (err) {
    showAlert(err.message, "danger");
  } finally {
    toggleBtn(btn, false);
  }
}

async function handleLogout() {
  try { if (token()) await api("logout", token()); } catch {}
  state.currentUser    = null;
  state.series         = [];
  state.episodes       = {};
  state.pendingChanges = {};
  clearSession();
  $("loginForm")?.reset();
  resetSeasonBuilder();
  if ($("seriesList")) $("seriesList").innerHTML = "";
  showSection(false);
}

// ─────────────────────────────────────────
// REFRESH
// ─────────────────────────────────────────
async function refresh() {
  if (!state.currentUser) return;
  showSkeletons();
  try {
    const [series, episodes] = await Promise.all([
      api("getSeries",   token()),
      api("getEpisodes", token()),
    ]);

    state.series = Array.isArray(series) ? series : [];

    // Index episodes: key → episode data
    state.episodes = {};
    (Array.isArray(episodes) ? episodes : []).forEach((ep) => {
      const k = epKey(ep.seriesId, ep.season, ep.episode);
      state.episodes[k] = ep;
    });

    updateStats();
    renderSeriesList();
  } catch (err) {
    showAlert(err.message, "danger");
    if (/session expired/i.test(err.message)) await handleLogout();
  }
}

// ─────────────────────────────────────────
// SKELETONS
// ─────────────────────────────────────────
function showSkeletons() {
  const list = $("seriesList");
  if (list) {
    list.innerHTML = [1,2,3].map(() => `<div class="skel skel-series-card"></div>`).join("");
  }
  $("emptySeriesState")?.classList.add("d-none");
}

// ─────────────────────────────────────────
// STATS
// ─────────────────────────────────────────
function updateStats() {
  const totalSeries   = state.series.length;
  const allEpisodes   = Object.values(state.episodes);
  const totalLogged   = allEpisodes.length;
  const rated         = allEpisodes.filter(ep => ep.rating > 0);
  const avgRating     = rated.length
    ? (rated.reduce((s, ep) => s + Number(ep.rating), 0) / rated.length).toFixed(1)
    : "—";

  if ($("statTotalSeries"))   $("statTotalSeries").textContent   = totalSeries;
  if ($("statTotalEpisodes")) $("statTotalEpisodes").textContent = totalLogged;
  if ($("statAvgRating"))     $("statAvgRating").textContent     = avgRating !== "—" ? avgRating + " ★" : "—";
}

// ─────────────────────────────────────────
// SEASON BUILDER  (Step 1 → Step 2)
// Global version for the create form
// ─────────────────────────────────────────
function handleBuildSeasons() {
  const numSeasons = parseInt($("numSeasons")?.value, 10);
  if (!numSeasons || numSeasons < 1 || numSeasons > 50) {
    showAlert("Please enter a valid number of seasons (1–50).", "warning");
    return;
  }

  const list = $("seasonEpisodesList");
  const wrap = $("seasonEpisodesWrap");
  if (!list || !wrap) return;

  const titlesEnabled = $("enableSeasonTitles")?.checked || false;

  list.innerHTML = "";

  for (let s = 1; s <= numSeasons; s++) {
    list.appendChild(buildSeasonEpRow(s, 12, false, titlesEnabled));
  }

  wrap.style.display = "block";
  wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function resetSeasonBuilder() {
  const list = $("seasonEpisodesList");
  const wrap = $("seasonEpisodesWrap");
  if (list) list.innerHTML = "";
  if (wrap) wrap.style.display = "none";
  if ($("numSeasons")) $("numSeasons").value = "";
  if ($("enableSeasonTitles")) $("enableSeasonTitles").checked = false;
}

/**
 * Build a single season-episode row DOM element.
 * @param {number} s - Season number
 * @param {number} [defaultVal=12] - Pre-filled episode count
 * @param {boolean} [readOnly=false] - Whether the input should be disabled
 * @param {boolean} [showTitleInput=false] - Whether to show the season title input
 * @param {string}  [defaultTitle=""] - Pre-filled title value
 */
function buildSeasonEpRow(s, defaultVal = 12, readOnly = false, showTitleInput = false, defaultTitle = "") {
  const row = document.createElement("div");
  row.className = "season-ep-row";
  row.innerHTML = `
    <div class="season-ep-label">
      <span class="season-ep-badge">S${s}</span>
      <span>Season ${s}</span>
      ${readOnly ? `<span class="season-ep-readonly-tag">Existing</span>` : ""}
    </div>
    <div class="season-ep-input-wrap">
      <input
        type="number"
        class="ep-input season-ep-input"
        data-season="${s}"
        min="1" max="200"
        placeholder="Episodes"
        value="${defaultVal}"
        ${readOnly ? "disabled" : "required"}
      >
      <span class="season-ep-unit">eps</span>
    </div>
    ${showTitleInput && !readOnly ? `
    <div class="season-title-input-wrap">
      <input
        type="text"
        class="ep-input season-title-input"
        data-season="${s}"
        maxlength="80"
        placeholder="Season title (optional)"
        value="${escapeHtml(defaultTitle)}"
      >
    </div>` : ""}
  `;
  return row;
}

// ─────────────────────────────────────────
// CREATE SERIES
// ─────────────────────────────────────────
async function handleCreateSeries(e) {
  e.preventDefault();
  const title      = $("seriesTitle")?.value.trim() || "";
  const genre      = $("seriesGenre")?.value || "";
  const numSeasons = parseInt($("numSeasons")?.value, 10) || 0;
  const btn        = e.submitter;

  if (!title || !genre || !numSeasons) {
    showAlert("Please fill in title, genre, and season count.", "danger");
    return;
  }

  // Read per-season episode map
  const seasonEpisodesMap = readSeasonEpisodesFromForm();
  if (!seasonEpisodesMap) {
    showAlert('Click "Set Episodes" first to configure episodes per season.', "warning");
    return;
  }

  // Validate each season has at least 1 episode
  for (let s = 1; s <= numSeasons; s++) {
    const eps = parseInt(seasonEpisodesMap[s], 10);
    if (!eps || eps < 1) {
      showAlert(`Season ${s} must have at least 1 episode.`, "warning");
      return;
    }
  }

  // Read optional season titles
  const seasonTitlesMap  = readSeasonTitlesFromForm();
  const seasonTitlesJson = seasonTitlesMap ? JSON.stringify(seasonTitlesMap) : "";

  // Compute total episodes for backward compat
  const totalEpisodes = Object.values(seasonEpisodesMap).reduce((sum, n) => sum + parseInt(n, 10), 0);
  const seasonEpisodesJson = JSON.stringify(seasonEpisodesMap);

  try {
    toggleBtn(btn, true);
    await withLoading(() =>
      api("createSeries", token(), title, genre, numSeasons, totalEpisodes, seasonEpisodesJson, seasonTitlesJson)
    );
    $("createSeriesForm").reset();
    resetSeasonBuilder();
    await refresh();
    showAlert(`"${title}" created successfully!`, "success");
  } catch (err) {
    showAlert(err.message, "danger");
  } finally {
    toggleBtn(btn, false);
  }
}

// ─────────────────────────────────────────
// DELETE SERIES
// ─────────────────────────────────────────
async function handleDeleteSeries(seriesId, title) {
  if (!confirm(`Delete "${title}" and all its episode data? This cannot be undone.`)) return;
  try {
    await withLoading(() => api("deleteSeries", token(), seriesId));
    await refresh();
    showAlert("Series deleted.", "success");
  } catch (err) {
    showAlert(err.message, "danger");
  }
}

// ─────────────────────────────────────────
// EDIT SERIES — inline form inside the card
// ─────────────────────────────────────────

/**
 * Toggle the inline edit form for a series card.
 * If already open, collapses it. If closed, expands it.
 */
function handleEditSeries(seriesId) {
  const card = document.querySelector(`.series-card[data-series-id="${seriesId}"]`);
  if (!card) return;

  // If edit form already open, cancel/collapse it
  const existing = card.querySelector(".series-edit-form-wrap");
  if (existing) {
    existing.remove();
    card.querySelector(".edit-series-btn")?.classList.remove("active");
    return;
  }

  const series = state.series.find(s => s.seriesId === seriesId);
  if (!series) return;

  // Mark button as active
  card.querySelector(".edit-series-btn")?.classList.add("active");

  const wrap = document.createElement("div");
  wrap.className = "series-edit-form-wrap";
  wrap.innerHTML = `
    <div class="series-edit-form">
      <div class="series-edit-title">
        <i class="bi bi-pencil-square me-2"></i>Edit Series
      </div>

      <div class="series-edit-field">
        <label class="form-label">Series Title</label>
        <input
          type="text"
          class="ep-input series-edit-title-input"
          value="${escapeHtml(series.title)}"
          placeholder="Series title"
          maxlength="200"
        >
      </div>

      <div class="series-edit-field">
        <label class="form-label">Current Seasons</label>
        <div class="series-edit-readonly">
          <i class="bi bi-collection me-2" style="opacity:.5"></i>
          ${series.numSeasons} season${series.numSeasons !== 1 ? "s" : ""} (cannot be reduced)
        </div>
      </div>

      <div class="series-edit-field">
        <label class="form-label">New Total Season Count</label>
        <div class="d-flex gap-2">
          <input
            type="number"
            class="ep-input series-edit-seasons-input"
            min="${series.numSeasons + 1}"
            max="50"
            placeholder="e.g. ${series.numSeasons + 1}"
            style="max-width:120px"
          >
          <button type="button" class="btn ms-btn-outline series-edit-build-btn smx-font" style="white-space:nowrap">
            <i class="bi bi-arrow-right-circle me-1"></i>Set New Episodes
          </button>
        </div>
        <div class="form-text" style="color:var(--muted);font-size:.75rem;margin-top:.35rem;">
          Only values greater than ${series.numSeasons} are allowed. Leave blank if you only want to update the title.
        </div>
      </div>

      <div class="series-edit-new-seasons-wrap" style="display:none;">
        <label class="form-label mb-2">Episodes for New Seasons</label>
        <div class="season-ep-builder series-edit-new-seasons-list"></div>
      </div>

      <div class="series-edit-actions">
        <button type="button" class="btn ms-btn-outline series-edit-cancel-btn">
          <i class="bi bi-x me-1"></i>Cancel
        </button>
        <button type="button" class="btn ms-btn-save series-edit-save-btn">
          <i class="bi bi-floppy me-1"></i>Save Changes
        </button>
      </div>
    </div>
  `;

  // Wire "Set New Episodes" button
  const buildBtn = wrap.querySelector(".series-edit-build-btn");
  buildBtn.addEventListener("click", () => {
    const seasonsInput = wrap.querySelector(".series-edit-seasons-input");
    const newTotal     = parseInt(seasonsInput.value, 10);

    if (!newTotal || newTotal <= series.numSeasons || newTotal > 50) {
      showAlert(`New season count must be between ${series.numSeasons + 1} and 50.`, "warning");
      return;
    }

    const listEl = wrap.querySelector(".series-edit-new-seasons-list");
    const wrapEl = wrap.querySelector(".series-edit-new-seasons-wrap");
    listEl.innerHTML = "";

    // Show read-only rows for existing seasons first (visual context)
    for (let s = 1; s <= series.numSeasons; s++) {
      const existingEps = getEpsForSeason(series, s);
      listEl.appendChild(buildSeasonEpRow(s, existingEps, true, false));
    }

    // Editable inputs for new seasons only
    for (let s = series.numSeasons + 1; s <= newTotal; s++) {
      listEl.appendChild(buildSeasonEpRow(s, 12, false, false));
    }

    wrapEl.style.display = "block";
    wrapEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  // Wire Cancel
  wrap.querySelector(".series-edit-cancel-btn").addEventListener("click", () => {
    wrap.remove();
    card.querySelector(".edit-series-btn")?.classList.remove("active");
  });

  // Wire Save
  wrap.querySelector(".series-edit-save-btn").addEventListener("click", () => {
    handleSaveEditSeries(seriesId, wrap, series);
  });

  // Insert the edit form after the card header / progress bar, before the seasons accordion
  const seasonsWrap = card.querySelector(".seasons-wrap");
  card.insertBefore(wrap, seasonsWrap);
}

/**
 * Read the edit form, call the backend, patch state, and re-render.
 */
async function handleSaveEditSeries(seriesId, formWrap, series) {
  const saveBtn      = formWrap.querySelector(".series-edit-save-btn");
  const newTitle     = formWrap.querySelector(".series-edit-title-input")?.value.trim() || "";
  const seasonsInput = formWrap.querySelector(".series-edit-seasons-input");
  const newTotal     = parseInt(seasonsInput?.value, 10);

  if (!newTitle) {
    showAlert("Series title cannot be empty.", "warning");
    return;
  }

  // Determine if user is adding seasons
  const addingSeasons = !isNaN(newTotal) && newTotal > series.numSeasons;

  // If a season count was entered, it must be valid
  if (seasonsInput.value.trim() !== "" && !addingSeasons) {
    showAlert(`New season count must be greater than ${series.numSeasons}.`, "warning");
    return;
  }

  let newSeasonEpisodesJson = null;

  if (addingSeasons) {
    // Read only the NEW season inputs (not the disabled existing ones)
    const newSeasonsListEl = formWrap.querySelector(".series-edit-new-seasons-list");
    const allInputs        = newSeasonsListEl
      ? [...newSeasonsListEl.querySelectorAll(".season-ep-input:not([disabled])")]
      : [];

    if (!allInputs.length) {
      showAlert('Click "Set New Episodes" first to configure episodes for the new seasons.', "warning");
      return;
    }

    // Validate
    const newMap = {};
    for (const input of allInputs) {
      const s   = input.dataset.season;
      const val = parseInt(input.value, 10);
      if (!val || val < 1) {
        showAlert(`Season ${s} must have at least 1 episode.`, "warning");
        return;
      }
      newMap[s] = val;
    }

    newSeasonEpisodesJson = JSON.stringify(newMap);
  }

  const finalNumSeasons = addingSeasons ? newTotal : series.numSeasons;

  try {
    toggleBtn(saveBtn, true);
    const updated = await withLoading(() =>
      api("updateSeries", token(), seriesId, newTitle, finalNumSeasons, newSeasonEpisodesJson || "")
    );

    // Patch local state
    const idx = state.series.findIndex(s => s.seriesId === seriesId);
    if (idx !== -1) {
      state.series[idx] = {
        ...state.series[idx],
        title:          updated.title,
        numSeasons:     updated.numSeasons,
        numEpisodes:    updated.numEpisodes,
        seasonEpisodes: updated.seasonEpisodes,
      };
    }

    // Re-render the card in place
    const card    = document.querySelector(`.series-card[data-series-id="${seriesId}"]`);
    const newCard = buildSeriesCard(state.series[idx]);
    card.replaceWith(newCard);

    updateStats();
    showAlert(`"${updated.title}" updated successfully!`, "success");
  } catch (err) {
    showAlert(err.message, "danger");
  } finally {
    toggleBtn(saveBtn, false);
  }
}

// ─────────────────────────────────────────
// RENDER SERIES LIST
// ─────────────────────────────────────────
function renderSeriesList() {
  const list    = $("seriesList");
  const empty   = $("emptySeriesState");
  const badge   = $("seriesCountBadge");
  const query   = ($("seriesSearch")?.value || "").trim().toLowerCase();
  const filter  = $("seriesFilter")?.value || "all";
  if (!list) return;

  let items = [...state.series];
  if (filter === "mine") items = items.filter(s => s.username === state.currentUser?.username);
  if (query)             items = items.filter(s => (s.title + s.genre).toLowerCase().includes(query));

  if (badge) badge.textContent = `${items.length} series`;
  empty?.classList.toggle("d-none", items.length > 0);
  list.innerHTML = "";

  if (!items.length && !state.series.length) {
    empty?.classList.remove("d-none");
    return;
  }

  items.forEach(series => list.appendChild(buildSeriesCard(series)));
}

// ─────────────────────────────────────────
// BUILD SERIES CARD
// ─────────────────────────────────────────
function buildSeriesCard(series) {
  const { seriesId, title, genre, numSeasons, username, name, createdAt } = series;
  const isMine = state.currentUser?.username === username;

  // Progress computation — uses per-season counts
  const totalEpSlots  = countTotalEpisodeSlots(series);
  const savedEpCount  = countSavedEpisodes(series);
  const pct           = totalEpSlots > 0 ? Math.round((savedEpCount / totalEpSlots) * 100) : 0;

  // Build a summary like "16 / 20 / 12 eps"
  const epSummary = buildEpSummary(series);

  const card = document.createElement("div");
  card.className = "series-card";
  card.dataset.seriesId = seriesId;

  card.innerHTML = `
    <div class="series-card-header">
      <div class="series-title-wrap">
        <div class="series-title">${escapeHtml(title)}</div>
        <div class="series-meta-pills">
          <span class="ms-pill ms-pill-genre">${escapeHtml(genre)}</span>
          <span class="ms-pill">${numSeasons} Season${numSeasons !== 1 ? "s" : ""}</span>
          <span class="ms-pill" title="${escapeHtml(createdAt)}">${formatDate(createdAt)}</span>
          <span class="ms-pill">by ${escapeHtml(name || username)}</span>
        </div>
      </div>
      ${isMine ? `
        <div class="series-card-actions">
          <button class="btn ms-btn-edit btn-sm edit-series-btn" type="button" title="Edit series">
            Edit
          </button>
          <button class="btn ms-btn-danger btn-sm delete-series-btn" type="button" title="Delete series">
            Delete
          </button>
        </div>` : ""}
    </div>

    <div class="series-progress-bar-wrap">
      <div class="series-progress-label">
        <span>${savedEpCount} / ${totalEpSlots} episodes logged</span>
        <span>${pct}%</span>
      </div>
      <div class="series-progress-track">
        <div class="series-progress-fill" style="width:${pct}%"></div>
      </div>
    </div>

    <div class="seasons-wrap">${buildSeasonsHTML(series)}</div>
  `;

  // Edit button
  card.querySelector(".edit-series-btn")?.addEventListener("click", () => handleEditSeries(seriesId));

  // Delete button
  card.querySelector(".delete-series-btn")?.addEventListener("click", () => handleDeleteSeries(seriesId, title));

  // Wire up season toggles
  card.querySelectorAll(".season-toggle:not(.is-locked)").forEach(btn => {
    btn.addEventListener("click", () => {
      const seasonItem = btn.closest(".season-item");
      const isOpen     = seasonItem.classList.toggle("open");
      btn.setAttribute("aria-expanded", String(isOpen));
      if (isOpen) ensureEpisodeInputsWired(seasonItem, series);
    });
  });

  // Wire "show more seasons" toggle
  wireShowMoreSeasons(card.querySelector(".seasons-wrap"));

  return card;
}

/**
 * Human-readable episode summary, e.g. "16 / 20 / 12 eps/season"
 * Falls back to "N eps/season" for uniform series.
 */
function buildEpSummary(series) {
  const { numSeasons } = series;
  if (!numSeasons) return "";

  const counts = [];
  for (let s = 1; s <= numSeasons; s++) {
    counts.push(getEpsForSeason(series, s));
  }

  // If all equal, short form
  const allSame = counts.every(c => c === counts[0]);
  if (allSame) return `${counts[0]} Ep/Season`;

  // Variable: show each season separated by "/"
  return counts.join(" / ") + " eps";
}

// ─────────────────────────────────────────
// BUILD SEASONS HTML
// ─────────────────────────────────────────
const SEASONS_VISIBLE_DEFAULT = 5;

function buildSeasonsHTML(series) {
  const { seriesId, numSeasons } = series;
  const hidden = numSeasons > SEASONS_VISIBLE_DEFAULT;
  let html = "";

  for (let s = 1; s <= numSeasons; s++) {
    const numEps = getEpsForSeason(series, s);
    const seasonLabel = getSeasonLabel(series, s);
    const { isLocked, isDone, savedCount } = getSeasonStatus(seriesId, s, numEps);
    const partial = !isDone && savedCount > 0;

    const badgeClass  = isDone ? "is-done" : isLocked ? "is-locked" : "";
    const toggleClass = isLocked ? "is-locked" : "";
    const hiddenClass = hidden && s > SEASONS_VISIBLE_DEFAULT ? " season-item-hidden" : "";

    let statusPill = "";
    if (isLocked)     statusPill = `<span class="season-status-pill locked"><i class="bi bi-lock-fill me-1"></i>Locked</span>`;
    else if (isDone)  statusPill = `<span class="season-status-pill done"><i class="bi bi-check-circle-fill me-1"></i>Done</span>`;
    else if (partial) statusPill = `<span class="season-status-pill partial">${savedCount}/${numEps} logged</span>`;
    else              statusPill = `<span class="season-status-pill empty">Not started</span>`;

    html += `
      <div class="season-item${hiddenClass}" data-series-id="${seriesId}" data-season="${s}" data-num-eps="${numEps}">
        <button type="button" class="season-toggle ${toggleClass}" aria-expanded="false"
          ${isLocked ? 'disabled title="Complete the previous season first"' : ""}>
          <div class="season-number-badge ${badgeClass}">S${s}</div>
          <div class="season-label smx-font" title="${escapeHtml(seasonLabel)}">${escapeHtml(seasonLabel)}</div>
          <div class="season-sub">${numEps} ep${numEps !== 1 ? "s" : ""}</div>
          ${statusPill}
          ${!isLocked ? `<i class="bi bi-chevron-down season-chevron"></i>` : `<i class="bi bi-lock season-chevron"></i>`}
        </button>
        <div class="season-panel" data-panel-season="${s}">
          <!-- episode cards injected here when opened -->
        </div>
      </div>`;
  }

  if (hidden) {
    const remaining = numSeasons - SEASONS_VISIBLE_DEFAULT;
    html += `
      <div class="seasons-show-more">
        <button type="button" class="seasons-show-more-btn">
          <i class="bi bi-chevron-down me-1"></i>
          Show ${remaining} more season${remaining !== 1 ? "s" : ""}
        </button>
      </div>`;
  }

  return html;
}

/**
 * Wire the "Show more / Show less" toggle for a seasons-wrap.
 * Called once per card after innerHTML is set.
 */
function wireShowMoreSeasons(seasonsWrap) {
  const btn = seasonsWrap.querySelector(".seasons-show-more-btn");
  if (!btn) return;

  const toggleRow = btn.closest(".seasons-show-more");
  let expanded = false;

  btn.addEventListener("click", () => {
    expanded = !expanded;
    seasonsWrap.querySelectorAll(".season-item-hidden").forEach(el => {
      el.classList.toggle("season-item-visible", expanded);
    });
    const remaining = seasonsWrap.querySelectorAll(".season-item-hidden").length;
    if (expanded) {
      btn.innerHTML = `<i class="bi bi-chevron-up me-1"></i>Show less`;
    } else {
      btn.innerHTML = `<i class="bi bi-chevron-down me-1"></i>Show ${remaining} more season${remaining !== 1 ? "s" : ""}`;
    }
    btn.classList.toggle("is-expanded", expanded);
  });
}

// ─────────────────────────────────────────
// SEASON STATUS  (accepts per-season numEps)
// ─────────────────────────────────────────
function getSeasonStatus(seriesId, season, numEps) {
  let savedCount = 0;
  for (let ep = 1; ep <= numEps; ep++) {
    if (state.episodes[epKey(seriesId, season, ep)]) savedCount++;
  }
  const isDone = savedCount === numEps;

  let isLocked = false;
  if (season > 1) {
    const series = state.series.find(s => s.seriesId === seriesId);
    const prevNumEps = series ? getEpsForSeason(series, season - 1) : numEps;
    isLocked = !getSeasonStatus(seriesId, season - 1, prevNumEps).isDone;
  }

  return { isLocked, isDone, savedCount };
}

function countTotalEpisodeSlots(series) {
  let total = 0;
  for (let s = 1; s <= series.numSeasons; s++) {
    total += getEpsForSeason(series, s);
  }
  return total;
}

function countSavedEpisodes(series) {
  let count = 0;
  for (let s = 1; s <= series.numSeasons; s++) {
    const numEps = getEpsForSeason(series, s);
    for (let ep = 1; ep <= numEps; ep++) {
      if (state.episodes[epKey(series.seriesId, s, ep)]) count++;
    }
  }
  return count;
}

// ─────────────────────────────────────────
// INJECT EPISODE CARDS INTO OPEN SEASON
// ─────────────────────────────────────────
function ensureEpisodeInputsWired(seasonItem, series) {
  const panel  = seasonItem.querySelector(".season-panel");
  if (!panel || panel.dataset.wired) return; // already built
  panel.dataset.wired = "1";

  const { seriesId } = series;
  const season    = parseInt(seasonItem.dataset.season, 10);
  const numEpisodes = parseInt(seasonItem.dataset.numEps, 10) || getEpsForSeason(series, season);

  // Build episode grid
  const grid = document.createElement("div");
  grid.className = "episode-grid";

  for (let ep = 1; ep <= numEpisodes; ep++) {
    const savedData = state.episodes[epKey(seriesId, season, ep)] || null;
    grid.appendChild(buildEpisodeCard(seriesId, season, ep, savedData));
  }
  panel.appendChild(grid);

  // Init duration pickers
  grid.querySelectorAll(".dp-wrap").forEach(wrap => {
    const saved = wrap.querySelector(".dp-trigger")?.dataset.value || "";
    initDurationPicker(wrap, saved);
  });

  // Save bar
  const saveBar = document.createElement("div");
  saveBar.className = "season-save-bar";
  saveBar.dataset.saveBar = `${seriesId}::${season}`;
  saveBar.innerHTML = `
    <span class="season-save-hint"><i class="bi bi-exclamation-circle me-1"></i>Unsaved changes</span>
    <button type="button" class="btn ms-btn-save save-season-btn">
      <i class="bi bi-floppy me-1"></i>Save Season ${season}
    </button>`;
  panel.appendChild(saveBar);

  // Save button handler
  saveBar.querySelector(".save-season-btn").addEventListener("click", () => {
    handleSaveSeason(seriesId, season, numEpisodes, seasonItem);
  });

  // Wire up change detection on all inputs
  grid.querySelectorAll(".ep-input").forEach(input => {
    input.addEventListener("input", () => {
      markEpisodeChanged(input, seriesId, season, saveBar);
    });
    input.addEventListener("change", () => {
      markEpisodeChanged(input, seriesId, season, saveBar);
    });
  });
}

// ─────────────────────────────────────────
// BUILD EPISODE CARD
// ─────────────────────────────────────────
function buildEpisodeCard(seriesId, season, ep, savedData) {
  const card = document.createElement("div");
  card.className    = savedData ? "episode-card is-saved" : "episode-card";
  card.dataset.ep   = ep;
  card.dataset.epKey = epKey(seriesId, season, ep);

  const val = (key) => escapeHtml(savedData?.[key] ?? "");
  const ratingVal = savedData?.rating || "";

  card.innerHTML = `
    <div class="ep-label">
      <span>Episode ${ep}</span>
      ${savedData ? `<span class="ep-saved-dot" title="Saved"></span>` : ""}
    </div>
    <div class="ep-field">
      <div class="ep-field-label">Remarks / Notes</div>
      <textarea class="ep-input ep-remarks" data-field="remarks" placeholder="Your thoughts on this episode...">${val("remarks")}</textarea>
    </div>
    <div class="ep-field mt-2 mb-2">
      <div class="ep-field">
        <div class="ep-field-label">Duration</div>
        <div class="dp-wrap">
            <button type="button" class="ep-input dp-trigger" data-field="duration" data-value="${val("duration")}">
            <i class="bi bi-clock" style="font-size:13px;opacity:.6"></i>
            <span class="dp-display">${val("duration") || "Select duration"}</span>
            <i class="bi bi-chevron-down dp-chevron" style="font-size:11px;opacity:.5;margin-left:auto"></i>
            </button>
            <div class="dp-panel">
            <div class="dp-cols">
                <div class="dp-col">
                <div class="dp-col-label">Min</div>
                <div class="dp-scroll-wrap">
                    <div class="dp-highlight"></div>
                    <div class="dp-scroll dp-min"></div>
                </div>
                </div>
                <div class="dp-sep">:</div>
                <div class="dp-col">
                <div class="dp-col-label">Sec</div>
                <div class="dp-scroll-wrap">
                    <div class="dp-highlight"></div>
                    <div class="dp-scroll dp-sec"></div>
                </div>
                </div>
            </div>
            <div class="dp-footer">
                <button type="button" class="dp-cancel-btn">Cancel</button>
                <button type="button" class="dp-ok-btn ms-btn-save" style="font-size:0.78rem;padding:0.4rem 0.85rem">Set</button>
            </div>
            </div>
        </div>
        </div>
    </div>
    <div class="ep-field">
        <div class="ep-field-label">Rating</div>
            <select class="ep-input ep-rating" data-field="rating">
            <option value="">—</option>
            ${[1,2,3,4,5].map(n => `<option value="${n}" ${ratingVal == n ? "selected" : ""}>${n} ${"⭐".repeat(n)}</option>`).join("")}
            </select>
    </div>
    <div class="ep-field mt-2">
      <div class="ep-field-label">Date Watched</div>
      <input type="date" class="ep-input ep-date" data-field="dateWatched" value="${val("dateWatched")}">
    </div>
  `;
  return card;
}

function initDurationPicker(wrap, savedValue) {
  const ITEM_H = 34;
  const PAD    = 1.5;

  const trigger   = wrap.querySelector(".dp-trigger");
  const panel     = wrap.querySelector(".dp-panel");
  const display   = wrap.querySelector(".dp-display");
  const chevron   = wrap.querySelector(".dp-chevron");
  const minScroll = wrap.querySelector(".dp-min");
  const secScroll = wrap.querySelector(".dp-sec");
  const okBtn     = wrap.querySelector(".dp-ok-btn");
  const cancelBtn = wrap.querySelector(".dp-cancel-btn");

  function parseValue(str) {
    const mMatch = String(str || "").match(/(\d+)m/);
    const sMatch = String(str || "").match(/(\d+)s/);
    return {
      m: mMatch ? parseInt(mMatch[1], 10) : 0,
      s: sMatch ? parseInt(sMatch[1], 10) : 0,
    };
  }

  function buildList(el, count) {
    const makeSpace = () => {
      const d = document.createElement("div");
      d.style.cssText = `height:${PAD * ITEM_H}px;flex-shrink:0`;
      el.appendChild(d);
    };
    makeSpace();
    for (let i = 0; i < count; i++) {
      const div = document.createElement("div");
      div.className = "dp-item";
      div.dataset.val = i;
      div.textContent = String(i).padStart(2, "0");
      el.appendChild(div);
    }
    makeSpace();
  }

  function valueToScrollTop(value) {
    return value * ITEM_H;
  }

  function scrollTopToValue(scrollTop) {
    return Math.max(0, Math.round(scrollTop / ITEM_H));
  }

  function highlightCurrent(scrollEl) {
    const val   = scrollTopToValue(scrollEl.scrollTop);
    const items = scrollEl.querySelectorAll(".dp-item");
    items.forEach(item => {
      item.classList.toggle("dp-item-sel", parseInt(item.dataset.val, 10) === val);
    });
    return val;
  }

  function scrollToValue(scrollEl, value, animate) {
    scrollEl.scrollTo({
      top: valueToScrollTop(value),
      behavior: animate ? "smooth" : "auto",
    });
  }

  buildList(minScroll, 60);
  buildList(secScroll, 60);

  let committed = parseValue(savedValue);
  let isOpen = false;

  function open() {
    isOpen = true;
    panel.style.display = "block";
    chevron.style.transform = "rotate(180deg)";
    scrollToValue(minScroll, committed.m, false);
    scrollToValue(secScroll, committed.s, false);
    setTimeout(() => {
      highlightCurrent(minScroll);
      highlightCurrent(secScroll);
    }, 30);
  }

  function close() {
    isOpen = false;
    panel.style.display = "none";
    chevron.style.transform = "";
  }

  function commit() {
    const m = scrollTopToValue(minScroll.scrollTop);
    const s = scrollTopToValue(secScroll.scrollTop);
    scrollToValue(minScroll, m, false);
    scrollToValue(secScroll, s, false);
    committed = { m, s };
    const txt = m + "m " + String(s).padStart(2, "0") + "s";
    trigger.dataset.value = txt;
    display.textContent   = txt;
    trigger.dispatchEvent(new Event("change", { bubbles: true }));
    close();
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    isOpen ? close() : open();
  });
  okBtn.addEventListener("click",     (e) => { e.stopPropagation(); commit(); });
  cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); close(); });

  function attachSnap(scrollEl) {
    let t;
    scrollEl.addEventListener("scroll", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const v = scrollTopToValue(scrollEl.scrollTop);
        scrollToValue(scrollEl, v, true);
        highlightCurrent(scrollEl);
      }, 80);
    });
  }
  attachSnap(minScroll);
  attachSnap(secScroll);

  document.addEventListener("click", (e) => {
    if (isOpen && !wrap.contains(e.target)) close();
  });

  if (committed.m || committed.s) {
    setTimeout(() => {
      highlightCurrent(minScroll);
      highlightCurrent(secScroll);
    }, 60);
  }
}

// ─────────────────────────────────────────
// MARK EPISODE CHANGED → show save bar
// ─────────────────────────────────────────
function markEpisodeChanged(inputEl, seriesId, season, saveBar) {
  const epCard = inputEl.closest(".episode-card");
  if (epCard && !epCard.classList.contains("has-changes")) {
    epCard.classList.add("has-changes");
    epCard.classList.remove("is-saved");
  }
  if (!saveBar.classList.contains("visible")) {
    saveBar.classList.add("visible");
  }
}

// ─────────────────────────────────────────
// SAVE SEASON
// ─────────────────────────────────────────
async function handleSaveSeason(seriesId, season, numEpisodes, seasonItem) {
  const panel   = seasonItem.querySelector(".season-panel");
  const saveBar = seasonItem.querySelector(".season-save-bar");
  const btn     = saveBar?.querySelector(".save-season-btn");

  const episodesPayload = [];
  for (let ep = 1; ep <= numEpisodes; ep++) {
    const card = panel.querySelector(`[data-ep="${ep}"]`);
    if (!card) continue;

    const remarks     = card.querySelector(".ep-remarks")?.value.trim()  || "";
    const duration    = card.querySelector(".dp-trigger")?.dataset.value || "";
    const rating      = card.querySelector(".ep-rating")?.value          || "";
    const dateWatched = card.querySelector(".ep-date")?.value            || "";

    if (remarks || duration || rating || dateWatched) {
      episodesPayload.push({ episode: ep, remarks, duration, rating: Number(rating) || 0, dateWatched });
    }
  }

  if (!episodesPayload.length) {
    showAlert("Fill in at least one episode's details before saving.", "warning"); return;
  }

  try {
    toggleBtn(btn, true);
    await withLoading(() => api("saveSeasonEpisodes", token(), seriesId, season, episodesPayload));

    showAlert(`Season ${season} saved!`, "success");

    episodesPayload.forEach(ep => {
      const k = epKey(seriesId, season, ep.episode);
      state.episodes[k] = { ...ep, seriesId, season, savedAt: new Date().toISOString() };
    });

    panel.querySelectorAll(".episode-card").forEach(card => {
      const ep = parseInt(card.dataset.ep, 10);
      if (episodesPayload.find(e => e.episode === ep)) {
        card.classList.add("is-saved");
        card.classList.remove("has-changes");
        const label = card.querySelector(".ep-label");
        if (label && !label.querySelector(".ep-saved-dot")) {
          label.insertAdjacentHTML("beforeend", `<span class="ep-saved-dot"></span>`);
        }
      }
    });

    saveBar?.classList.remove("visible");
    updateSeriesCard(seriesId);
    updateStats();
  } catch (err) {
    showAlert(err.message, "danger");
  } finally {
    toggleBtn(btn, false);
  }
}

// ─────────────────────────────────────────
// UPDATE SERIES CARD (progress + season badges) after save
// ─────────────────────────────────────────
function updateSeriesCard(seriesId) {
  const series = state.series.find(s => s.seriesId === seriesId);
  if (!series) return;

  const card = document.querySelector(`.series-card[data-series-id="${seriesId}"]`);
  if (!card) return;

  const totalEpSlots = countTotalEpisodeSlots(series);
  const savedEpCount = countSavedEpisodes(series);
  const pct          = totalEpSlots > 0 ? Math.round((savedEpCount / totalEpSlots) * 100) : 0;

  const fill  = card.querySelector(".series-progress-fill");
  const label = card.querySelector(".series-progress-label");
  if (fill)  fill.style.width = `${pct}%`;
  if (label) label.innerHTML  = `<span>${savedEpCount} / ${totalEpSlots} episodes logged</span><span>${pct}%</span>`;

  card.querySelectorAll(".season-item").forEach(seasonItem => {
    const s      = parseInt(seasonItem.dataset.season, 10);
    const numEps = parseInt(seasonItem.dataset.numEps, 10) || getEpsForSeason(series, s);
    const toggle = seasonItem.querySelector(".season-toggle");
    const badge  = seasonItem.querySelector(".season-number-badge");
    const pill   = seasonItem.querySelector(".season-status-pill");

    const { isLocked, isDone, savedCount } = getSeasonStatus(seriesId, s, numEps);
    const partial = !isDone && savedCount > 0;

    badge?.classList.toggle("is-done",   isDone && !isLocked);
    badge?.classList.toggle("is-locked", isLocked);

    if (toggle) {
      toggle.classList.toggle("is-locked", isLocked);
      toggle.disabled = isLocked;
      toggle.removeAttribute("title");
      if (isLocked) {
        toggle.setAttribute("title", "Complete the previous season first");
      }

      var chevron = toggle.querySelector(".season-chevron");
      if (chevron) {
        if (isLocked) {
          chevron.className = "bi bi-lock season-chevron";
        } else {
          chevron.className = "bi bi-chevron-down season-chevron";
        }
      }
    }

    if (pill) {
      pill.className = "season-status-pill " + (isLocked ? "locked" : isDone ? "done" : partial ? "partial" : "empty");
      if (isLocked)     pill.innerHTML = `<i class="bi bi-lock-fill me-1"></i>Locked`;
      else if (isDone)  pill.innerHTML = `<i class="bi bi-check-circle-fill me-1"></i>Done`;
      else if (partial) pill.innerHTML = `${savedCount}/${numEps} logged`;
      else              pill.innerHTML = `Not started`;
    }
  });
}

// ─────────────────────────────────────────
// FORMAT DATE
// ─────────────────────────────────────────
function formatDate(value) {
  if (!value) return "-";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [y, m, d] = String(value).split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" });
  }
  const dt = new Date(value);
  return isNaN(dt.getTime()) ? value : dt.toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" });
}

// ─────────────────────────────────────────
// PROFILE
// ─────────────────────────────────────────
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
