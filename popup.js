document.getElementById('analyze').addEventListener('click', async () => {
  const status = document.getElementById('status');
  status.textContent = '';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/www\.google\.com\/maps/.test(tab.url || '')) {
      status.textContent = 'Open a place on Google Maps first.';
      return;
    }
    await chrome.tabs.sendMessage(tab.id, { type: 'MRT_ANALYZE' });
    status.textContent = 'Done — check the chart on the Maps tab.';
  } catch (e) {
    status.textContent = 'Could not reach the page. Try reloading Maps.';
  }
});
