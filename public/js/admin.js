// Attach to window so inline onclick HTML attributes can find them
window.syncDirectory = async function(role) {
  const btn = event ? event.target : null;
  if (btn) btn.innerText = 'Syncing...';

  try {
    const res = await fetch('/api/sync/' + role, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      alert(data.message);
      if (typeof fetchData === 'function') fetchData();
    } else {
      alert('Error: ' + (data.error || 'Sync failed'));
    }
  } catch (err) {
    alert('Error connecting to server: ' + err.message);
  } finally {
    if (btn) btn.innerText = '🔄 Sync ' + (role === 'drivers' ? 'Drivers' : 'Mechanics');
  }
};

window.clearAllDrivers = async function() {
  if (!confirm("⚠️ ARE YOU SURE?\n\nThis will permanently delete ALL drivers from the database!")) return;
  
  try {
    const res = await fetch('/api/drivers/clear-all', { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      alert(data.message);
      if (typeof fetchData === 'function') fetchData();
    } else {
      alert('Error: ' + (data.error || 'Failed to clear drivers'));
    }
  } catch (err) {
    alert('Error connecting to server: ' + err.message);
  }
};