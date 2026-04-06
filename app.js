window.APP_CONFIG = {
  API_URL: "https://script.google.com/macros/s/AKfycbzPER-flrF1jIbkicpGHELNLmWbqob2q6_ACSHV3eRMR_fgBlml2TsKne8xPcQTxnPPbg/exec"
};

const $ = (id) => document.getElementById(id);
const API_URL = window.APP_CONFIG.API_URL;
const STORAGE_KEY = "movieFeedUser";

const state = {
  currentUser: null,
  feed: [],
  isEditing: false,
  alertTimers: new Map(),
  loadingCount: 0,
  notifications: [],
  notifOpen: false
};

document.addEventListener("DOMContentLoaded", bootstrap);

async function bootstrap() {
  bindEvents();
  await restoreSession();
}

function bindEvents() {
  const bind = (id, eventName, handler) => {
    const el = $(id);
    if (!el) {
      console.warn(`Missing element: #${id}`);
      return;
    }
    el.addEventListener(eventName, handler);
  };

  bind("loginForm", "submit", handleLogin);
  bind("logoutBtn", "click", handleLogout);
  bind("postForm", "submit", handleSavePost);
  bind("cancelEditBtn", "click", resetPostForm);
  bind("feedSearch", "input", handleFeedSearch);
  bind("notifBtn", "click", toggleNotifications);

  document.addEventListener("click", (event) => {
    const wrap = document.querySelector(".notif-wrap");
    if (!wrap) return;

    if (!wrap.contains(event.target)) {
      closeNotifications();
    }
  });
}

async function api(method, ...args) {
  if (!API_URL || API_URL.includes("PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE")) {
    throw new Error("Set your Apps Script Web App URL in app.js first.");
  }

  const body = new URLSearchParams({
    method,
    args: JSON.stringify(args)
  });

  const response = await fetch(API_URL, {
    method: "POST",
    body
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  let result;
  try {
    result = JSON.parse(text);
  } catch (error) {
    console.error("Non-JSON response:", text);
    throw new Error("Backend did not return valid JSON.");
  }

  if (!result.ok) {
    throw new Error(result.error || "Something went wrong.");
  }

  return result.data;
}

function withLoading(fn) {
  return async (...args) => {
    try {
      showLoading(true);
      return await fn(...args);
    } finally {
      showLoading(false);
    }
  };
}

function showLoading(show) {
  const overlay = $("loadingOverlay");
  if (!overlay) return;

  state.loadingCount += show ? 1 : -1;
  state.loadingCount = Math.max(0, state.loadingCount);
  overlay.classList.toggle("d-none", state.loadingCount === 0);
}

function showSection(isLoggedIn) {
  $("loginSection")?.classList.toggle("d-none", isLoggedIn);
  $("appSection")?.classList.toggle("d-none", !isLoggedIn);
}

function showAlert(message, type = "danger", duration = 5000) {
  const wrap = $("globalAlertWrap");
  if (!wrap) return;

  const alertId = `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const alertEl = document.createElement("div");
  alertEl.className = `alert alert-${type} alert-dismissible fade show`;
  alertEl.id = alertId;
  alertEl.role = "alert";

  alertEl.innerHTML = `
    <div class="d-flex align-items-start justify-content-between gap-3">
      <div>${escapeHtml(message)}</div>
      <button type="button" class="btn-close ${type === "success" ? "" : "btn-close-white"}" aria-label="Close"></button>
    </div>
  `;

  alertEl.querySelector(".btn-close")?.addEventListener("click", () => removeAlert(alertId));
  wrap.appendChild(alertEl);

  const timer = setTimeout(() => removeAlert(alertId), duration);
  state.alertTimers.set(alertId, timer);
}

function removeAlert(alertId) {
  const el = document.getElementById(alertId);
  if (!el) return;

  const timer = state.alertTimers.get(alertId);
  if (timer) {
    clearTimeout(timer);
    state.alertTimers.delete(alertId);
  }

  el.classList.remove("show");
  setTimeout(() => el.remove(), 200);
}

function hideAlerts() {
  const wrap = $("globalAlertWrap");
  if (wrap) wrap.innerHTML = "";
  state.alertTimers.forEach((timer) => clearTimeout(timer));
  state.alertTimers.clear();
}

function saveSession(user) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

function getSessionToken() {
  return state.currentUser?.sessionToken || "";
}

async function handleLogin(event) {
  event.preventDefault();
  hideAlerts();

  const username = $("loginUsername")?.value.trim() || "";
  const password = $("loginPassword")?.value.trim() || "";
  const submitBtn = event.submitter;

  try {
    toggleButton(submitBtn, true);
    const user = await withLoading(() => api("login", username, password))();
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
      await withLoading(() => api("logout", getSessionToken()))();
    }
  } catch (error) {
    console.warn("Logout request failed:", error);
  }

  state.currentUser = null;
  state.feed = [];
  state.isEditing = false;
  state.notifications = [];
  state.notifOpen = false;

  clearSession();
  $("loginForm")?.reset();
  resetPostForm();
  setProfile(null);

  if ($("feedList")) $("feedList").innerHTML = "";
  if ($("feedCountBadge")) $("feedCountBadge").textContent = "0 posts";
  $("emptyFeed")?.classList.add("d-none");

  $("notifDropdown")?.classList.add("d-none");
  if ($("notifList")) {
    $("notifList").innerHTML = `<div class="p-3 text-secondary-light small">No notifications yet.</div>`;
  }
  $("notifBadge")?.classList.add("d-none");

  hideAlerts();
  showSection(false);
}

async function restoreSession() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    showSection(false);
    return;
  }

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
  const displayName = $("displayName");
  const profileAvatar = $("profileAvatar");
  const fallbackAvatar = $("fallbackAvatar");

  if (displayName) {
    displayName.textContent = user?.name || user?.username || "User";
  }

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

async function refreshFeed() {
  if (!state.currentUser) return;

  try {
    const [feed, notifications] = await Promise.all([
      withLoading(() => api("getFeed", getSessionToken()))(),
      withLoading(() => api("getNotifications", getSessionToken()))()
    ]);

    state.feed = Array.isArray(feed) ? feed : [];
    state.notifications = Array.isArray(notifications) ? notifications : [];

    applyFeedFilter();
    renderNotifications();
  } catch (error) {
    showAlert(error.message, "danger");
    if (/Session expired/i.test(error.message)) {
      await handleLogout();
    }
  }
}

function handleFeedSearch() {
  applyFeedFilter();
}

function applyFeedFilter() {
  const query = ($("feedSearch")?.value || "").trim().toLowerCase();

  if (!query) {
    renderFeed(state.feed);
    return;
  }

  const filteredFeed = state.feed.filter((post) => {
    const haystack = [
      post.movieName,
      post.genre,
      post.caption,
      post.username,
      post.name,
      post.duration,
      ...(post.comments || []).map(
        (comment) => `${comment.name} ${comment.username} ${comment.comment}`
      )
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  });

  renderFeed(filteredFeed);
}

function toggleNotifications() {
  state.notifOpen = !state.notifOpen;
  $("notifDropdown")?.classList.toggle("d-none", !state.notifOpen);

  if (state.notifOpen) {
    markNotificationsRead();
  }
}

function closeNotifications() {
  state.notifOpen = false;
  $("notifDropdown")?.classList.add("d-none");
}

function renderNotifications() {
  const notifList = $("notifList");
  const notifBadge = $("notifBadge");

  if (!notifList || !notifBadge) return;

  const items = Array.isArray(state.notifications) ? state.notifications : [];
  const unreadCount = items.filter((item) => !item.isRead).length;

  notifBadge.textContent = String(unreadCount);
  notifBadge.classList.toggle("d-none", unreadCount === 0);

  if (!items.length) {
    notifList.innerHTML = `<div class="p-3 text-secondary-light small">No notifications yet.</div>`;
    return;
  }

  notifList.innerHTML = "";

  items.forEach((item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `notif-item ${item.isRead ? "" : "unread"}`;

    btn.innerHTML = `
      <div class="notif-item-title">${escapeHtml(item.message || "")}</div>
      <div class="notif-item-time">${formatDateTime(item.createdAt)}</div>
    `;

    btn.addEventListener("click", () => {
      closeNotifications();
      if (item.postId) {
        scrollToPost(item.postId);
      }
    });

    notifList.appendChild(btn);
  });
}

async function markNotificationsRead() {
  const unread = state.notifications.filter((item) => !item.isRead);
  if (!unread.length) return;

  try {
    await api("markNotificationsRead", getSessionToken());

    state.notifications = state.notifications.map((item) => ({
      ...item,
      isRead: true
    }));

    renderNotifications();
  } catch (error) {
    console.error("Failed to mark notifications as read:", error);
  }
}

function scrollToPost(postId) {
  const selector = `[data-post-id="${cssEscape(postId)}"]`;
  const postEl = document.querySelector(selector);
  if (!postEl) return;

  postEl.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });

  postEl.classList.add("post-highlight");
  setTimeout(() => postEl.classList.remove("post-highlight"), 1800);
}

async function handleSavePost(event) {
  event.preventDefault();
  hideAlerts();

  const postId = $("postId")?.value.trim() || "";
  const movieName = $("movieName")?.value.trim() || "";
  const genre = $("genre")?.value || "";
  const rating = $("rating")?.value || "";
  const dateWatched = $("dateWatched")?.value || "";
  const duration = $("duration")?.value.trim() || "";
  const caption = $("caption")?.value.trim() || "";
  const submitBtn = event.submitter;

  try {
    toggleButton(submitBtn, true);

    await withLoading(async () => {
      if (state.isEditing && postId) {
        await api(
          "updatePost",
          getSessionToken(),
          postId,
          movieName,
          genre,
          rating,
          dateWatched,
          duration,
          caption
        );
        showAlert("Post updated successfully.", "success");
      } else {
        await api(
          "createPost",
          getSessionToken(),
          movieName,
          genre,
          rating,
          dateWatched,
          duration,
          caption
        );
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

function renderFeed(feed) {
  const feedList = $("feedList");
  const emptyFeed = $("emptyFeed");
  const feedCountBadge = $("feedCountBadge");

  if (!feedList || !emptyFeed || !feedCountBadge) return;

  feedList.innerHTML = "";
  feedCountBadge.textContent = `${feed.length} post${feed.length !== 1 ? "s" : ""}`;
  emptyFeed.classList.toggle("d-none", feed.length > 0);

  feed.forEach((post) => {
    feedList.appendChild(renderPostCard(post));
  });
}

function renderPostCard(post) {
  const card = document.createElement("div");
  card.className = "glass-card post-card p-4 mb-4";
  card.setAttribute("data-post-id", post.postId);

  const canEditPost = state.currentUser && state.currentUser.username === post.username;

  card.innerHTML = `
    <div class="d-flex justify-content-between gap-3 flex-wrap">
      <div class="d-flex gap-3 align-items-start">
        ${
          post.avatar
            ? `<img src="${escapeHtml(post.avatar)}" class="avatar-img" alt="avatar">`
            : `<div class="avatar-fallback"><i class="bi bi-person-fill"></i></div>`
        }
        <div>
          <div class="fw-bold">${escapeHtml(post.name || post.username)}</div>
          <div class="text-secondary-light small">@${escapeHtml(post.username)}</div>
          <div class="text-secondary-light small mt-1">${formatDateTime(post.createdAt)}</div>
        </div>
      </div>

      ${
        canEditPost
          ? `
        <div class="d-flex gap-2">
          <button class="btn btn-sm btn-warning-soft edit-post-btn align-self-start" type="button">
            <i class="bi bi-pencil-square"></i>
          </button>
          <button class="btn btn-sm btn-danger-soft delete-post-btn align-self-start" type="button">
            <i class="bi bi-trash"></i>
          </button>
        </div>
      `
          : ""
      }
    </div>

    <div class="mt-4">
      <h3 class="h4 fw-bold mb-2">${escapeHtml(post.movieName)}</h3>

      <div class="post-meta mb-3">
        <span class="meta-pill">${escapeHtml(post.genre || "-")}</span>
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
    post.comments.forEach((comment) => {
      commentsList.appendChild(renderCommentItem(comment));
    });
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
        ${
          comment.avatar
            ? `<img src="${escapeHtml(comment.avatar)}" class="comment-avatar" alt="avatar">`
            : `<div class="comment-avatar fallback"><i class="bi bi-person-fill"></i></div>`
        }
        <div>
          <div class="small fw-semibold">${escapeHtml(comment.name || comment.username)}</div>
          <div class="small text-secondary-light smx-font">${escapeHtml(comment.comment)}</div>
          <div class="small text-secondary smx-font mt-1">${formatDateTime(comment.createdAt)}</div>
        </div>
      </div>
      ${
        canDeleteComment
          ? `
        <button class="btn btn-sm btn-link text-danger delete-comment-btn p-3 align-self-center" type="button" data-comment-id="${escapeHtml(comment.commentId)}">
          <i class="bi bi-x-circle lgx-font"></i>
        </button>
      `
          : ""
      }
    </div>
  `;

  return item;
}

function bindPostCardEvents(card, post, canEditPost) {
  const commentForm = card.querySelector(".comment-form");
  const commentInput = card.querySelector(".comment-input");

  commentForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = commentInput.value.trim();
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

function startEdit(post) {
  state.isEditing = true;

  $("postId").value = post.postId || "";
  $("movieName").value = post.movieName || "";
  $("genre").value = post.genre || "";
  $("rating").value = String(post.rating || "");
  $("dateWatched").value = normalizeDateForInput(post.dateWatched);
  $("duration").value = post.duration || "";
  $("caption").value = post.caption || "";

  $("formTitle").textContent = "Edit Post";
  $("submitBtn").innerHTML = `<i class="bi bi-save me-2"></i>Save Changes`;
  $("cancelEditBtn").classList.remove("d-none");

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetPostForm() {
  state.isEditing = false;
  $("postForm")?.reset();
  $("postId").value = "";
  $("formTitle").textContent = "Create Post";
  $("submitBtn").innerHTML = `<i class="bi bi-send me-2"></i>Post Movie`;
  $("cancelEditBtn").classList.add("d-none");
}

function toggleButton(button, disabled) {
  if (!button) return;
  button.disabled = disabled;
  button.setAttribute("aria-disabled", String(disabled));
}

function renderStars(rating) {
  const n = Number(rating || 0);
  return n > 0 ? "⭐".repeat(n) : "-";
}

function formatDate(value) {
  if (!value) return "-";

  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split("-").map(Number);
    const d = new Date(year, month - 1, day);
    return d.toLocaleDateString("en-PH", {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  }

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;

  return d.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function formatDateTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;

  return d.toLocaleString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function normalizeDateForInput(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }

  return String(value).replace(/["\\]/g, "\\$&");
}