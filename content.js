// Maps Rating Trend - content script
// Runs on Google Maps place pages. Adds a floating button that scrapes the
// currently-loaded reviews (rating + relative date), groups them by month,
// and draws a small chart of the average rating per month.

(() => {
  const FAB_ID = 'mrt-fab';
  const PANEL_ID = 'mrt-panel';

  // Accumulates { rating, date } per review, keyed by data-review-id, across
  // multiple scans (including "Scan for more"). This survives even if Google
  // Maps removes earlier review elements from the DOM as you scroll further.
  const reviewStore = new Map();

  // Result of the (one-time, per place) attempt to switch the review sort
  // order to "Newest" - see ensureSortedByNewest(). null = not attempted yet.
  let sortStatus = null;

  function isPlacePage() {
    return /\/maps\/place\//.test(location.href);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function ensureFab() {
    if (!isPlacePage()) {
      const fab = document.getElementById(FAB_ID);
      if (fab) fab.remove();
      return;
    }
    if (document.getElementById(FAB_ID)) return;

    const fab = document.createElement('button');
    fab.id = FAB_ID;
    fab.className = 'mrt-fab';
    fab.type = 'button';
    fab.title = 'Show rating trend over time';
    fab.textContent = '📈';
    fab.addEventListener('click', () => runAnalysis(fab));
    document.body.appendChild(fab);
  }

  const SCAN_BATCH_SIZE = 200;

  // Set to true by the "Stop" button while a scan is in progress.
  let stopRequested = false;

  async function runAnalysis(fab) {
    if (fab.disabled) return;
    fab.disabled = true;
    stopRequested = false;
    const original = fab.textContent;
    fab.textContent = '⏳';

    try {
      const opened = await ensureReviewsVisible();
      if (!opened) {
        renderPanel({
          error:
            'Could not find any reviews on this page. Open the "Reviews" ' +
            'tab for this place manually, make sure at least one review is ' +
            'visible, then click the button again.',
        });
        return;
      }

      let container = findReviewsScrollContainer();
      if (sortStatus === null) {
        sortStatus = await ensureSortedByNewest();
        // Switching sort order re-renders the reviews list, so the previous
        // scroll container element may no longer be attached.
        container = findReviewsScrollContainer();
      }

      const target = reviewStore.size + SCAN_BATCH_SIZE;

      let scanStatus = 'unknown';
      if (container) {
        scanStatus = await loadMoreReviews(container, {
          target,
          onProgress: renderProgress,
          shouldStop: () => stopRequested,
        });
      }

      const result = extractReviews();

      if (result.reviews.length < 3) {
        renderPanel({ diagnostics: result, scanStatus });
        return;
      }

      const points = computeMonthlySeries(result.reviews);

      if (points.length < 2) {
        renderPanel({
          error:
            'All loaded reviews fall within the same month, so there is no ' +
            'trend to chart yet. Try "Scan for more" or sort by "Newest" ' +
            'and click again.',
          scanStatus,
        });
        return;
      }

      renderPanel({ points, total: result.reviews.length, diagnostics: result, scanStatus });
    } finally {
      fab.disabled = false;
      fab.textContent = original;
    }
  }

  // --- Opening the Reviews tab automatically ------------------------------------

  async function ensureReviewsVisible() {
    // Look for a "Reviews" tab/button in several languages. Add more
    // patterns here if your Maps UI is in another language and this still
    // doesn't trigger.
    const REVIEWS_LABEL_RE = /^(reviews|recenzii|bewertungen|avis|reseñas|recensioni|opiniones)\b/i;

    // The Overview tab can itself contain a few preview reviews with
    // data-review-id, so checking for that attribute alone isn't enough to
    // tell whether the actual Reviews tab is open. Check the tab's
    // aria-selected state instead, and click it if it isn't selected yet -
    // even if preview reviews already exist on the current tab.
    let reviewsTab = null;
    for (const el of document.querySelectorAll('[role="tab"]')) {
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (REVIEWS_LABEL_RE.test(label)) {
        reviewsTab = el;
        break;
      }
    }

    if (reviewsTab && reviewsTab.getAttribute('aria-selected') !== 'true') {
      reviewsTab.click();
      await sleep(500);
    } else if (!reviewsTab) {
      // Fallback for layouts without a role="tab" Reviews control.
      for (const el of document.querySelectorAll('button, a')) {
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (REVIEWS_LABEL_RE.test(label)) {
        el.click();
        break;
      }
    }
      await sleep(300);
    }

    for (let i = 0; i < 10; i++) {
      if (document.querySelector('div[data-review-id]')) return true;
      await sleep(300);
    }
    return !!document.querySelector('div[data-review-id]');
  }

  // --- Switching the review sort order to "Newest" -----------------------------

  // By default Google Maps sorts reviews by "Most relevant", which can pull
  // reviews from across the place's whole history in a relevance-biased
  // order. For a month-by-month trend, a contiguous "Newest first" sample is
  // far more representative. This runs once per place (on the first scan).
  //
  // Returns:
  //  - { ok: true }                                  on success
  //  - { ok: false, reason: 'no-sort-button', ... }  couldn't find the sort control
  //  - { ok: false, reason: 'no-newest-option', ... } found the menu but not "Newest"
  async function ensureSortedByNewest() {
    // "Newest" / "Most recent", in several languages.
    const NEWEST_RE =
      /(cele mai (noi|recente)|newest|m[áa]s recientes|recientes|plus r[ée]centes|r[ée]centes|neueste|pi[uù] recenti|recenti)/i;

    // Broader hints covering ALL sort options (relevance, newest, rating),
    // in several languages. Used both to recognize the sort button (which
    // typically displays the *currently selected* option as its own label,
    // e.g. "Cele mai relevante") and, on failure, to show what was found.
    const OPTION_HINT_RE =
      /(cele mai (relevante|noi|recente)|most relevant|relevance\b|newest|relevan|m[áa]s recientes|recientes|plus r[ée]centes|r[ée]centes|neueste|pi[uù] recenti|recenti|evaluare|highest rating|lowest rating|rating\b|note\b|valutazion)/i;

    // Generic "Sort"-type wording, matched as a prefix.
    const SORT_GENERIC_RE =
      /^(sort\b|sort reviews|sortare|sorteaz|trier|sortieren|ordina|ordenar)/i;

    // Scope the button search to near the reviews panel (a few ancestors up
    // from a review element) rather than the whole document, since
    // OPTION_HINT_RE's substring matching (e.g. "rating", "recent") could
    // otherwise match unrelated buttons elsewhere on the page.
    const review = document.querySelector('div[data-review-id]');
    let scope = document;
    if (review) {
      let el = review;
      for (let i = 0; i < 6 && el.parentElement; i++) el = el.parentElement;
      scope = el;
    }

    let sortButton = null;
    const buttonSamples = [];
    for (const btn of scope.querySelectorAll('button')) {
      const label = (btn.getAttribute('aria-label') || btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label) continue;
      if (label.length <= 60) buttonSamples.push(label);

      // Either generic "Sort" wording, OR the button's label IS one of the
      // sort option names (the currently-selected option, shown on the
      // button itself) - matched as a substring since word order varies by
      // language (e.g. Romanian "Cele mai relevante" doesn't start with
      // "relevan").
      if (SORT_GENERIC_RE.test(label) || (label.length <= 40 && OPTION_HINT_RE.test(label))) {
        sortButton = btn;
        break;
      }
    }

    if (!sortButton) {
      return {
        ok: false,
        reason: 'no-sort-button',
        sampleLabels: [...new Set(buttonSamples)].slice(0, 12),
      };
    }

    // Snapshot existing elements so newly-rendered menu items can be
    // identified afterwards, without assuming any particular ARIA role -
    // some sort dropdowns don't mark up their rows as menuitem/option at all.
    const before = new Set(document.querySelectorAll('body *'));

    sortButton.click();
    await sleep(400);

    const newestCandidates = [];
    const sampleLabels = [];

    for (const el of document.querySelectorAll('body *')) {
      // Skip large containers - only look at small, mostly-leaf elements so
      // .textContent stays cheap and we don't match a giant wrapper whose
      // text happens to include one of these words somewhere inside.
      if (el.children.length > 3) continue;

      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 60) continue;

      const isNewest = NEWEST_RE.test(text);
      const isOption = isNewest || OPTION_HINT_RE.test(text);
      if (!isOption) continue;

      // Only check layout (forces a reflow) for elements that already
      // matched textually.
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      if (isOption) sampleLabels.push(text);
      if (isNewest) newestCandidates.push({ el, isNew: !before.has(el) });
    }

    // Prefer a newly-appeared element (i.e. part of the menu that just
    // opened) over a textual match elsewhere on the page.
    const chosen = newestCandidates.find((c) => c.isNew) || newestCandidates[0];

    if (!chosen) {
      // Close the menu so it doesn't stay open over the page. Re-clicking
      // the button may not close a non-toggle menu, so also send Escape.
      sortButton.click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { ok: false, reason: 'no-newest-option', sampleLabels: [...new Set(sampleLabels)].slice(0, 12) };
    }

    chosen.el.click();
    await sleep(600);
    return { ok: true };
  }

  function findReviewsScrollContainer() {
    const review = document.querySelector('div[data-review-id]');
    if (!review) return null;

    let el = review.parentElement;
    let fallback = null;

    for (let i = 0; i < 10 && el; i++) {
      const style = window.getComputedStyle(el);
      const scrollable = el.scrollHeight > el.clientHeight + 20;

      if (scrollable && /(auto|scroll|overlay)/.test(style.overflowY)) {
        return el;
      }
      if (scrollable && !fallback) fallback = el;
      el = el.parentElement;
    }
    return fallback;
  }

  // Keeps scrolling the reviews panel to lazy-load more reviews, extracting
  // along the way (via extractReviews(), which merges into reviewStore).
  //
  // Resolves with a status:
  //  - 'reached-target' : reviewStore reached `target` reviews.
  //  - 'complete'        : no new reviews loaded for several rounds in a row
  //                        (we've reached the end of the list) before
  //                        reaching the target.
  //  - 'round-capped'    : hit the safety round limit without reaching the
  //                        target or becoming stable.
  //  - 'stopped'         : the user clicked "Stop".
  async function loadMoreReviews(container, { target, onProgress, shouldStop }) {
    const MAX_ROUNDS = 400; // safety net
    const STABLE_TARGET = 6; // consecutive no-growth rounds before giving up
    const ROUND_DELAY = 1000; // give Maps time to fetch the next batch
    const JIGGLE_DELAY = 150;

    let lastDomCount = document.querySelectorAll('div[data-review-id]').length;
    let stableRounds = 0;
    let round = 0;

    let result = extractReviews();
    if (onProgress) onProgress(result, target);
    if (result.reviews.length >= target) return 'reached-target';

    while (round < MAX_ROUNDS) {
      if (shouldStop && shouldStop()) return 'stopped';

      // Jiggle: scroll up a bit, then back to the bottom. If we were
      // already exactly at the bottom, re-setting scrollTop to the same
      // value may not produce a real scroll delta, and Maps' lazy-load
      // sometimes only fires on an actual position change. Also dispatch a
      // wheel event for listeners that key off that instead of scroll.
      const bottom = container.scrollHeight;
      container.scrollTop = Math.max(0, bottom - container.clientHeight - 300);
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(JIGGLE_DELAY);

      if (shouldStop && shouldStop()) return 'stopped';

      container.scrollTop = container.scrollHeight;
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
      try {
        container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 300 }));
      } catch (e) {
        // WheelEvent constructor unavailable in some contexts - harmless.
      }

      round++;
      await sleep(ROUND_DELAY);

      if (shouldStop && shouldStop()) return 'stopped';

      const domCount = document.querySelectorAll('div[data-review-id]').length;
      result = extractReviews();
      if (onProgress) onProgress(result, target);

      if (result.reviews.length >= target) return 'reached-target';

      if (domCount <= lastDomCount) stableRounds++;
      else stableRounds = 0;
      lastDomCount = domCount;

      if (stableRounds >= STABLE_TARGET) return 'complete';
    }

    return 'round-capped';
  }

  // --- Extracting rating + relative date (language-agnostic-ish) -----------------

  // Rating: look for ANY element with an aria-label that encodes a star
  // rating. Two common shapes:
  //  - "X out of 5", "X din 5" (RO), "X sur 5" (FR), "X von/aus 5" (DE), "X/5"
  //  - plain "X star(s)" style: "1 stea" / "4 stele" (RO), "5 stars" (EN),
  //    "X étoile(s)" (FR), "X Stern(e)" (DE), "X estrella(s)" (ES/PT),
  //    "X stella/stelle" (IT)
  const RATING_PATTERNS = [
    /(\d+(?:[.,]\d+)?)\s*(?:\/|out of|din|sur|von|aus|de|of)\s*5\b/i,
    /(\d+(?:[.,]\d+)?)\s*(?:stea|stele|stars?|étoiles?|sterne?|estrellas?|stelle?|stella)\b/i,
  ];

  function extractRating(reviewEl) {
    const labeled = reviewEl.querySelectorAll('[aria-label]');
    for (const elx of labeled) {
      const label = (elx.getAttribute('aria-label') || '').trim();
      for (const re of RATING_PATTERNS) {
        const m = label.match(re);
        if (m) return parseFloat(m[1].replace(',', '.'));
      }
    }
    return null;
  }

  // Relative date patterns, by language. Each entry: a regex that matches
  // the phrase anywhere in a text node, plus a parser returning
  // { amount, unit }. Add more languages here if needed - to find the right
  // pattern, check the "sample text" shown in the diagnostics panel when
  // extraction fails.
  const RELATIVE_PATTERNS = [
    {
      // English: "2 months ago", "a year ago", "an hour ago"
      re: /(a|an|\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i,
      parse: (m) => ({
        amount: /^(a|an)$/i.test(m[1]) ? 1 : parseInt(m[1], 10),
        unit: m[2].toLowerCase(),
      }),
    },
    {
      // Romanian: "acum 2 luni", "acum o săptămână", "acum un an"
      re: /acum\s+(o|un|\d+)\s+(secund[ăa]e?|minute?|or[ăa]e?|zile?|săptăm[âa]n[iă]?|lun[iă]?|ani?)/i,
      parse: (m) => {
        const amount = /^(o|un)$/i.test(m[1]) ? 1 : parseInt(m[1], 10);
        const raw = m[2].toLowerCase();
        let unit = 'day';
        if (raw.startsWith('secund')) unit = 'second';
        else if (raw.startsWith('minut')) unit = 'minute';
        else if (raw.startsWith('or')) unit = 'hour';
        else if (raw.startsWith('zi')) unit = 'day';
        else if (raw.startsWith('săpt')) unit = 'week';
        else if (raw.startsWith('lun')) unit = 'month';
        else if (raw.startsWith('an')) unit = 'year';
        return { amount, unit };
      },
    },
  ];

  function extractRelativeDateInfo(reviewEl) {
    const walker = document.createTreeWalker(reviewEl, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (!text) continue;
      for (const pattern of RELATIVE_PATTERNS) {
        const m = text.match(pattern.re);
        if (m) return { raw: m[0], ...pattern.parse(m) };
      }
    }
    return null;
  }

  function relativeInfoToDate(info) {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const day = now.getDate();

    switch (info.unit) {
      case 'second':
      case 'minute':
      case 'hour':
        return now;
      case 'day':
        return new Date(y, m, day - info.amount);
      case 'week':
        return new Date(y, m, day - info.amount * 7);
      case 'month':
        // Pin to the 1st of the month: subtracting months from a
        // day like the 29th-31st can overflow into the next month
        // when the target month is shorter (e.g. Mar 31 - 1 month
        // -> "Feb 31" -> rolls forward to Mar 3). Since reviews are
        // bucketed by month anyway, only the month/year matters.
        return new Date(y, m - info.amount, 1);
      case 'year':
        return new Date(y - info.amount, m, 1);
      default:
        return now;
    }
  }

  function extractReviews() {
    const els = document.querySelectorAll('div[data-review-id]');
    let withRating = 0;
    let withDate = 0;
    let sample = null;
    let newlyAdded = 0;

    els.forEach((el) => {
      const id = el.getAttribute('data-review-id');

      const rating = extractRating(el);
      if (rating !== null) withRating++;

      const dateInfo = extractRelativeDateInfo(el);
      if (dateInfo) withDate++;

      if (!sample) {
        sample = {
          ariaLabels: Array.from(el.querySelectorAll('[aria-label]'))
            .slice(0, 8)
            .map((e) => e.getAttribute('aria-label')),
          text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 220),
        };
      }

      if (rating === null || rating < 1 || rating > 5 || !dateInfo) return;
      if (!id || reviewStore.has(id)) return;

      reviewStore.set(id, { rating, date: relativeInfoToDate(dateInfo) });
      newlyAdded++;
    });

    return {
      reviews: Array.from(reviewStore.values()),
      storedTotal: reviewStore.size,
      newlyAdded,
      total: els.length,
      withRating,
      withDate,
      sample,
    };
  }

  // --- Computing the trend ----------------------------------------------------

  // Buckets reviews by calendar month and averages the ratings within each
  // month. Months with zero reviews are skipped entirely (the line will
  // jump straight across the gap to the next month that has data).
  function computeMonthlySeries(reviews) {
    const monthKey = (d) => d.getFullYear() * 12 + d.getMonth();

    const buckets = new Map(); // monthKey -> { sum, count, date }
    for (const r of reviews) {
      const key = monthKey(r.date);
      const b = buckets.get(key) || {
        sum: 0,
        count: 0,
        date: new Date(r.date.getFullYear(), r.date.getMonth(), 1),
      };
      b.sum += r.rating;
      b.count += 1;
      buckets.set(key, b);
    }

    const keys = [...buckets.keys()].sort((a, b) => a - b);
    return keys.map((key) => {
      const b = buckets.get(key);
      return { date: b.date, avg: b.sum / b.count, count: b.count };
    });
  }

  // --- Rendering ---------------------------------------------------------------

  function formatDate(d) {
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const H = 140;
  const PAD = { top: 10, bottom: 22 };
  const AXIS_W = 30;
  const VISIBLE_W = 222; // visible width of the scrollable chart area
  const POINT_SPACING = 14; // min px per month before scrolling kicks in

  // Pick a y-axis range that's "zoomed in" to where the data actually lives,
  // instead of always spanning the full 1-5 scale (which flattens the line
  // when ratings cluster near the top, as they usually do).
  function computeYRange(points) {
    let min = Infinity;
    let max = -Infinity;
    for (const p of points) {
      if (p.avg < min) min = p.avg;
      if (p.avg > max) max = p.avg;
    }

    // Guarantee a minimum visible span so a near-flat line doesn't look like
    // a razor-thin band.
    const MIN_SPAN = 0.4;
    if (max - min < MIN_SPAN) {
      const mid = (max + min) / 2;
      min = mid - MIN_SPAN / 2;
      max = mid + MIN_SPAN / 2;
    }

    // Small padding so the line/points aren't glued to the edges.
    const pad = (max - min) * 0.1;
    min -= pad;
    max += pad;

    // Ratings can't go outside [1, 5].
    min = Math.max(1, min);
    max = Math.min(5, max);

    return { min, max };
  }

  function yPos(avg, range) {
    return PAD.top + (1 - (avg - range.min) / (range.max - range.min)) * (H - PAD.top - PAD.bottom);
  }

  function tickDecimals(range) {
    return range.max - range.min < 1 ? 2 : 1;
  }

  // Fixed-width SVG with just the y-axis tick labels + tick marks, kept
  // outside the scrollable area so it stays visible while scrolling.
  function buildAxisSvg(range) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${AXIS_W} ${H}`);
    svg.setAttribute('width', AXIS_W);
    svg.classList.add('mrt-axis-svg');

    const decimals = tickDecimals(range);
    const TICKS = 4;
    for (let i = 0; i <= TICKS; i++) {
      const val = range.min + ((range.max - range.min) * i) / TICKS;
      const gy = yPos(val, range);

      const tick = document.createElementNS(SVG_NS, 'line');
      tick.setAttribute('x1', AXIS_W - 5);
      tick.setAttribute('x2', AXIS_W);
      tick.setAttribute('y1', gy);
      tick.setAttribute('y2', gy);
      tick.setAttribute('class', 'mrt-grid');
      svg.appendChild(tick);

      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', AXIS_W - 7);
      label.setAttribute('y', gy + 3);
      label.setAttribute('class', 'mrt-axis-label');
      label.setAttribute('text-anchor', 'end');
      label.textContent = val.toFixed(decimals);
      svg.appendChild(label);
    }

    return svg;
  }

  // Wide, horizontally-scrollable SVG with gridlines, the trend line, points
  // with tooltips, and date labels along the x-axis.
  function buildChartSvg(points, range) {
    const chartWidth = Math.max(VISIBLE_W, points.length * POINT_SPACING);
    const leftPad = 4;
    const rightPad = 4;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${chartWidth} ${H}`);
    svg.setAttribute('width', chartWidth);
    svg.classList.add('mrt-chart');

    const minDate = points[0].date.getTime();
    const maxDate = points[points.length - 1].date.getTime();
    const span = Math.max(maxDate - minDate, 1);

    const xPos = (d) => leftPad + ((d.getTime() - minDate) / span) * (chartWidth - leftPad - rightPad);

    // Horizontal gridlines matching the axis ticks
    const TICKS = 4;
    for (let i = 0; i <= TICKS; i++) {
      const val = range.min + ((range.max - range.min) * i) / TICKS;
      const gy = yPos(val, range);

      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', 0);
      line.setAttribute('x2', chartWidth);
      line.setAttribute('y1', gy);
      line.setAttribute('y2', gy);
      line.setAttribute('class', 'mrt-grid');
      svg.appendChild(line);
    }

    // Trend line
    const pathData = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xPos(p.date).toFixed(1)} ${yPos(p.avg, range).toFixed(1)}`)
      .join(' ');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathData);
    path.setAttribute('class', 'mrt-line');
    svg.appendChild(path);

    // One point per month with reviews - counts are small enough that
    // sampling isn't needed.
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', xPos(p.date).toFixed(1));
      circle.setAttribute('cy', yPos(p.avg, range).toFixed(1));
      circle.setAttribute('r', '2.5');
      circle.setAttribute('class', 'mrt-point');

      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = `${formatDate(p.date)} — avg ${p.avg.toFixed(2)} (${p.count} review${p.count === 1 ? '' : 's'})`;
      circle.appendChild(title);

      svg.appendChild(circle);
    }

    // X-axis date labels. Greedily pick points whose pixel x-position is at
    // least MIN_LABEL_GAP apart (points can be unevenly spaced in time once
    // empty months are skipped, so spacing must be computed in pixels, not
    // by index). The first label is left-anchored and the last is
    // right-anchored so their text doesn't get clipped by the SVG edges;
    // interior labels are centered. If the forced last label would overlap
    // the previous one, the previous one is dropped instead of doubling up.
    const MIN_LABEL_GAP = 55;
    const lastIdx = points.length - 1;
    const labelIdxs = [0];
    let lastLabelX = xPos(points[0].date);

    for (let i = 1; i < points.length; i++) {
      const x = xPos(points[i].date);
      if (i === lastIdx || x - lastLabelX >= MIN_LABEL_GAP) {
        labelIdxs.push(i);
        lastLabelX = x;
      }
    }

    if (labelIdxs.length > 2) {
      const last = labelIdxs[labelIdxs.length - 1];
      const prev = labelIdxs[labelIdxs.length - 2];
      if (prev !== 0 && xPos(points[last].date) - xPos(points[prev].date) < MIN_LABEL_GAP) {
        labelIdxs.splice(labelIdxs.length - 2, 1);
      }
    }

    for (const i of labelIdxs) {
      const p = points[i];
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', xPos(p.date).toFixed(1));
      label.setAttribute('y', H - 6);
      label.setAttribute('class', 'mrt-axis-label');
      label.setAttribute('text-anchor', i === 0 ? 'start' : i === lastIdx ? 'end' : 'middle');
      label.textContent = formatDate(p.date);
      svg.appendChild(label);
    }

    return svg;
  }


  function buildDiagnostics(diagnostics) {
    const wrap = document.createElement('details');
    wrap.className = 'mrt-diagnostics';

    const summary = document.createElement('summary');
    summary.textContent = 'Diagnostics (tap if the chart looks wrong or is missing)';
    wrap.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'mrt-diag-line';
    list.textContent =
      `On page now: ${diagnostics.total} review element(s), ` +
      `${diagnostics.withRating} with a parseable rating, ` +
      `${diagnostics.withDate} with a parseable date · ` +
      `New this scan: ${diagnostics.newlyAdded} · ` +
      `Total captured so far: ${diagnostics.storedTotal}`;
    wrap.appendChild(list);

    if (diagnostics.sample) {
      const pre = document.createElement('pre');
      pre.className = 'mrt-diag-pre';
      pre.textContent =
        `aria-labels: ${JSON.stringify(diagnostics.sample.ariaLabels, null, 0)}\n\n` +
        `text: ${diagnostics.sample.text}`;
      wrap.appendChild(pre);

      const hint = document.createElement('div');
      hint.className = 'mrt-diag-line';
      hint.textContent =
        'If "with parseable rating/date" is 0, copy the text above and ' +
        'share it so the date/rating patterns can be extended for your ' +
        "Maps language.";
      wrap.appendChild(hint);
    }

    return wrap;
  }

  function renderProgress(result, target) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.className = 'mrt-panel';
      document.body.appendChild(panel);
    }

    const statusText =
      `Scanning… ${result.storedTotal} of ${target} reviews captured ` +
      `(${result.total} review element(s) currently on the page).`;

    // If a chart is already showing (e.g. this is a "Scan for more" run),
    // keep it visible and just update a status line + Stop button instead
    // of wiping the panel - the new chart replaces everything when done.
    if (panel.querySelector('.mrt-chart-row')) {
      let status = document.getElementById('mrt-scan-status');
      if (!status) {
        status = document.createElement('div');
        status.id = 'mrt-scan-status';
        status.className = 'mrt-msg';
        panel.appendChild(status);
      }
      status.textContent = statusText;

      ensureStopButton(panel);
      return;
    }

    panel.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'mrt-panel-header';
    const title = document.createElement('span');
    title.textContent = 'Rating trend';
    header.appendChild(title);
    panel.appendChild(header);

    const msg = document.createElement('div');
    msg.id = 'mrt-scan-status';
    msg.className = 'mrt-msg';
    msg.textContent = statusText;
    panel.appendChild(msg);

    ensureStopButton(panel);
  }

  function ensureStopButton(panel) {
    if (document.getElementById('mrt-stop-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'mrt-stop-btn';
    btn.type = 'button';
    btn.className = 'mrt-scan-more';
    btn.textContent = 'Stop scanning';
    btn.addEventListener('click', () => {
      stopRequested = true;
      btn.textContent = 'Stopping…';
      btn.disabled = true;
    });
    panel.appendChild(btn);
  }

  function buildSortStatusNote() {
    if (!sortStatus) return document.createDocumentFragment();

    const wrap = document.createElement('div');
    wrap.className = 'mrt-caption';

    if (sortStatus.ok) {
      wrap.textContent = '✓ Reviews were sorted by "Newest" before scanning, for a more representative sample.';
      return wrap;
    }

    wrap.textContent =
      '⚠ Could not switch the review sort order to "Newest" — results may be ' +
      'biased toward "Most relevant" rather than chronological. ' +
      'For a more accurate chart, manually open the review sort dropdown, ' +
      'choose "Newest", then click 📈 again.';

    if (sortStatus.sampleLabels && sortStatus.sampleLabels.length) {
      const pre = document.createElement('pre');
      pre.className = 'mrt-diag-pre';
      const label =
        sortStatus.reason === 'no-sort-button'
          ? 'Buttons seen near the reviews panel'
          : 'Sort menu options seen';
      pre.textContent =
        `${label}: ${JSON.stringify(sortStatus.sampleLabels)}\n` +
        `(share this if you'd like "Newest" auto-detection added for your language)`;
      wrap.appendChild(document.createElement('br'));
      wrap.appendChild(pre);
    }

    return wrap;
  }

  function buildScanStatusFooter(scanStatus) {
    const wrap = document.createElement('div');
    wrap.className = 'mrt-caption';

    const messages = {
      'reached-target': `Loaded ${reviewStore.size} reviews so far. `,
      complete: `No new reviews loaded after several attempts — ${reviewStore.size} ` +
        `captured. This usually means the end of the list, but Maps' ` +
        `lazy-loading can occasionally stall, so it's worth trying again. `,
      stopped: `Scanning stopped early — ${reviewStore.size} reviews captured so far. `,
      'round-capped': `Hit the scan safety limit — ${reviewStore.size} reviews captured so far. `,
      unknown: `Could not scroll the reviews list — ${reviewStore.size} reviews captured so far. `,
    };

    const note = document.createElement('span');
    note.textContent = messages[scanStatus] || `${reviewStore.size} reviews captured so far. `;
    wrap.appendChild(note);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mrt-scan-more';
    btn.textContent =
      scanStatus === 'complete' ? 'Try scanning again' : `Scan for ${SCAN_BATCH_SIZE} more`;
    btn.addEventListener('click', () => {
      const fab = document.getElementById(FAB_ID);
      if (fab) runAnalysis(fab);
    });
    wrap.appendChild(btn);

    return wrap;
  }

  function renderPanel({ points, total, error, diagnostics, scanStatus }) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.className = 'mrt-panel';
      document.body.appendChild(panel);
    }
    panel.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'mrt-panel-header';

    const title = document.createElement('span');
    title.textContent = 'Rating trend';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'mrt-close';
    close.textContent = '✕';
    close.addEventListener('click', () => panel.remove());

    header.appendChild(title);
    header.appendChild(close);
    panel.appendChild(header);

    if (error) {
      const msg = document.createElement('div');
      msg.className = 'mrt-msg';
      msg.textContent = error;
      panel.appendChild(msg);
      if (scanStatus) panel.appendChild(buildScanStatusFooter(scanStatus));
      return;
    }

    if (!points) {
      const msg = document.createElement('div');
      msg.className = 'mrt-msg';
      msg.textContent = diagnostics
        ? `Found ${diagnostics.total} review element(s) but only ${diagnostics.withRating} had a ` +
          `readable rating and ${diagnostics.withDate} a readable date. Open ` +
          'the diagnostics below for details.'
        : 'No reviews found yet. Scroll the reviews list and try again.';
      panel.appendChild(msg);
      if (scanStatus) panel.appendChild(buildScanStatusFooter(scanStatus));
      if (diagnostics) panel.appendChild(buildDiagnostics(diagnostics));
      return;
    }

    const range = computeYRange(points);

    const row = document.createElement('div');
    row.className = 'mrt-chart-row';

    row.appendChild(buildAxisSvg(range));

    const scroll = document.createElement('div');
    scroll.className = 'mrt-chart-scroll';
    scroll.appendChild(buildChartSvg(points, range));
    row.appendChild(scroll);

    panel.appendChild(row);

    // Scroll to the right edge by default so the most recent trend is visible.
    scroll.scrollLeft = scroll.scrollWidth;

    const decimals = tickDecimals(range);
    const monthKey = (d) => d.getFullYear() * 12 + d.getMonth();
    const spanMonths = monthKey(points[points.length - 1].date) - monthKey(points[0].date) + 1;
    const skippedMonths = spanMonths - points.length;

    const caption = document.createElement('div');
    caption.className = 'mrt-caption';
    caption.textContent =
      `Average rating per month, ${formatDate(points[0].date)} – ` +
      `${formatDate(points[points.length - 1].date)} (${total} reviews, ` +
      `${points.length} month(s) with reviews). Y-axis is zoomed to ` +
      `${range.min.toFixed(decimals)}–${range.max.toFixed(decimals)} (not the ` +
      `full 1–5 scale).` +
      (skippedMonths > 0
        ? ` ${skippedMonths} month(s) had no reviews and are skipped (the ` +
          `line connects straight across the gap).`
        : '') +
      ` Scroll horizontally for the full history.`;
    panel.appendChild(caption);

    panel.appendChild(buildSortStatusNote());

    panel.appendChild(buildScanStatusFooter(scanStatus));

    if (diagnostics) panel.appendChild(buildDiagnostics(diagnostics));
  }

  // --- Messaging (popup -> content script) -----------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'MRT_ANALYZE') {
      const fab = document.getElementById(FAB_ID);
      if (fab) runAnalysis(fab);
    }
  });

  // --- Init + SPA navigation watcher -------------------------------------------

  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    ensureFab();
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      reviewStore.clear();
      sortStatus = null;
      const panel = document.getElementById(PANEL_ID);
      if (panel) panel.remove();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  ensureFab();
})();
