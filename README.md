# Maps Rating Trend

A free Chrome/Brave extension that adds a small chart to Google Maps place
pages, showing how the place's **average rating evolved over time** based on
the reviews currently loaded on the page.

## How it works

- A floating 📈 button appears on any `google.com/maps/place/...` page.
- On click, it auto-scrolls the reviews panel a few times to load more
  reviews, then reads each review's star rating and its relative date
  ("2 months ago", "a year ago", ...).
- It converts those relative dates into approximate calendar dates, sorts
  reviews chronologically, and plots the **running (cumulative) average
  rating** as new reviews "arrive" — i.e. how the overall score has trended.

## If it still finds "0 usable reviews"

The chart panel now always shows a **Diagnostics** section (tap to expand)
when it can't build the chart, with:

- How many review elements were found at all.
- How many of those had a rating the script could parse.
- How many had a date the script could parse.
- A text sample (aria-labels + visible text) from the first review element.

The most common cause is **language**: Google Maps shows star ratings and
relative dates ("2 months ago", "acum 2 luni", "vor 2 Monaten", ...) in your
browser/account's display language. `content.js` currently understands:

- Ratings: any aria-label shaped like "X out of 5", "X din 5" (Romanian),
  "X sur 5" (French), "X von 5" / "X aus 5" (German), "X/5", etc.
- Dates: English ("... ago") and Romanian ("acum ...").

If diagnostics show 0 for rating or date in your language, copy the "text"
sample from the diagnostics box and extend `RATING_RE` or
`RELATIVE_PATTERNS` near the top of `content.js` with the matching phrase —
each pattern is a small regex + a parser function, so adding a language is a
few lines.

## Known limitations (worth knowing before you rely on it)


- **No historical API exists.** Google doesn't expose a time series of a
  place's average rating, so this only works by reading whatever reviews are
  currently rendered in the page. It's an approximation, not an official
  record.
- **Dates are approximate.** "3 months ago" is converted to "today minus 3
  months" — older reviews get coarser (year-level) granularity.
- **The extension now auto-opens the "Reviews" tab** if it's not already
  open, and auto-scrolls the reviews panel to load more — you shouldn't need
  to scroll manually first. If it still can't find any reviews, open the
  Reviews tab yourself and make sure at least one review is visible, then
  click again.
- **Sample size is limited** to what Maps loads. Each click scans up to 200
  reviews per batch (the first click targets 200 total; each subsequent
  "Scan for 200 more" click raises the target by another 200). A **Stop
  scanning** button is shown while a scan is running. For a better spread,
  manually click Maps' review sort dropdown and choose **"Newest"** before
  clicking the 📈 button.
- **Selectors can break.** The script relies on `div[data-review-id]` and
  `aria-label` attributes in Google's Maps markup. If Google changes this
  markup, the extension may stop finding reviews until the selectors in
  `content.js` (`extractRating`, `extractRelativeDateInfo`,
  `findReviewsScrollContainer`) are updated. Open DevTools on a reviews panel
  to find the new attributes if that happens.

## Testing locally (before publishing)

1. Go to `chrome://extensions` (or `brave://extensions` in Brave).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder
   (`maps-rating-trend/` — the one containing `manifest.json`).
4. Open Google Maps, search for any place with reviews, open it, and scroll
   the reviews panel so a few reviews are visible.
5. Click the blue 📈 button in the bottom-right corner.

If you see "Could not find the reviews list", make sure the **Reviews**
section is open and at least a couple of reviews are visible before clicking.
