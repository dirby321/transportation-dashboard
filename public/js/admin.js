async function clearAllDrivers() {
  if (!confirm("⚠️ ARE YOU SURE?\n\nThis will permanently delete ALL drivers from the database!")) return;
  const res = await fetch('/api/drivers/clear-all', { method: 'DELETE' });
  const data = await res.json();
  if (res.ok) {
    alert(data.message);
    fetchData(); // Reloads the empty driver list UI
  } else {
    alert('Error: ' + data.error);
  }
}