/* ══════════════════════════════════════════════════════════════
   CineMatch — Frontend JS
   All ML logic lives on the Flask server.
   This file handles:
     • Autocomplete  →  GET /movies/search?q=…
     • Recommendations  →  POST /recommend
     • UI state management
   ══════════════════════════════════════════════════════════════ */

const BASE_URL = '';   // same origin — Flask serves both HTML and API

/* ── DOM refs ────────────────────────────────────────────────── */
const movieInput      = document.getElementById('movieInput');
const recommendBtn    = document.getElementById('recommendBtn');
const matchInfo       = document.getElementById('matchInfo');
const matchedTitle    = document.getElementById('matchedTitle');
const movieGrid       = document.getElementById('movieGrid');
const resultsSection  = document.getElementById('resultsSection');
const searchSection   = document.getElementById('searchSection');
const loader          = document.getElementById('loader');
const searchAgainBtn  = document.getElementById('searchAgainBtn');
const autocompleteList = document.getElementById('autocompleteList');

/* ══════════════════════════════════════════════════════════════
   AUTOCOMPLETE  — GET /movies/search?q=…
   ══════════════════════════════════════════════════════════════ */

let acDebounce = null;
let acActive   = -1;   // keyboard-nav index

movieInput.addEventListener('input', () => {
  clearTimeout(acDebounce);
  const q = movieInput.value.trim();
  if (q.length < 2) { hideAC(); return; }
  acDebounce = setTimeout(() => fetchSuggestions(q), 220);
});

async function fetchSuggestions(q) {
  try {
    const res  = await fetch(`${BASE_URL}/movies/search?q=${encodeURIComponent(q)}&limit=8`);
    const data = await res.json();
    renderAC(data.matches || [], q);
  } catch {
    hideAC();
  }
}

function renderAC(matches, query) {
  if (!matches.length) { hideAC(); return; }

  autocompleteList.innerHTML = '';
  acActive = -1;

  matches.forEach(title => {
    const li = document.createElement('li');
    // Bold the matched portion
    const idx = title.toLowerCase().indexOf(query.toLowerCase());
    if (idx !== -1) {
      li.innerHTML =
        escHtml(title.slice(0, idx)) +
        `<em>${escHtml(title.slice(idx, idx + query.length))}</em>` +
        escHtml(title.slice(idx + query.length));
    } else {
      li.textContent = title;
    }
    li.addEventListener('mousedown', () => {
      movieInput.value = title;
      hideAC();
      runRecommend();
    });
    autocompleteList.appendChild(li);
  });

  autocompleteList.classList.remove('hidden');
}

function hideAC() {
  autocompleteList.classList.add('hidden');
  acActive = -1;
}

// Keyboard navigation inside autocomplete
movieInput.addEventListener('keydown', e => {
  const items = autocompleteList.querySelectorAll('li');
  if (!items.length || autocompleteList.classList.contains('hidden')) {
    if (e.key === 'Enter') runRecommend();
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    acActive = Math.min(acActive + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    acActive = Math.max(acActive - 1, -1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (acActive >= 0) {
      movieInput.value = items[acActive].textContent;
      hideAC();
      runRecommend();
    } else {
      hideAC();
      runRecommend();
    }
    return;
  } else if (e.key === 'Escape') {
    hideAC();
    return;
  }

  items.forEach((li, i) => li.classList.toggle('active', i === acActive));
  if (acActive >= 0) movieInput.value = items[acActive].textContent;
});

// Close autocomplete when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('.input-wrap')) hideAC();
});

/* ══════════════════════════════════════════════════════════════
   RECOMMENDATIONS  — POST /recommend
   ══════════════════════════════════════════════════════════════ */

recommendBtn.addEventListener('click', runRecommend);

async function runRecommend() {
  const query = movieInput.value.trim();
  if (!query) { movieInput.focus(); return; }

  hideAC();
  setLoading(true);
  clearResults();

  try {
    const res  = await fetch(`${BASE_URL}/recommend`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ movie: query, top_n: 10 }),
    });

    const data = await res.json();

    if (!res.ok) {
      showMatchInfo(data.error || 'Something went wrong.', true);
      setLoading(false);
      return;
    }

    // Show "fuzzy-matched to" banner if title differs
    if (data.matched.toLowerCase() !== query.toLowerCase()) {
      showMatchInfo(`Showing results for: "${data.matched}"`, false);
    } else {
      hideMatchInfo();
    }

    renderResults(data.matched, data.recommendations);

  } catch (err) {
    showMatchInfo('Could not reach the server. Is Flask running?', true);
  } finally {
    setLoading(false);
  }
}

/* ══════════════════════════════════════════════════════════════
   RENDER RESULTS
   ══════════════════════════════════════════════════════════════ */

function renderResults(matched, recommendations) {
  matchedTitle.textContent = matched;
  movieGrid.innerHTML = '';

  recommendations.forEach(movie => {
    movieGrid.appendChild(buildCard(movie));
  });

  resultsSection.classList.remove('hidden');
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function buildCard(movie) {
  const card = document.createElement('div');
  card.className = 'movie-card';

  const pct    = Math.round(movie.score * 100);
  const isTop3 = movie.rank <= 3;

  // Genre pills — take first 3 genres
  const genreSnippet = (movie.genres || '')
    .split(/[\s,|]+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' · ');

  // Director snippet
  const dirSnippet = movie.director
    ? `<span style="opacity:.6">dir.</span> ${escHtml(movie.director.split(' ').slice(0, 3).join(' '))}`
    : '';

  const metaParts = [genreSnippet, dirSnippet].filter(Boolean).join(' &nbsp;·&nbsp; ');

  card.innerHTML = `
    <div class="movie-rank ${isTop3 ? 'top3' : ''}">${movie.rank}</div>
    <div class="movie-info">
      <div class="movie-title">${escHtml(movie.title)}</div>
      ${metaParts ? `<div class="movie-meta">${metaParts}</div>` : ''}
    </div>
    <div class="movie-score">
      <div class="score-bar-wrap">
        <div class="score-bar" style="width:${pct}%"></div>
      </div>
      <div class="score-val">${pct}% match</div>
    </div>
  `;
  return card;
}

/* ══════════════════════════════════════════════════════════════
   UI HELPERS
   ══════════════════════════════════════════════════════════════ */

function setLoading(on) {
  loader.classList.toggle('hidden', !on);
  recommendBtn.disabled = on;
}

function clearResults() {
  resultsSection.classList.add('hidden');
  movieGrid.innerHTML = '';
  hideMatchInfo();
}

function showMatchInfo(msg, isError) {
  matchInfo.textContent = isError ? `⚠ ${msg}` : `ℹ ${msg}`;
  matchInfo.className   = 'match-info' + (isError ? ' error-info' : '');
  matchInfo.classList.remove('hidden');
}
function hideMatchInfo() { matchInfo.classList.add('hidden'); }

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── Search again ────────────────────────────────────────────── */
searchAgainBtn.addEventListener('click', () => {
  clearResults();
  movieInput.value = '';
  movieInput.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
