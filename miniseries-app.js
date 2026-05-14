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
// ── GALLERY STATE ─────────────────────────────────────────────────────────────
const galState2 = {
  seriesIdx:  0,   // which series is active in the nav
  slideIdx:   0,   // current slide (0 = hero, 1+ = episodes)
  slides:     [],  // flat list of slide descriptors for the active series
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
  bindImageUpload();
  bindCreateSeriesToggle();
  bindGalleryToggle();

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

  // Wire mobile logout to the same handler as the desktop logout button
  mobileLogoutBtn?.addEventListener("click", handleLogout);

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
// ── IMAGE UPLOAD HELPERS ──────────────────────────────────────────────────────

/** Read a File as a base64 data-URL string (returns just the base64 payload). */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(",")[1]); // strip "data:image/...;base64,"
    reader.onerror = () => reject(new Error("Could not read the image file."));
    reader.readAsDataURL(file);
  });
}

/**
 * Compress an image File before base64 encoding.
 * Resizes to max 800px wide and compresses to ~70% quality.
 */
// Make the image tiny enough to fit under 50KB base64
function compressImage(file, maxWidth = 400, quality = 0.5) {
  return new Promise((resolve, reject) => {
    const img  = new Image();
    const url  = URL.createObjectURL(file);
    img.onload = () => {
      const scale  = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement("canvas");
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        blob => {
          // Warn if still too large
          if (blob.size > 35000) {
            console.warn("Compressed blob still large:", blob.size, "bytes");
          }
          blob
            ? resolve(new File([blob], file.name, { type: "image/jpeg" }))
            : reject(new Error("Compression failed"));
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => reject(new Error("Could not load image."));
    img.src = url;
  });
}

/** Wire the cover-image upload input + preview + clear button in the Create form. */
function bindImageUpload() {
  const input      = $("seriesCoverImage");
  const label      = $("seriesUploadLabel");
  const uploadText = $("seriesUploadText");
  const preview    = $("seriesImagePreview");
  const previewImg = $("seriesImagePreviewImg");
  const clearBtn   = $("seriesImageClearBtn");
  if (!input) return;

  input.addEventListener("change", () => {
    const file = input.files[0];
    if (!file) return;

    // 5 MB guard
    if (file.size > 5 * 1024 * 1024) {
      showAlert("Image must be 5 MB or smaller.", "warning");
      input.value = "";
      return;
    }

    // Show filename in label
    uploadText.textContent = file.name;

    // Show preview
    const url = URL.createObjectURL(file);
    previewImg.src = url;
    preview.classList.remove("d-none");
    label.style.display = "none";
  });

  clearBtn.addEventListener("click", () => {
    input.value        = "";
    previewImg.src     = "";
    uploadText.textContent = "Click to choose an image (JPG, PNG, WEBP — max 5 MB)";
    preview.classList.add("d-none");
    label.style.display = "";
  });
}

// ─────────────────────────────────────────
// CREATE SERIES PANEL TOGGLE
// ─────────────────────────────────────────
const PANEL_STORAGE_KEY = "createSeriesPanelVisible";

function bindCreateSeriesToggle() {
  const toggle     = $("createSeriesToggle");
  const panelCol   = $("createSeriesPanelCol");
  if (!toggle || !panelCol) return;

  // Restore saved preference (default: visible)
  const saved = localStorage.getItem(PANEL_STORAGE_KEY);
  const isVisible = saved === null ? true : saved === "true";
  applyPanelState(isVisible, false);

  toggle.addEventListener("click", (e) => {
    e.stopPropagation(); // don't close the dropdown
    const current = toggle.getAttribute("aria-checked") === "true";
    applyPanelState(!current, true);
  });

  function applyPanelState(visible, save) {
    toggle.setAttribute("aria-checked", String(visible));
    if (visible) {
      panelCol.classList.remove("panel-hidden");
    } else {
      panelCol.classList.add("panel-hidden");
    }
    if (save) {
      localStorage.setItem(PANEL_STORAGE_KEY, String(visible));
    }
  }
}

// ─────────────────────────────────────────
// GALLERY SECTION TOGGLE
// ─────────────────────────────────────────
const GALLERY_STORAGE_KEY = "gallerySectionVisible";

function bindGalleryToggle() {
  const toggle  = $("galleryToggle");
  const section = $("gallerySection");
  if (!toggle || !section) return;

  const saved     = localStorage.getItem(GALLERY_STORAGE_KEY);
  const isVisible = saved === null ? true : saved === "true";
  applyGalleryState(isVisible, false);

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const current = toggle.getAttribute("aria-checked") === "true";
    applyGalleryState(!current, true);
  });

  function applyGalleryState(visible, save) {
    toggle.setAttribute("aria-checked", String(visible));
    section.classList.toggle("d-none", !visible);
    if (save) localStorage.setItem(GALLERY_STORAGE_KEY, String(visible));
  }
}

/**
 * Wire the image upload input/preview/clear inside an edit form wrap element.
 * Uses class selectors (not IDs) since multiple edit forms could exist.
 */
function bindEditImageUpload(wrap) {
  const input      = wrap.querySelector(".series-edit-image-input");
  const label      = wrap.querySelector(".series-edit-upload-label");
  const uploadText = wrap.querySelector(".series-edit-upload-text");
  const preview    = wrap.querySelector(".series-edit-image-preview");
  const previewImg = wrap.querySelector(".series-edit-preview-img");
  const clearBtn   = wrap.querySelector(".series-edit-image-clear-btn");
  if (!input) return;

  input.addEventListener("change", () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showAlert("Image must be 5 MB or smaller.", "warning");
      input.value = "";
      return;
    }
    uploadText.textContent = file.name;
    previewImg.src = URL.createObjectURL(file);
    preview.classList.remove("d-none");
    label.style.display = "none";
  });

  clearBtn.addEventListener("click", () => {
    input.value = "";
    previewImg.src = "";
    uploadText.textContent = "Click to choose an image (JPG, PNG, WEBP — max 5 MB)";
    preview.classList.add("d-none");
    label.style.display = "";
  });
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
  // Use JSON body instead of URLSearchParams to prevent base64 corruption
  const res  = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "follow",
    body: new URLSearchParams({ method, args: JSON.stringify(args) })
  });
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

// ── TOAST SYSTEM ──────────────────────────────────────────────────────────────
(function () {
  const DURATION = 6000;
  const MAX      = 5;

  const TYPES = {
    success: { icon: "bi-check-circle-fill", label: "Success"  },
    danger:  { icon: "bi-x-circle-fill",     label: "Error"    },
    warning: { icon: "bi-exclamation-circle-fill", label: "Warning" },
    info:    { icon: "bi-info-circle-fill",   label: "Info"    },
  };

  // Inject stack container once
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

    // Cap stack at MAX — remove oldest (last child, since column-reverse)
    const existing = stack.querySelectorAll(".toast-item");
    if (existing.length >= MAX) removeToast(existing[existing.length - 1].id);

    const cfg  = TYPES[type] || TYPES.info;
    const id   = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const el   = document.createElement("div");
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

    // Pause progress on hover
    el.addEventListener("mouseenter", () => {
      clearTimeout(el._autoTimer);
      el.querySelector(".toast-progress").style.animationPlayState = "paused";
    });
    el.addEventListener("mouseleave", () => {
      el.querySelector(".toast-progress").style.animationPlayState = "running";
      // Restart auto-dismiss from remaining time isn't trivial, so just give a fresh 2s grace
      el._autoTimer = setTimeout(() => removeToast(id), 2000);
    });

    stack.prepend(el);

    // Trigger enter animation on next frame
    requestAnimationFrame(() => {
      requestAnimationFrame(() => el.classList.add("toast-in"));
    });

    el._autoTimer = setTimeout(() => removeToast(id), duration);
  };

  window.removeAlert = function (id) { removeToast(id); };
})();

// ─────────────────────────────────────────
// CUSTOM CONFIRM MODAL
// ─────────────────────────────────────────
function msConfirm({ title = "Are you sure?", message = "", warning = "" } = {}) {
  return new Promise((resolve) => {
    // Inject modal HTML once
    let backdrop = document.getElementById("msConfirmBackdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.id        = "msConfirmBackdrop";
      backdrop.className = "ms-confirm-backdrop";
      backdrop.innerHTML = `
        <div class="ms-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="msConfirmTitle">
          <div class="ms-confirm-stripe"></div>
          <div class="ms-confirm-body">
            <div class="ms-confirm-header">
              <div class="ms-confirm-icon">
                <i class="bi bi-trash3"></i>
              </div>
              <div>
                <div class="ms-confirm-title" id="msConfirmTitle"></div>
                <div class="ms-confirm-message" id="msConfirmMessage"></div>
              </div>
            </div>
            <div class="ms-confirm-warning-box" id="msConfirmWarningBox">
              <i class="bi bi-exclamation-circle" style="flex-shrink:0;opacity:0.8"></i>
              <span id="msConfirmWarning"></span>
            </div>
            <div class="ms-confirm-actions">
              <button type="button" class="ms-confirm-cancel" id="msConfirmCancel">Cancel</button>
              <button type="button" class="ms-confirm-ok" id="msConfirmOk">
                <i class="bi bi-trash3"></i> Yes, clear it
              </button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(backdrop);
    }

    // Populate content
    document.getElementById("msConfirmTitle").textContent   = title;
    document.getElementById("msConfirmMessage").textContent = message;

    const warningBox = document.getElementById("msConfirmWarningBox");
    const warningEl  = document.getElementById("msConfirmWarning");
    if (warning) {
      warningEl.textContent       = warning;
      warningBox.style.display    = "flex";
    } else {
      warningBox.style.display    = "none";
    }

    // Open
    requestAnimationFrame(() => {
      requestAnimationFrame(() => backdrop.classList.add("open"));
    });

    function close(result) {
      backdrop.classList.remove("open");
      // Wait for transition then clean up listeners
      backdrop.addEventListener("transitionend", () => {
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        backdrop.removeEventListener("click", onBackdropClick);
        document.removeEventListener("keydown", onKeydown);
      }, { once: true });
      resolve(result);
    }

    const okBtn     = document.getElementById("msConfirmOk");
    const cancelBtn = document.getElementById("msConfirmCancel");

    function onOk()           { close(true);  }
    function onCancel()       { close(false); }
    function onBackdropClick(e) { if (e.target === backdrop) close(false); }
    function onKeydown(e)     { if (e.key === "Escape") close(false); }

    okBtn.addEventListener("click",     onOk);
    cancelBtn.addEventListener("click", onCancel);
    backdrop.addEventListener("click",  onBackdropClick);
    document.addEventListener("keydown", onKeydown);
  });
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
  showStatsSkeleton();   // stats
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
function showStatsSkeleton() {
  ["statTotalSeries", "statTotalEpisodes", "statAvgRating"].forEach(id => {
    const box = $(id)?.closest(".ms-stat-box");
    if (box) box.classList.add("is-loading");
  });
}

// ─────────────────────────────────────────
// STATS
// ─────────────────────────────────────────
function updateStats() {
  const totalSeries  = state.series.length;
  const allEpisodes  = Object.values(state.episodes);
  const totalLogged  = allEpisodes.length;
  const rated        = allEpisodes.filter(ep => ep.rating > 0);
  const avgRating    = rated.length
    ? (rated.reduce((s, ep) => s + Number(ep.rating), 0) / rated.length).toFixed(1)
    : "—";

  if ($("statTotalSeries"))   $("statTotalSeries").textContent   = totalSeries;
  if ($("statTotalEpisodes")) $("statTotalEpisodes").textContent = totalLogged;
  if ($("statAvgRating"))     $("statAvgRating").textContent     = avgRating !== "—" ? avgRating + " ★" : "—";

  // Remove skeleton once values are populated
  ["statTotalSeries", "statTotalEpisodes", "statAvgRating"].forEach(id => {
    const box = $(id)?.closest(".ms-stat-box");
    if (box) box.classList.remove("is-loading");
  });

  renderGallery();
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

  const seasonEpisodesMap = readSeasonEpisodesFromForm();
  if (!seasonEpisodesMap) {
    showAlert('Click "Set Episodes" first to configure episodes per season.', "warning");
    return;
  }

  for (let s = 1; s <= numSeasons; s++) {
    const eps = parseInt(seasonEpisodesMap[s], 10);
    if (!eps || eps < 1) {
      showAlert(`Season ${s} must have at least 1 episode.`, "warning");
      return;
    }
  }
  
  const seasonTitlesMap    = readSeasonTitlesFromForm();
  const seasonTitlesJson   = seasonTitlesMap ? JSON.stringify(seasonTitlesMap) : "";
  const totalEpisodes      = Object.values(seasonEpisodesMap).reduce((sum, n) => sum + parseInt(n, 10), 0);
  const seasonEpisodesJson = JSON.stringify(seasonEpisodesMap);

  // ── just keep a reference to the file; base64 reading happens in Step 2 ──
  const imageFile = $("seriesCoverImage")?.files?.[0];

  try {
    toggleBtn(btn, true);
    // Step 1: create the series record
    const result = await withLoading(() =>
      api("createSeries", token(), title, genre, numSeasons, totalEpisodes,
          seasonEpisodesJson, seasonTitlesJson)
    );

    // Step 2: upload image separately if provided
    if (imageFile) {
      let imageBase64 = "";
      let imageMime   = "";
      try {
        const compressed = await compressImage(imageFile);
        imageBase64      = await fileToBase64(compressed);
        imageMime        = "image/jpeg";
        await withLoading(() =>
          api("uploadSeriesImage", token(), result.seriesId, imageBase64, imageMime)
        );
      } catch (imgErr) {
        // Series created — just warn about the image
        showAlert(`"${title}" created, but image upload failed: ${imgErr.message}`, "warning");
        $("createSeriesForm").reset();
        resetSeasonBuilder();
        const clearBtn = $("seriesImageClearBtn");
        if (clearBtn) clearBtn.click();
        await refresh();
        return;
      }
    }

    $("createSeriesForm").reset();
    resetSeasonBuilder();
    const clearBtn = $("seriesImageClearBtn");
    if (clearBtn) clearBtn.click();
    await refresh();
    showAlert(
      imageFile
        ? `"${title}" created with cover image!`
        : `"${title}" created successfully!`,
      "success"
    );
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

      <div class="series-edit-field">
        <label class="form-label">
          Cover Image
          <span style="color:var(--muted);font-weight:400;font-size:0.78rem;"> (optional — replaces existing)</span>
        </label>
        <label class="series-upload-label series-edit-upload-label">
          <i class="bi bi-image me-2" style="font-size:1.1rem;opacity:.7"></i>
          <span class="series-upload-text smx-font series-edit-upload-text">Click to choose an image (JPG, PNG, WEBP — max 5 MB)</span>
          <input type="file" accept="image/jpeg,image/png,image/webp" class="series-edit-image-input" style="display:none">
        </label>
        <div class="series-image-preview d-none series-edit-image-preview" style="margin-top:0.6rem;">
          <img class="series-edit-preview-img" src="" alt="Cover preview">
          <button type="button" class="series-image-clear-btn series-edit-image-clear-btn" aria-label="Remove image">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
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
// Wire edit-form image upload
  bindEditImageUpload(wrap);
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

  const addingSeasons = !isNaN(newTotal) && newTotal > series.numSeasons;

  if (seasonsInput.value.trim() !== "" && !addingSeasons) {
    showAlert(`New season count must be greater than ${series.numSeasons}.`, "warning");
    return;
  }

  let newSeasonEpisodesJson = null;

  if (addingSeasons) {
    const newSeasonsListEl = formWrap.querySelector(".series-edit-new-seasons-list");
    const allInputs        = newSeasonsListEl
      ? [...newSeasonsListEl.querySelectorAll(".season-ep-input:not([disabled])")]
      : [];

    if (!allInputs.length) {
      showAlert('Click "Set New Episodes" first to configure episodes for the new seasons.', "warning");
      return;
    }

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

  // ── Read image file (optional) ────────────────────────────────────────────
  const imageFile = formWrap.querySelector(".series-edit-image-input")?.files?.[0];

  try {
    toggleBtn(saveBtn, true);

    // ── Step 1: update metadata (title, seasons) ──────────────────────────
    const updated = await withLoading(() =>
      api("updateSeries", token(), seriesId, newTitle, finalNumSeasons,
          newSeasonEpisodesJson || "")
    );

    // Patch local state with metadata update
    const idx = state.series.findIndex(s => s.seriesId === seriesId);
    if (idx !== -1) {
      state.series[idx] = {
        ...state.series[idx],
        title:          updated.title,
        numSeasons:     updated.numSeasons,
        numEpisodes:    updated.numEpisodes,
        seasonEpisodes: updated.seasonEpisodes,
        coverImageUrl:  updated.coverImageUrl || state.series[idx].coverImageUrl || "",
      };
    }

    // ── Step 2: upload image separately if one was chosen ─────────────────
    if (imageFile) {
      let imageBase64 = "";
      let imageMime   = "";
      try {
        const compressed = await compressImage(imageFile);
        imageBase64      = await fileToBase64(compressed);
        imageMime        = "image/jpeg";
      } catch (readErr) {
        // Metadata already saved — just warn about the image
        showAlert(`"${updated.title}" updated, but the image could not be read: ${readErr.message}`, "warning");
        rerenderCard(idx, seriesId);
        updateStats();
        return;
      }

      try {
        // ✅ REPLACE the api() call with this
        const imgResult = await withLoading(() =>
          api("uploadSeriesImage", token(), seriesId, imageBase64, imageMime)
        );
        if (idx !== -1 && imgResult?.coverImageUrl) {
          state.series[idx].coverImageUrl = imgResult.coverImageUrl;
        }
      } catch (imgErr) {
        // Metadata already saved — just warn about the image
        showAlert(`"${updated.title}" updated, but image upload failed: ${imgErr.message}`, "warning");
        rerenderCard(idx, seriesId);
        updateStats();
        return;
      }
    }

    rerenderCard(idx, seriesId);
    updateStats();
    showAlert(
      imageFile
        ? `"${updated.title}" updated with new cover image!`
        : `"${updated.title}" updated successfully!`,
      "success"
    );
  } catch (err) {
    showAlert(err.message, "danger");
  } finally {
    toggleBtn(saveBtn, false);
  }
}

/** Re-render a series card in place using current state. */
function rerenderCard(idx, seriesId) {
  if (idx === -1) return;
  const card    = document.querySelector(`.series-card[data-series-id="${seriesId}"]`);
  if (!card) return;
  const newCard = buildSeriesCard(state.series[idx]);
  card.replaceWith(newCard);
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
  renderGallery();
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
        <div class="series-meta-pills-wrap">
          <div class="series-meta-pills">
            <span class="ms-pill ms-pill-genre">${escapeHtml(genre)}</span>
            <span class="ms-pill">${numSeasons} Season${numSeasons !== 1 ? "s" : ""}</span>
            <span class="ms-pill" title="${escapeHtml(createdAt)}">Posted: ${formatDate(createdAt)}</span>
            <span class="ms-pill">Total Logged: ${escapeHtml(savedEpCount)}</span>
            <span class="ms-pill">Total Episodes: ${escapeHtml(totalEpSlots)}</span>
            <span class="ms-pill">by ${escapeHtml(name || username)}</span>
          </div>
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
        <span hidden="true">${savedEpCount} / ${totalEpSlots} episodes logged</span>
        <span>${pct}% complete</span>
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
const SEASONS_VISIBLE_DEFAULT = 1;

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
// Registry: "seriesId::season" → cardCache object
const episodeCardCache = {};
function ensureEpisodeInputsWired(seasonItem, series) {
  const panel = seasonItem.querySelector(".season-panel");
  if (!panel || panel.dataset.wired) return;
  panel.dataset.wired = "1";

  const { seriesId } = series;
  const season      = parseInt(seasonItem.dataset.season, 10);
  const numEpisodes = parseInt(seasonItem.dataset.numEps, 10) || getEpsForSeason(series, season);

  const PAGE_SIZE = 2;
  let currentPage = 1;
  const totalPages = Math.ceil(numEpisodes / PAGE_SIZE);

  // ── Grid container
  const grid = document.createElement("div");
  grid.className = "episode-grid";
  panel.appendChild(grid);

  // ── Pagination bar (only if more than one page)
  let paginationBar = null;
  if (totalPages > 1) {
    paginationBar = document.createElement("div");
    paginationBar.className = "ep-pagination-bar";
    panel.appendChild(paginationBar);
  }

  // ── Save bar
  const saveBar = document.createElement("div");
  saveBar.className = "season-save-bar";
  saveBar.dataset.saveBar = `${seriesId}::${season}`;
  saveBar.innerHTML = `
    <span class="season-save-hint"><i class="bi bi-exclamation-circle me-1"></i>Unsaved changes</span>
    <button type="button" class="btn ms-btn-save save-season-btn">
      <i class="bi bi-floppy me-1"></i>Save Season ${season}
    </button>`;
  panel.appendChild(saveBar);

  saveBar.querySelector(".save-season-btn").addEventListener("click", () => {
    handleSaveSeason(seriesId, season, numEpisodes, seasonItem);
  });

  // ── Episode card cache: build all cards once, reuse across page switches
  const cacheKey = `${seriesId}::${season}`;
  const cardCache = {};
  episodeCardCache[cacheKey] = cardCache;
  function getOrBuildCard(ep) {
    if (!cardCache[ep]) {
      const savedData = state.episodes[epKey(seriesId, season, ep)] || null;
      const card = buildEpisodeCard(seriesId, season, ep, savedData);

      // Wire duration picker immediately after building
      const dpWrap = card.querySelector(".dp-wrap");
      if (dpWrap) {
        const saved = card.querySelector(".dp-trigger")?.dataset.value || "";
        initDurationPicker(dpWrap, saved);
      }

      // Wire change detection
      card.querySelectorAll(".ep-input").forEach(input => {
        input.addEventListener("input",  () => markEpisodeChanged(input, seriesId, season, saveBar));
        input.addEventListener("change", () => markEpisodeChanged(input, seriesId, season, saveBar));
      });

      // Wire Clear button
      card.querySelector(".ep-clear-btn")?.addEventListener("click", () => {
        handleClearEpisode(card, seriesId, season, ep, saveBar, series);
      });

      cardCache[ep] = card;
    }
    return cardCache[ep];
  }

  // ── Render a specific page
  function renderPage(page) {
    currentPage = page;
    grid.innerHTML = "";

    const start = (page - 1) * PAGE_SIZE + 1;
    const end   = Math.min(page * PAGE_SIZE, numEpisodes);

    for (let ep = start; ep <= end; ep++) {
      grid.appendChild(getOrBuildCard(ep));
    }

    // Scroll season panel top into view smoothly
    seasonItem.scrollIntoView({ behavior: "smooth", block: "nearest" });

    if (paginationBar) renderPaginationBar();
  }

  // ── Build pagination bar UI
  function renderPaginationBar() {
    const start = (currentPage - 1) * PAGE_SIZE + 1;
    const end   = Math.min(currentPage * PAGE_SIZE, numEpisodes);

    paginationBar.innerHTML = `
      <div class="ep-pagination-info">
        Ep ${start}–${end} <span class="ep-pagination-total">of ${numEpisodes}</span>
      </div>
      <div class="ep-pagination-controls">
        <button type="button" class="ep-page-btn ep-page-prev" ${currentPage === 1 ? "disabled" : ""} aria-label="Previous episodes">
          <i class="bi bi-chevron-left"></i>
        </button>
        ${buildPageDots()}
        <button type="button" class="ep-page-btn ep-page-next" ${currentPage === totalPages ? "disabled" : ""} aria-label="Next episodes">
          <i class="bi bi-chevron-right"></i>
        </button>
      </div>`;

    paginationBar.querySelector(".ep-page-prev")?.addEventListener("click", () => {
      if (currentPage > 1) renderPage(currentPage - 1);
    });
    paginationBar.querySelector(".ep-page-next")?.addEventListener("click", () => {
      if (currentPage < totalPages) renderPage(currentPage + 1);
    });
    paginationBar.querySelectorAll(".ep-page-dot").forEach(dot => {
      dot.addEventListener("click", () => renderPage(parseInt(dot.dataset.page, 10)));
    });
  }

  function buildPageDots() {
    // Show at most 5 dots; collapse middle pages with ellipsis for large counts
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => {
        const p = i + 1;
        return `<button type="button" class="ep-page-dot ${p === currentPage ? "active" : ""}" data-page="${p}" aria-label="Page ${p}">${p}</button>`;
      }).join("");
    }

    // Windowed: always show first, last, current ±1
    const pages = new Set([1, totalPages, currentPage, currentPage - 1, currentPage + 1]
      .filter(p => p >= 1 && p <= totalPages));
    const sorted = [...pages].sort((a, b) => a - b);
    let dots = "";
    let prev = 0;
    sorted.forEach(p => {
      if (prev && p - prev > 1) dots += `<span class="ep-page-ellipsis">…</span>`;
      dots += `<button type="button" class="ep-page-dot ${p === currentPage ? "active" : ""}" data-page="${p}">${p}</button>`;
      prev = p;
    });
    return dots;
  }

  // ── Initial render
  renderPage(1);
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
      <div style="display:flex;align-items:center;gap:6px;margin-left:auto;">
        ${savedData ? `<span class="ep-saved-dot" title="Saved"></span>` : ""}
        <button type="button" class="ep-clear-btn" title="Clear this episode">
          <i class="bi bi-x-circle"></i> Clear
        </button>
      </div>
    </div>
 
    <div class="ep-field">
      <div class="ep-field-label">Episode Title</div>
      <input
        type="text"
        class="ep-input ep-title"
        data-field="episodeTitle"
        placeholder="e.g. Winter Is Coming"
        maxlength="200"
        value="${val("episodeTitle")}"
      >
    </div>
 
    <div class="ep-field mt-2">
      <div class="ep-field-label">Remarks / Notes</div>
      <textarea rows="5" class="ep-input ep-remarks" data-field="remarks" placeholder="Your thoughts on this episode...">${val("remarks")}</textarea>
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
                <div class="dp-col-label">Hrs</div>
                <div class="dp-scroll-wrap">
                  <div class="dp-highlight"></div>
                  <div class="dp-scroll dp-hrs"></div>
                </div>
              </div>
              <div class="dp-sep">:</div>
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
// ─────────────────────────────────────────
// DURATION PICKER  — now HRS : MIN : SEC
// ─────────────────────────────────────────
function initDurationPicker(wrap, savedValue) {
  const ITEM_H = 34;
  const PAD    = 1.5;

  const trigger   = wrap.querySelector(".dp-trigger");
  const panel     = wrap.querySelector(".dp-panel");
  const display   = wrap.querySelector(".dp-display");
  const chevron   = wrap.querySelector(".dp-chevron");
  const hrsScroll = wrap.querySelector(".dp-hrs");
  const minScroll = wrap.querySelector(".dp-min");
  const secScroll = wrap.querySelector(".dp-sec");
  const okBtn     = wrap.querySelector(".dp-ok-btn");
  const cancelBtn = wrap.querySelector(".dp-cancel-btn");

  /**
   * Parse a saved duration string into { h, m, s }.
   * Supports formats:
   *   "1h 30m 45s"  (new format with hours)
   *   "30m 45s"     (old format without hours)
   *   "30m 05s"
   */
  function parseValue(str) {
    const hMatch = String(str || "").match(/(\d+)h/);
    const mMatch = String(str || "").match(/(\d+)m/);
    const sMatch = String(str || "").match(/(\d+)s/);
    return {
      h: hMatch ? parseInt(hMatch[1], 10) : 0,
      m: mMatch ? parseInt(mMatch[1], 10) : 0,
      s: sMatch ? parseInt(sMatch[1], 10) : 0,
    };
  }

  /**
   * Format committed values into a display string.
   * Omits hours portion if h === 0 (backward-compatible display).
   */
  function formatDuration(h, m, s) {
    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${m}m`);
    parts.push(`${String(s).padStart(2, "0")}s`);
    return parts.join(" ");
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

  // Hours: 0–23, Minutes: 0–59, Seconds: 0–59
  buildList(hrsScroll, 24);
  buildList(minScroll, 60);
  buildList(secScroll, 60);

  let committed = parseValue(savedValue);
  let isOpen = false;

  function open() {
    isOpen = true;
    panel.style.display = "block";
    chevron.style.transform = "rotate(180deg)";
    scrollToValue(hrsScroll, committed.h, false);
    scrollToValue(minScroll, committed.m, false);
    scrollToValue(secScroll, committed.s, false);
    setTimeout(() => {
      highlightCurrent(hrsScroll);
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
    const h = scrollTopToValue(hrsScroll.scrollTop);
    const m = scrollTopToValue(minScroll.scrollTop);
    const s = scrollTopToValue(secScroll.scrollTop);
    scrollToValue(hrsScroll, h, false);
    scrollToValue(minScroll, m, false);
    scrollToValue(secScroll, s, false);
    committed = { h, m, s };
    const txt = formatDuration(h, m, s);
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
    // Use scrollend if available (Chrome 114+, Firefox 109+)
    // Fall back to a longer passive debounce on older/iOS browsers
    const evtName = "onscrollend" in window ? "scrollend" : "scroll";
    let t;

    scrollEl.addEventListener(evtName, () => {
      if (evtName === "scrollend") {
        // scrollend fires only once, after inertia fully settles — no debounce needed
        const v = scrollTopToValue(scrollEl.scrollTop);
        scrollToValue(scrollEl, v, true);
        highlightCurrent(scrollEl);
      } else {
        // Fallback: debounce but with a longer delay so mobile inertia can finish
        clearTimeout(t);
        t = setTimeout(() => {
          const v = scrollTopToValue(scrollEl.scrollTop);
          scrollToValue(scrollEl, v, true);
          highlightCurrent(scrollEl);
        }, 150);
      }
    }, { passive: true });
  }

  attachSnap(hrsScroll);
  attachSnap(minScroll);
  attachSnap(secScroll);

  document.addEventListener("click", (e) => {
    if (isOpen && !wrap.contains(e.target)) close();
  });

  if (committed.h || committed.m || committed.s) {
    setTimeout(() => {
      highlightCurrent(hrsScroll);
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
// CLEAR EPISODE
// ─────────────────────────────────────────
async function handleClearEpisode(card, seriesId, season, ep, saveBar, series) {
  const wasSaved = !!state.episodes[epKey(seriesId, season, ep)];

  if (wasSaved) {
    const confirmed = await msConfirm({
      title:   `Clear Episode ${ep}?`,
      message: "This will permanently remove all saved data for this episode. This action cannot be undone.",
      warning: "Remarks, rating, duration, and date watched will be cleared.",
    });
    if (!confirmed) return;
  }

  // ── Reset all DOM inputs ──
  const titleInput  = card.querySelector(".ep-title");
  const remarksArea = card.querySelector(".ep-remarks");
  const ratingSelect= card.querySelector(".ep-rating");
  const dateInput   = card.querySelector(".ep-date");
  const dpTrigger   = card.querySelector(".dp-trigger");
  const dpDisplay   = card.querySelector(".dp-display");

  if (titleInput)   titleInput.value   = "";
  if (remarksArea)  remarksArea.value  = "";
  if (ratingSelect) ratingSelect.value = "";
  if (dateInput)    dateInput.value    = "";
  if (dpTrigger)    dpTrigger.dataset.value = "";
  if (dpDisplay)    dpDisplay.textContent   = "Select duration";

  // Reset card visual state
  card.classList.remove("is-saved", "has-changes");
  const dot = card.querySelector(".ep-saved-dot");
  if (dot) dot.remove();

  if (!wasSaved) {
    // Nothing saved — just a local wipe, no API call needed
    return;
  }

  // ── Delete from backend ──
  const clearBtn = card.querySelector(".ep-clear-btn");
  try {
    if (clearBtn) { clearBtn.disabled = true; clearBtn.style.opacity = "0.5"; }
    await withLoading(() => api("clearEpisode", token(), seriesId, season, ep));

    // Remove from local state
    delete state.episodes[epKey(seriesId, season, ep)];

    // Hide save bar if no other cards in this season have unsaved changes
    const panelEl = card.closest(".season-panel");
    const anyDirty = panelEl
      ? [...panelEl.querySelectorAll(".episode-card.has-changes")].length > 0
      : false;
    if (!anyDirty) saveBar?.classList.remove("visible");

    // Refresh card count / progress bar on the series card
    const seriesIdx = state.series.findIndex(s => s.seriesId === seriesId);
    rerenderCard(seriesIdx, seriesId);
    updateStats();

    showAlert(`Episode ${ep} cleared.`, "success");
  } catch (err) {
    showAlert(err.message, "danger");
  } finally {
    if (clearBtn) { clearBtn.disabled = false; clearBtn.style.opacity = ""; }
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
  const cacheKey = `${seriesId}::${season}`;
  const cache    = episodeCardCache[cacheKey] || {};

  for (let ep = 1; ep <= numEpisodes; ep++) {
    // Prefer cached card (covers all pages); fall back to live DOM
    const card = cache[ep] || panel.querySelector(`[data-ep="${ep}"]`);
    if (!card) continue;

    const episodeTitle = card.querySelector(".ep-title")?.value.trim()     || "";
    const remarks      = card.querySelector(".ep-remarks")?.value.trim()   || "";
    const duration     = card.querySelector(".dp-trigger")?.dataset.value  || "";
    const rating       = card.querySelector(".ep-rating")?.value           || "";
    const dateWatched  = card.querySelector(".ep-date")?.value             || "";

    if (episodeTitle || remarks || duration || rating || dateWatched) {
      episodesPayload.push({
        episode: ep,
        episodeTitle,
        remarks,
        duration,
        rating: Number(rating) || 0,
        dateWatched
      });
    }
  }

  if (!episodesPayload.length) {
    showAlert("Fill in at least one episode's details before saving.", "warning");
    return;
  }

  try {
    toggleBtn(btn, true);
    await withLoading(() => api("saveSeasonEpisodes", token(), seriesId, season, episodesPayload));

    showAlert(`Season ${season} saved!`, "success");

    episodesPayload.forEach(ep => {
      const k = epKey(seriesId, season, ep.episode);
      state.episodes[k] = { ...ep, seriesId, season, savedAt: new Date().toISOString() };
    });

    // Update visual state on ALL cached cards, not just visible ones
    for (let ep = 1; ep <= numEpisodes; ep++) {
      const card = cache[ep] || panel.querySelector(`[data-ep="${ep}"]`);
      if (!card) continue;
      const wasSaved = episodesPayload.find(e => e.episode === ep);
      if (wasSaved) {
        card.classList.add("is-saved");
        card.classList.remove("has-changes");
        const label = card.querySelector(".ep-label");
        if (label && !label.querySelector(".ep-saved-dot")) {
          label.insertAdjacentHTML("beforeend", `<span class="ep-saved-dot"></span>`);
        }
      }
    }

    saveBar?.classList.remove("visible");
    const seriesIdx = state.series.findIndex(s => s.seriesId === seriesId);
    rerenderCard(seriesIdx, seriesId);
    updateStats();
  } catch (err) {
    showAlert(err.message, "danger");
  } finally {
    toggleBtn(btn, false);
  }
}

// ── MAIN ENTRY POINT ──────────────────────────────────────────────────────────
function renderGallery() {
  const section = $("gallerySection");
  if (!section) return;
  const items = [...state.series];
  if (!items.length) { section.classList.add("d-none"); return; }

  // Respect the user's saved visibility preference
  const savedVisible = localStorage.getItem(GALLERY_STORAGE_KEY);
  const shouldShow   = savedVisible === null ? true : savedVisible === "true";
  section.classList.toggle("d-none", !shouldShow);

  // Keep the toggle switch in sync
  const toggle = $("galleryToggle");
  if (toggle) toggle.setAttribute("aria-checked", String(shouldShow));

  if (!shouldShow) return; // no need to build slides if hidden

  if (galState2.seriesIdx >= items.length) galState2.seriesIdx = 0;
  buildGalleryNav(items);
  buildGalleryStage(items[galState2.seriesIdx]);
}
 
// ── NAV BAR ───────────────────────────────────────────────────────────────────
function buildGalleryNav(items) {
  const navBar = $("galNavBar2");
  if (!navBar) return;
  navBar.innerHTML = "";
  items.forEach((series, i) => {
    const pill = document.createElement("button");
    pill.type      = "button";
    pill.className = "gal2-nav-pill" + (i === galState2.seriesIdx ? " active" : "");
    pill.textContent = series.title;
    pill.addEventListener("click", () => {
      galState2.seriesIdx = i;
      galState2.slideIdx  = 0;
      navBar.querySelectorAll(".gal2-nav-pill").forEach((p, j) =>
        p.classList.toggle("active", j === i)
      );
      buildGalleryStage(items[i]);
    });
    navBar.appendChild(pill);
  });
}
 
// ── STAGE ─────────────────────────────────────────────────────────────────────
function buildGalleryStage(series) {
  const stage    = $("galStage2");
  const dotsWrap = $("galDots2");
  const prevBtn  = $("galPrevBtn2");
  const nextBtn  = $("galNextBtn2");
  if (!stage) return;
 
  const slides = buildGallerySlides(series);
  galState2.slides   = slides;
  galState2.slideIdx = 0;
 
  stage.innerHTML = "";
  slides.forEach((slide, i) => {
    stage.appendChild(buildGallerySlideEl(slide, i === 0));
  });
 
  // Dots
  if (dotsWrap) {
    dotsWrap.innerHTML = "";
    const max = Math.min(slides.length, 40);
    for (let i = 0; i < max; i++) {
      const dot = document.createElement("button");
      dot.type      = "button";
      dot.className = "gal2-dot" + (i === 0 ? " active" : "");
      dot.setAttribute("aria-label", `Slide ${i + 1}`);
      dot.addEventListener("click", () => galGoTo(i));
      dotsWrap.appendChild(dot);
    }
  }
 
  if (prevBtn) prevBtn.onclick = () => galGoTo(galState2.slideIdx - 1);
  if (nextBtn) nextBtn.onclick = () => galGoTo(galState2.slideIdx + 1);
 
  galUpdateNavBtns();
}
 
// ── SLIDE LIST ────────────────────────────────────────────────────────────────
function buildGallerySlides(series) {
  const slides = [{ type: "hero", series }];
  for (let s = 1; s <= series.numSeasons; s++) {
    const numEps      = getEpsForSeason(series, s);
    const seasonLabel = getSeasonLabel(series, s);
    for (let ep = 1; ep <= numEps; ep++) {
      const data = state.episodes[epKey(series.seriesId, s, ep)] || null;
      slides.push({ type: "ep", season: s, seasonLabel, ep, numEps, data });
    }
  }
  return slides;
}
 
// ── BUILD SLIDE ELEMENT ───────────────────────────────────────────────────────
function buildGallerySlideEl(slide, isActive) {
  const el = document.createElement("div");
  el.className = "gal2-slide" + (isActive ? " active" : "");
 
  if (slide.type === "hero") {
    const series  = slide.series;
    let totalEps  = 0;
    for (let s = 1; s <= series.numSeasons; s++) totalEps += getEpsForSeason(series, s);
    const seasonRange = series.numSeasons === 1 ? "S1" : `S1\u2013S${series.numSeasons}`;
    const coverUrl = series.coverImageUrl ? series.coverImageUrl : "";
    if (coverUrl) {
      el.style.setProperty("--hero-cover", `url('${coverUrl}')`);
      el.classList.add("has-cover"); // ← add this line
    }
    el.innerHTML = `
      <div class="gal2-hero-content">
        <div class="gal2-series-name">${escapeHtml(series.title)}</div>
        <div class="gal2-series-sub">${seasonRange} 󠁯•󠁏 ${totalEps} Episodes</div>
      </div>`;
  } else {
    const { seasonLabel, ep, numEps, data } = slide;
    const remarks     = (data?.remarks    || "").trim();
    const rating      = data?.rating      ? Number(data.rating) : 0;
    const dateWatched = data?.dateWatched || "";
    const duration    = data?.duration    || "";
    const episodeTitle    = data?.episodeTitle    || "";
 
    const pills = [];
    if (rating)      pills.push(`<span class="gal2-pill gal2-pill-amber"><i class="bi bi-star-fill"></i> ${rating}/5</span>`);
    if (dateWatched) pills.push(`<span class="gal2-pill gal2-pill-teal"><i class="bi bi-calendar3"></i> ${formatDate(dateWatched)}</span>`);
    if (duration)    pills.push(`<span class="gal2-pill"><i class="bi bi-clock"></i> ${escapeHtml(duration)}</span>`);
    if (!data)       pills.push(`<span class="gal2-pill gal2-pill-muted">Not yet watched</span>`);
 
    el.innerHTML = `
      <div class="gal2-ep-content">
        <div class="gal2-ep-season">${escapeHtml(seasonLabel)}</div>
        <div class="gal2-ep-num">Episode ${ep} of ${numEps}</div>
        <div class="gal2-ep-title">${episodeTitle || ""}</div>
        <div class="gal2-ep-remarks${remarks ? "" : " is-empty"}">${escapeHtml(remarks) || "No remarks yet."}</div>
        <div class="gal2-ep-pills">${pills.join("")}</div>
      </div>`;
  }
  return el;
}
 
// ── GO TO SLIDE ───────────────────────────────────────────────────────────────
function galGoTo(idx) {
  const stage    = $("galStage2");
  const dotsWrap = $("galDots2");
  if (!stage) return;
  if (idx < 0 || idx >= galState2.slides.length) return;
 
  stage.querySelectorAll(".gal2-slide").forEach((el, i) =>
    el.classList.toggle("active", i === idx)
  );
  dotsWrap?.querySelectorAll(".gal2-dot").forEach((d, i) =>
    d.classList.toggle("active", i === idx)
  );
  galState2.slideIdx = idx;
  galUpdateNavBtns();
}
 
// ── UPDATE PREV / NEXT BUTTON STATES ─────────────────────────────────────────
function galUpdateNavBtns() {
  const prevBtn = $("galPrevBtn2");
  const nextBtn = $("galNextBtn2");
  const atStart = galState2.slideIdx <= 0;
  const atEnd   = galState2.slideIdx >= galState2.slides.length - 1;
 
  if (prevBtn) {
    prevBtn.disabled      = atStart;
    prevBtn.style.opacity = atStart ? "0.28" : "1";
    prevBtn.style.cursor  = atStart ? "not-allowed" : "pointer";
  }
  if (nextBtn) {
    nextBtn.disabled      = atEnd;
    nextBtn.style.opacity = atEnd ? "0.28" : "1";
    nextBtn.style.cursor  = atEnd ? "not-allowed" : "pointer";
  }
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
