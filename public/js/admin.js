// Expose all inline HTML event handlers globally to the window object
window.loadSchedule = async function() {
  const dateEl = document.getElementById('scheduleDate');
  if (!dateEl || !dateEl.value) return;

  try {
    const res = await fetch('/api/schedule/' + dateEl.value);
    if (!res.ok) return;
    const data = await res.json();

    ['amContainer', 'pmContainer', 'tripContainer'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });

    if (Array.isArray(data.amRoutes)) data.amRoutes.forEach(r => addRouteRow('amContainer', r));
    if (Array.isArray(data.pmRoutes)) data.pmRoutes.forEach(r => addRouteRow('pmContainer', r));
    if (Array.isArray(data.fieldTrips)) data.fieldTrips.forEach(r => addRouteRow('tripContainer', r));
  } catch (err) {
    console.error('Error loading schedule:', err);
  }
};

window.copyForward = async function() {
  const dateEl = document.getElementById('scheduleDate');
  if (!dateEl) return;
  const res = await fetch('/api/schedule/copy-forward', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ targetDate: dateEl.value })
  });
  if (res.ok) { alert('Copied previous day schedule!'); window.loadSchedule(); }
  else { const err = await res.json(); alert(err.error); }
};

window.clearAllSchedules = async function() {
  if (!confirm("⚠️ ARE YOU SURE?\n\nThis will permanently delete ALL saved schedules!")) return;
  const res = await fetch('/api/schedule/clear-all', { method: 'DELETE' });
  const data = await res.json();
  if (res.ok) { alert(data.message); window.loadSchedule(); }
  else { alert('Error: ' + data.error); }
};

window.saveSchedule = async function() {
  const dateEl = document.getElementById('scheduleDate');
  if (!dateEl) return;
  const payload = {
    date: dateEl.value,
    amRoutes: extractRoutes('amContainer'),
    pmRoutes: extractRoutes('pmContainer'),
    fieldTrips: extractRoutes('tripContainer')
  };

  const res = await fetch('/api/schedule', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload)
  });

  if (res.ok) { alert('Schedule saved successfully!'); }
  else { const err = await res.json(); alert('Error: ' + err.error); }
};

window.addRouteRow = function(containerId, data) {
  data = data || {};
  const container = document.getElementById(containerId);
  if (!container) return;

  const div = document.createElement('div');
  div.style.cssText = 'display:flex; gap:5px; margin-bottom:6px; align-items:center;';

  const driverObjId = data.driverId ? String(data.driverId._id || data.driverId) : '';
  const busObjId = data.busId ? String(data.busId._id || data.busId) : '';

  const busInShop = data.busId && data.busId.status === 'In Shop';
  const shopBadge = busInShop ? '<span style="color:#DD0000; font-weight:bold; font-size:10px;" title="Bus is in shop">🛠 IN SHOP</span>' : '';

  div.innerHTML = '<input type="text" placeholder="Route No." value="' + (data.routeName || '') + '" style="width: 20%;" class="r-name" />' +
    '<input type="time" value="' + (data.scheduledTime || '07:00') + '" style="width: 18%;" class="r-time" />' +
    '<select class="r-driver" style="width: 25%;"><option value="">Select Driver</option></select>' +
    '<select class="r-bus" style="width: 25%;"><option value="">Select Bus</option></select>' + shopBadge +
    '<button class="btn-remove-row" style="background:#666;">X</button>';

  const dSel = div.querySelector('.r-driver');
  const bSel = div.querySelector('.r-bus');

  dSel.dataset.assignedVal = driverObjId;
  bSel.dataset.assignedVal = busObjId;

  dSel.onchange = () => { dSel.dataset.assignedVal = dSel.value; updateOptions(containerId); };
  bSel.onchange = () => { bSel.dataset.assignedVal = bSel.value; updateOptions(containerId); };
  div.querySelector('.btn-remove-row').onclick = () => { div.remove(); updateOptions(containerId); };

  container.appendChild(div);
  updateOptions(containerId);
};

window.uploadCsv = async function(endpoint, inputId) {
  const fileInput = document.getElementById(inputId);
  if (!fileInput || !fileInput.files[0]) {
    alert('Please choose a CSV file first!');
    return;
  }

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);

  const res = await fetch(endpoint, { method: 'POST', body: formData });
  const data = await res.json();

  if (res.ok) {
    alert(data.message);
    fileInput.value = '';
    if (typeof fetchData === 'function') fetchData();
  } else {
    alert('Error: ' + (data.error || 'Upload failed'));
  }
};