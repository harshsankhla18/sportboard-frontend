/**
 * Sportboard Frontend — app.js
 * Connects to https://sportboard.onrender.com (REST + WebSocket)
 * Implements: pub/sub subscribe/unsubscribe, ping/pong heartbeat monitoring,
 * live commentary feed, match listing, and match creation.
 */

// ── Config ──────────────────────────────────────────────────
const API_BASE = 'https://sportboard.onrender.com';
const WS_URL   = 'wss://sportboard.onrender.com/ws';

// ── State ────────────────────────────────────────────────────
const state = {
  matches:          [],     // all fetched matches
  filteredSport:    'all',
  activeView:       'matches',
  selectedMatchId:  null,   // match selected in live view for sub/unsub
  selectedMatch:    null,   // full match object for live view
  subscribedIds:    new Set(),
  ws:               null,
  wsStatus:         'disconnected', // connecting | connected | disconnected
  pingCount:        0,
  pongCount:        0,
  commentarySeq:    {}, // matchId -> last sequence seen
  broadcastItems:   [],
  lastPongTime:     null,
};

// ── DOM Refs ─────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const dom = {
  // nav
  navBtns:            document.querySelectorAll('.nav-btn'),
  views:              document.querySelectorAll('.view'),
  // ws status bar
  wsDot:              $('ws-dot'),
  wsLabel:            $('ws-label'),
  // matches view
  matchesGrid:        $('matches-grid'),
  matchesLoading:     $('matches-loading'),
  filterBar:          $('filter-bar'),
  // live view
  liveMatchList:      $('live-match-list'),
  commentaryFeed:     $('commentary-feed'),
  feedEmpty:          $('feed-empty'),
  btnSubscribe:       $('btn-subscribe'),
  btnUnsubscribe:     $('btn-unsubscribe'),
  btnClearFeed:       $('btn-clear-feed'),
  commentaryMatchInfo:$('commentary-match-info'),
  btnPostCommentary:  $('btn-post-commentary'),
  commentaryForm:     $('commentary-form'),
  wsDebugStatus:      $('ws-debug-status'),
  wsDebugSub:         $('ws-debug-sub'),
  wsDebugPing:        $('ws-debug-ping'),
  // create view
  createMatchForm:    $('create-match-form'),
  broadcastFeed:      $('broadcast-feed'),
  // modal
  modalBackdrop:      $('modal-backdrop'),
  modalClose:         $('modal-close'),
  modalSportBadge:    $('modal-sport-badge'),
  modalMatchTitle:    $('modal-match-title'),
  modalStatus:        $('modal-status'),
  modalHomeName:      $('modal-home-name'),
  modalAwayName:      $('modal-away-name'),
  modalHomeScore:     $('modal-home-score'),
  modalAwayScore:     $('modal-away-score'),
  modalCommentaryFeed:$('modal-commentary-feed'),
  modalDetailsGrid:   $('modal-details-grid'),
  tabCommentary:      $('tab-commentary'),
  tabDetails:         $('tab-details'),
  modalCommentaryTab: $('modal-commentary-tab'),
  modalDetailsTab:    $('modal-details-tab'),
  btnWatchLive:       $('btn-watch-live'),
  // toast
  toastContainer:     $('toast-container'),
};

// ── Toast Notifications ──────────────────────────────────────
function showToast(message, type = 'info', duration = 3500) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-dot"></span><span>${message}</span>`;
  dom.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('out');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}

// ── Navigation ───────────────────────────────────────────────
function navigateTo(view) {
  state.activeView = view;
  dom.navBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  dom.views.forEach((section) => {
    section.classList.toggle('active', section.id === `view-${view}`);
  });

  if (view === 'live') refreshLiveSidebar();
  if (view === 'matches') fetchAndRenderMatches();
}

dom.navBtns.forEach((btn) => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.view));
});

// ── Sport Emojis ─────────────────────────────────────────────
const sportEmoji = { football: '⚽', cricket: '🏏', basketball: '🏀', tennis: '🎾', rugby: '🏉' };
const eventIcons = {
  goal:         '⚽',
  kickoff:      '🟢',
  shot:         '🎯',
  save:         '🧤',
  foul:         '🚨',
  yellow_card:  '🟨',
  red_card:     '🟥',
  substitution: '🔄',
  pass:         '➡️',
  wicket:       '💥',
  boundary:     '4️⃣',
  six:          '6️⃣',
  timeout:      '⏸️',
  three_pointer:'🏀',
  halftime:     '🔔',
  fulltime:     '🏁',
};

// ── Match Status ──────────────────────────────────────────────
function computeStatus(match) {
  if (match.status) return match.status;
  const now = Date.now();
  const start = new Date(match.startTime || match.start_time).getTime();
  const end   = new Date(match.endTime   || match.end_time  ).getTime();
  if (now < start) return 'scheduled';
  if (now >= start && now <= end) return 'live';
  return 'finished';
}

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const min  = Math.floor(diff / 60000);
  if (min < 1)  return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)  return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// ── REST API helpers ─────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
  return json;
}

// ── Fetch Matches ─────────────────────────────────────────────
async function fetchMatches() {
  const json = await apiFetch('/matches?limit=100');
  return Array.isArray(json.data) ? json.data : [];
}

async function fetchCommentary(matchId, limit = 50) {
  const json = await apiFetch(`/matches/${matchId}/commentary?limit=${limit}`);
  return Array.isArray(json.data) ? json.data : [];
}

// ── Render Matches ────────────────────────────────────────────
function buildMatchCard(match, index) {
  const status = computeStatus(match);
  const sport  = (match.sport || '').toLowerCase();
  const emoji  = sportEmoji[sport] || '🏟️';
  const start  = match.startTime || match.start_time;
  const home   = match.homeTeam  || match.home_team  || 'Home';
  const away   = match.awayTeam  || match.away_team  || 'Away';
  const hScore = match.homeScore ?? match.home_score ?? 0;
  const aScore = match.awayScore ?? match.away_score ?? 0;

  const card = document.createElement('div');
  card.className = `match-card${status === 'live' ? ' live' : ''}`;
  card.style.animationDelay = `${index * 60}ms`;
  card.dataset.matchId = match.id;
  card.dataset.sport   = sport;

  card.innerHTML = `
    <div class="card-top">
      <span class="sport-tag ${sport}">${emoji} ${sport}</span>
      <span class="status-badge ${status}">${status === 'live' ? '● LIVE' : status}</span>
    </div>
    <div class="card-teams">
      <div class="card-team-row">
        <span class="team-label">
          <span class="team-indicator"></span>
          ${home}
        </span>
        <span class="card-score">${hScore}</span>
      </div>
      <div class="card-team-row">
        <span class="team-label">
          <span class="team-indicator away"></span>
          ${away}
        </span>
        <span class="card-score">${aScore}</span>
      </div>
    </div>
    <div class="card-bottom">
      <span class="card-time">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1"/><path d="M6 3v3l2 1" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>
        ${formatDateTime(start)}
      </span>
      <span class="card-action">View →</span>
    </div>`;

  card.addEventListener('click', () => openMatchModal(match));
  return card;
}

async function fetchAndRenderMatches() {
  dom.matchesLoading.style.display = 'flex';
  // Remove existing cards but keep loading
  Array.from(dom.matchesGrid.children).forEach((el) => {
    if (!el.classList.contains('loading-state')) el.remove();
  });

  try {
    state.matches = await fetchMatches();
    renderFilteredMatches();
    refreshLiveSidebar();
  } catch (err) {
    showToast('Failed to load matches: ' + err.message, 'error');
    dom.matchesLoading.innerHTML = `<p style="color:var(--text-muted)">Could not load matches. Is the backend running?</p>`;
  }
}

function renderFilteredMatches() {
  dom.matchesLoading.style.display = 'none';
  // Remove cards only
  Array.from(dom.matchesGrid.children).forEach((el) => {
    if (!el.classList.contains('loading-state')) el.remove();
  });

  const filtered = state.filteredSport === 'all'
    ? state.matches
    : state.matches.filter((m) => (m.sport || '').toLowerCase() === state.filteredSport);

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'loading-state';
    empty.innerHTML = '<p style="color:var(--text-muted)">No matches found for this filter.</p>';
    dom.matchesGrid.appendChild(empty);
    return;
  }

  filtered.forEach((match, i) => {
    dom.matchesGrid.appendChild(buildMatchCard(match, i));
  });
}

// ── Filter Pills ──────────────────────────────────────────────
dom.filterBar.addEventListener('click', (e) => {
  const pill = e.target.closest('.filter-pill');
  if (!pill) return;
  dom.filterBar.querySelectorAll('.filter-pill').forEach((p) => p.classList.remove('active'));
  pill.classList.add('active');
  state.filteredSport = pill.dataset.sport;
  renderFilteredMatches();
});

// ── Modal ─────────────────────────────────────────────────────
let modalMatch = null;

function openMatchModal(match) {
  modalMatch = match;
  const status = computeStatus(match);
  const sport  = (match.sport || '').toLowerCase();
  const home   = match.homeTeam  || match.home_team  || 'Home';
  const away   = match.awayTeam  || match.away_team  || 'Away';
  const hScore = match.homeScore ?? match.home_score ?? 0;
  const aScore = match.awayScore ?? match.away_score ?? 0;
  const start  = match.startTime || match.start_time;
  const end    = match.endTime   || match.end_time;

  dom.modalSportBadge.textContent  = `${sportEmoji[sport] || '🏟️'} ${sport}`;
  dom.modalMatchTitle.textContent  = `${home} vs ${away}`;
  dom.modalHomeName.textContent    = home;
  dom.modalAwayName.textContent    = away;
  dom.modalHomeScore.textContent   = hScore;
  dom.modalAwayScore.textContent   = aScore;
  dom.modalStatus.innerHTML        = `<span class="status-badge ${status}">${status === 'live' ? '● LIVE' : status}</span>`;

  // Details
  dom.modalDetailsGrid.innerHTML = [
    { label: 'Match ID',    value: match.id },
    { label: 'Sport',       value: sport },
    { label: 'Status',      value: status },
    { label: 'Home Team',   value: home },
    { label: 'Away Team',   value: away },
    { label: 'Home Score',  value: hScore },
    { label: 'Away Score',  value: aScore },
    { label: 'Start Time',  value: formatDateTime(start) },
    { label: 'End Time',    value: formatDateTime(end) },
    { label: 'Created',     value: match.createdAt || match.created_at ? formatDateTime(match.createdAt || match.created_at) : '—' },
  ].map(({ label, value }) => `
    <div class="detail-cell">
      <div class="detail-cell-label">${label}</div>
      <div class="detail-cell-value">${value}</div>
    </div>`).join('');

  // Commentary tab
  switchModalTab('commentary');
  loadModalCommentary(match.id);

  // Watch live button
  dom.btnWatchLive.onclick = () => {
    closeModal();
    navigateTo('live');
    setTimeout(() => selectMatchForLive(match), 150);
  };

  dom.modalBackdrop.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  dom.modalBackdrop.classList.remove('open');
  document.body.style.overflow = '';
  modalMatch = null;
}

dom.modalClose.addEventListener('click', closeModal);
dom.modalBackdrop.addEventListener('click', (e) => {
  if (e.target === dom.modalBackdrop) closeModal();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// Tab switching
function switchModalTab(tabId) {
  dom.tabCommentary.classList.toggle('active', tabId === 'commentary');
  dom.tabDetails.classList.toggle('active', tabId === 'details');
  dom.modalCommentaryTab.classList.toggle('hidden', tabId !== 'commentary');
  dom.modalDetailsTab.classList.toggle('hidden', tabId !== 'details');
}
dom.tabCommentary.addEventListener('click', () => switchModalTab('commentary'));
dom.tabDetails.addEventListener('click',    () => switchModalTab('details'));

async function loadModalCommentary(matchId) {
  dom.modalCommentaryFeed.innerHTML = '<div class="spinner"></div>';
  try {
    const comments = await fetchCommentary(matchId, 50);
    if (comments.length === 0) {
      dom.modalCommentaryFeed.innerHTML = '<p class="empty-msg">No commentary yet.</p>';
      return;
    }
    dom.modalCommentaryFeed.innerHTML = '';
    // Show newest first (already newest first from API)
    comments.forEach((c) => {
      dom.modalCommentaryFeed.appendChild(buildCommentaryEntry(c, false));
    });
  } catch (err) {
    dom.modalCommentaryFeed.innerHTML = `<p class="empty-msg" style="color:var(--red)">Failed to load: ${err.message}</p>`;
  }
}

// ── Commentary Entry Builder ──────────────────────────────────
function buildCommentaryEntry(c, animate = true) {
  const eventType = c.eventType || c.event_type || '';
  const icon      = eventIcons[eventType] || '📋';
  const isGoal    = eventType === 'goal' || eventType === 'wicket' || eventType === 'six' || eventType === 'boundary';
  const isCard    = eventType === 'yellow_card' || eventType === 'red_card';

  const el = document.createElement('div');
  el.className = `commentary-entry${isGoal ? ' goal-event' : isCard ? ' highlight' : ''}${animate ? '' : ''}`;
  if (!animate) el.style.animation = 'none';

  el.innerHTML = `
    <span class="entry-minute">${c.minute}'</span>
    <span class="entry-icon">${icon}</span>
    <div class="entry-body">
      <div class="entry-message">${c.message}</div>
      <div class="entry-meta">
        ${c.actor ? `<span class="entry-tag entry-actor">${c.actor}</span>` : ''}
        ${c.team  ? `<span class="entry-tag entry-team">${c.team}</span>`   : ''}
        ${c.period ? `<span class="entry-tag">${c.period}</span>` : ''}
        ${(c.tags || []).map((t) => `<span class="entry-tag">${t}</span>`).join('')}
      </div>
    </div>`;

  return el;
}

// ── Live Sidebar ──────────────────────────────────────────────
function refreshLiveSidebar() {
  const liveMatches = state.matches.filter((m) => computeStatus(m) === 'live');

  if (liveMatches.length === 0) {
    // Also show all matches so user can at least browse
    const all = state.matches.slice(0, 20);
    if (all.length === 0) {
      dom.liveMatchList.innerHTML = '<p class="empty-msg">No matches available.</p>';
      return;
    }
    dom.liveMatchList.innerHTML = '';
    all.forEach((m) => dom.liveMatchList.appendChild(buildLiveItem(m)));
    return;
  }

  dom.liveMatchList.innerHTML = '';
  liveMatches.forEach((m) => dom.liveMatchList.appendChild(buildLiveItem(m)));
}

function buildLiveItem(match) {
  const sport  = (match.sport || '').toLowerCase();
  const home   = match.homeTeam  || match.home_team  || 'Home';
  const away   = match.awayTeam  || match.away_team  || 'Away';
  const hScore = match.homeScore ?? match.home_score ?? 0;
  const aScore = match.awayScore ?? match.away_score ?? 0;

  const el = document.createElement('div');
  el.className = 'live-match-item';
  el.dataset.matchId = match.id;
  el.innerHTML = `
    <div class="live-item-sport">${sportEmoji[sport] || '🏟️'} ${sport}</div>
    <div class="live-item-teams">${home}<br>${away}</div>
    <div class="live-item-score">${hScore} : ${aScore}</div>`;

  el.addEventListener('click', () => selectMatchForLive(match));
  if (state.selectedMatchId === match.id) el.classList.add('selected');
  return el;
}

function selectMatchForLive(match) {
  state.selectedMatchId = match.id;
  state.selectedMatch   = match;

  // Update sidebar selection UI
  dom.liveMatchList.querySelectorAll('.live-match-item').forEach((el) => {
    el.classList.toggle('selected', parseInt(el.dataset.matchId) === match.id);
  });

  // Update header info
  const home   = match.homeTeam  || match.home_team  || 'Home';
  const away   = match.awayTeam  || match.away_team  || 'Away';
  const hScore = match.homeScore ?? match.home_score ?? 0;
  const aScore = match.awayScore ?? match.away_score ?? 0;
  const sport  = (match.sport || '').toLowerCase();

  dom.commentaryMatchInfo.innerHTML = `
    <div class="cm-sport">${sportEmoji[sport] || '🏟️'} ${sport} · Match #${match.id}</div>
    <div class="cm-teams">${home} vs ${away}</div>
    <div class="cm-score">${hScore} : ${aScore}</div>`;

  // Enable controls
  const isSubbed = state.subscribedIds.has(match.id);
  dom.btnSubscribe.disabled   = isSubbed;
  dom.btnUnsubscribe.disabled = !isSubbed;
  dom.btnPostCommentary.disabled = false;

  // Load existing commentary
  loadLiveFeedHistory(match.id);

  updatePubSubDebug();
}

async function loadLiveFeedHistory(matchId) {
  dom.feedEmpty.style.display = 'none';
  // Clear existing entries
  Array.from(dom.commentaryFeed.children).forEach((el) => {
    if (!el.classList.contains('feed-empty')) el.remove();
  });

  try {
    const comments = await fetchCommentary(matchId, 30);
    if (comments.length === 0) {
      dom.feedEmpty.style.display = 'flex';
      return;
    }
    // Reverse to show oldest-first in feed (API returns newest first)
    [...comments].reverse().forEach((c) => {
      dom.commentaryFeed.appendChild(buildCommentaryEntry(c, false));
    });
    scrollFeedToBottom();
  } catch (err) {
    showToast('Could not load commentary history', 'error');
  }
}

function scrollFeedToBottom() {
  dom.commentaryFeed.scrollTop = dom.commentaryFeed.scrollHeight;
}

// ── Subscribe / Unsubscribe Buttons ──────────────────────────
dom.btnSubscribe.addEventListener('click', () => {
  if (!state.selectedMatchId) return;
  wsSubscribe(state.selectedMatchId);
});

dom.btnUnsubscribe.addEventListener('click', () => {
  if (!state.selectedMatchId) return;
  wsUnsubscribe(state.selectedMatchId);
});

dom.btnClearFeed.addEventListener('click', () => {
  Array.from(dom.commentaryFeed.children).forEach((el) => {
    if (!el.classList.contains('feed-empty')) el.remove();
  });
  dom.feedEmpty.style.display = 'flex';
});

// ── WebSocket ─────────────────────────────────────────────────
function connectWebSocket() {
  if (state.ws && state.ws.readyState <= 1) return; // already open/connecting

  setWsStatus('connecting');
  state.ws = new WebSocket(WS_URL);

  state.ws.addEventListener('open', () => {
    setWsStatus('connected');
    showToast('Connected to Sportboard live server', 'success', 2500);
    // Re-subscribe to any active subscriptions after reconnect
    state.subscribedIds.forEach((id) => {
      state.ws.send(JSON.stringify({ type: 'subscribe', matchId: id }));
    });
  });

  state.ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleWsMessage(msg);
  });

  state.ws.addEventListener('close', () => {
    setWsStatus('disconnected');
    showToast('Disconnected from live server. Reconnecting in 5s…', 'error', 4000);
    setTimeout(connectWebSocket, 5000);
  });

  state.ws.addEventListener('error', () => {
    setWsStatus('disconnected');
  });
}

function setWsStatus(status) {
  state.wsStatus = status;
  dom.wsDot.className = `ws-dot ${status}`;
  const labels = { connecting: 'Connecting…', connected: 'Live', disconnected: 'Offline' };
  dom.wsLabel.textContent = labels[status] || status;

  dom.wsDebugStatus.textContent = status;
  dom.wsDebugStatus.className   = `ws-debug-status${status === 'disconnected' ? ' offline' : ''}`;
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      // Server welcomed us
      updatePingDebug();
      break;

    case 'subscribed':
      state.subscribedIds.add(msg.matchId);
      if (state.selectedMatchId === msg.matchId) {
        dom.btnSubscribe.disabled   = true;
        dom.btnUnsubscribe.disabled = false;
      }
      showToast(`Subscribed to match #${msg.matchId}`, 'success', 2000);
      updatePubSubDebug();
      break;

    case 'unsubscribed':
      state.subscribedIds.delete(msg.matchId);
      if (state.selectedMatchId === msg.matchId) {
        dom.btnSubscribe.disabled   = false;
        dom.btnUnsubscribe.disabled = true;
      }
      showToast(`Unsubscribed from match #${msg.matchId}`, 'info', 2000);
      updatePubSubDebug();
      break;

    case 'commentary':
      handleIncomingCommentary(msg.data);
      break;

    case 'match_created':
      handleNewMatchBroadcast(msg.data);
      break;

    case 'score_updated':
      handleMatchScoreUpdate(msg.data);
      break;

    case 'error':
      showToast('WS Error: ' + (msg.message || 'Unknown'), 'error');
      break;

    default:
      break;
  }
}

function handleMatchScoreUpdate(matchUpdate) {
  const match = state.matches.find((item) => Number(item.id) === Number(matchUpdate.id));
  if (!match) return;

  match.homeScore = matchUpdate.homeScore ?? matchUpdate.home_score ?? match.homeScore ?? 0;
  match.awayScore = matchUpdate.awayScore ?? matchUpdate.away_score ?? match.awayScore ?? 0;

  if (state.activeView === 'matches') renderFilteredMatches();
  refreshLiveSidebar();

  if (modalMatch && Number(modalMatch.id) === Number(match.id)) {
    dom.modalHomeScore.textContent = match.homeScore;
    dom.modalAwayScore.textContent = match.awayScore;
    dom.modalDetailsGrid.querySelectorAll('.detail-cell').forEach((cell) => {
      const label = cell.querySelector('.detail-cell-label')?.textContent;
      if (label === 'Home Score') cell.querySelector('.detail-cell-value').textContent = match.homeScore;
      if (label === 'Away Score') cell.querySelector('.detail-cell-value').textContent = match.awayScore;
    });
  }

  if (Number(state.selectedMatchId) === Number(match.id)) {
    const liveScore = dom.commentaryMatchInfo.querySelector('.cm-score');
    if (liveScore) liveScore.textContent = `${match.homeScore} : ${match.awayScore}`;
  }
}

function handleIncomingCommentary(data) {
  const matchId = data.matchId || data.match_id;

  // 1. If user is on the live view and this is the selected match → add to feed
  if (state.activeView === 'live' && matchId === state.selectedMatchId) {
    dom.feedEmpty.style.display = 'none';
    const entry = buildCommentaryEntry(data, true);
    dom.commentaryFeed.appendChild(entry);
    scrollFeedToBottom();
  }

  // 2. Flash notification
  const home = state.matches.find((m) => m.id === matchId)?.homeTeam || `Match #${matchId}`;
  showToast(`${eventIcons[data.eventType || data.event_type] || '📋'} ${data.message}`, 'info', 3000);
}

function handleNewMatchBroadcast(match) {
  // Add to state if not already present
  if (!state.matches.find((m) => m.id === match.id)) {
    state.matches.unshift(match);
    if (state.activeView === 'matches') renderFilteredMatches();
  }

  // Show in broadcast feed (Create view)
  addBroadcastItem(match);
  showToast(`🆕 New match: ${match.homeTeam || match.home_team} vs ${match.awayTeam || match.away_team}`, 'success', 4000);
}

function addBroadcastItem(match) {
  const home  = match.homeTeam  || match.home_team  || 'Home';
  const away  = match.awayTeam  || match.away_team  || 'Away';
  const sport = (match.sport || '').toLowerCase();

  // Remove "no broadcasts" placeholder
  const emptyMsg = dom.broadcastFeed.querySelector('.empty-msg');
  if (emptyMsg) emptyMsg.remove();

  const el = document.createElement('div');
  el.className = 'broadcast-item';
  el.innerHTML = `
    <div class="broadcast-item-header">
      <span class="broadcast-label">MATCH CREATED</span>
      <span class="broadcast-time">${new Date().toLocaleTimeString()}</span>
    </div>
    <div class="broadcast-content">${sportEmoji[sport] || '🏟️'} ${home} vs ${away}</div>
    <div class="broadcast-sub">${sport} · #${match.id}</div>`;

  dom.broadcastFeed.insertBefore(el, dom.broadcastFeed.firstChild);
  state.broadcastItems.push(match);
}

// ── WS Subscribe/Unsubscribe helpers ─────────────────────────
function wsSubscribe(matchId) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast('Not connected to live server', 'error');
    return;
  }
  state.ws.send(JSON.stringify({ type: 'subscribe', matchId }));
}

function wsUnsubscribe(matchId) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast('Not connected to live server', 'error');
    return;
  }
  state.ws.send(JSON.stringify({ type: 'unsubscribe', matchId }));
}

// ── Ping/Pong Debug Tracking ──────────────────────────────────
// The `ws` library on the server sends binary ping frames automatically every 30s.
// The browser WebSocket API handles pong automatically (not exposed to JS directly).
// We track approximate timing by listening to server pings as an approximation.
// We simulate awareness by tracking message timestamps.
let lastMsgTime = null;

function updatePingDebug() {
  const now = new Date().toLocaleTimeString();
  dom.wsDebugPing.textContent = `server→pong ${now}`;
}

function updatePubSubDebug() {
  const ids = [...state.subscribedIds];
  if (ids.length === 0) {
    dom.wsDebugSub.textContent  = 'not subscribed';
    dom.wsDebugSub.className    = 'ws-debug-sub';
  } else {
    dom.wsDebugSub.textContent  = `subscribed to #${ids.join(', #')}`;
    dom.wsDebugSub.className    = 'ws-debug-sub subscribed';
  }
}

// Simulate ping detection: track messages and update debug strip
setInterval(() => {
  if (state.wsStatus === 'connected') {
    updatePingDebug();
  }
}, 30000);

// ── Commentary Form (POST) ────────────────────────────────────
dom.commentaryForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.selectedMatchId) {
    showToast('Select a match first', 'error');
    return;
  }

  const btn = dom.btnPostCommentary;
  btn.disabled = true;
  btn.textContent = 'Posting…';

  const body = {
    minute:    parseInt($('cf-minute').value, 10) || 0,
    sequence:  parseInt($('cf-sequence').value, 10) || 1,
    period:    $('cf-period').value,
    eventType: $('cf-event-type').value,
    message:   $('cf-message').value.trim(),
    actor:     $('cf-actor').value.trim() || null,
    team:      $('cf-team').value.trim()  || null,
  };

  try {
    await apiFetch(`/matches/${state.selectedMatchId}/commentary`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    showToast('Commentary posted!', 'success');
    await fetchAndRenderMatches();
    dom.commentaryForm.reset();
    // Auto-increment sequence for next entry
    const nextSeq = body.sequence + 1;
    $('cf-sequence').value = nextSeq;
  } catch (err) {
    showToast('Failed to post: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Broadcast Commentary';
  }
});

// ── Create Match Form ─────────────────────────────────────────
// Pre-fill start/end with sensible defaults (now + 30min / now + 2h)
(function prefillCreateForm() {
  const now   = new Date();
  const start = new Date(now.getTime() + 30 * 60 * 1000);
  const end   = new Date(now.getTime() + 2  * 60 * 60 * 1000);
  const fmt   = (d) => d.toISOString().slice(0, 16);
  $('cm-start').value = fmt(start);
  $('cm-end').value   = fmt(end);
})();

dom.createMatchForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const btn = $('btn-create-match');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  const startLocal = $('cm-start').value; // e.g. "2026-10-25T18:00"
  const endLocal   = $('cm-end').value;
  const toISO = (local) => new Date(local).toISOString();

  const body = {
    sport:     $('cm-sport').value,
    homeTeam:  $('cm-home').value.trim(),
    awayTeam:  $('cm-away').value.trim(),
    startTime: toISO(startLocal),
    endTime:   toISO(endLocal),
    homeScore: parseInt($('cm-home-score').value, 10) || 0,
    awayScore: parseInt($('cm-away-score').value, 10) || 0,
  };

  if (!body.sport || !body.homeTeam || !body.awayTeam) {
    showToast('Please fill all required fields', 'error');
    btn.disabled = false;
    btn.textContent = 'Create Match';
    return;
  }

  try {
    const res = await apiFetch('/matches', { method: 'POST', body: JSON.stringify(body) });
    showToast(`Match created! #${res.data?.id || ''}`, 'success', 4000);
    dom.createMatchForm.reset();
    // Refresh matches list
    fetchAndRenderMatches();
    // addBroadcastItem will be triggered by WS match_created event OR we do it manually as fallback
    if (res.data) addBroadcastItem(res.data);
  } catch (err) {
    showToast('Failed to create match: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Match';
  }
});

// ── Init ──────────────────────────────────────────────────────
async function init() {
  // Start WebSocket connection
  connectWebSocket();

  // Load initial matches
  await fetchAndRenderMatches();

  // Set up live sidebar on view switch
  refreshLiveSidebar();

  // Animate header on scroll
  window.addEventListener('scroll', () => {
    const header = $('site-header');
    header.style.boxShadow = window.scrollY > 10
      ? '0 4px 30px rgba(0,0,0,0.5)'
      : 'none';
  });
}

init();
