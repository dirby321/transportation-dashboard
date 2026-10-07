// ================= HELPER FUNCTIONS =================

function updateOptions(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const rows = Array.from(container.children);
  const selectedDrivers = new Set();
  const selectedBuses = new Set();

  rows.forEach(row => {
    const dEl = row.querySelector('.r-driver');
    const bEl = row.querySelector('.r-bus');
    const dVal = (dEl && (dEl.value || dEl.dataset.assignedVal)) || '';
    const bVal = (bEl && (bEl.value || bEl.dataset.assignedVal)) || '';

    if (dVal) selectedDrivers.add(dVal);
    if (bVal) selectedBuses.add(bVal);
  });

  const availableBuses = (window.busesList || []).filter(b => b.status !== 'In Shop');

  rows.forEach(row => {
    const driverSelect = row.querySelector('.r-driver');
    const busSelect = row.querySelector('.r-bus');
    if (!driverSelect || !busSelect) return;

    const currentDriver = String(driverSelect.value || driverSelect.dataset.assignedVal || '');
    const currentBus = String(busSelect.value || busSelect.dataset.assignedVal || '');

    let driverOpts = '<option value="">Select Driver</option>';
    (window.driversList || []).forEach(d => {
      const dIdStr = String(d._id);
      const isTaken = selectedDrivers.has(dIdStr) && dIdStr !== currentDriver;
      if (!isTaken) {
        driverOpts += '<option value="' + dIdStr + '">' + d.name + '</option>';
      }
    });
    driverSelect.innerHTML = driverOpts;

    let busOpts = '<option value="">Select Bus</option>';
    availableBuses.forEach(b => {
      const bIdStr = String(b._id);
      const isTaken = selectedBuses.has(bIdStr) && bIdStr !== currentBus;
      if (!isTaken) {
        busOpts += '<option value="' + bIdStr + '">Bus ' + b.busNumber + (b.isSpare ? ' (Spare)' : '') + '</option>';
      }
    });
    busSelect.innerHTML = busOpts;

    if (currentDriver) driverSelect.value = currentDriver;
    if (currentBus) busSelect.value = currentBus;
  });
}

function extractRoutes(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return [];
  const rows = container.children;
  const routes = [];
  for (let row of rows) {
    const nameEl = row.querySelector('.r-name');
    const timeEl = row.querySelector('.r-time');
    const driverEl = row.querySelector('.r-driver');
    const busEl = row.querySelector('.r-bus');

    if (nameEl && nameEl.value) {
      routes.push({
        routeName: nameEl.value,
        scheduledTime: timeEl ? timeEl.value : '07:00',
        driverId: (driverEl && driverEl.value) ? driverEl.value : null,
        busId: (busEl && busEl.value) ? busEl.value : null
      });
    }
  }
  return routes;
}

// ================= GLOBAL WINDOW HANDLERS =================

window.driversList = [];
window.busesList = [];
window.mechanicsList = [];

window.fetchData = async function() {
  try {
    const res = await fetch('/api/drivers');
    if (res.ok) window.driversList = await res.json();
    renderDriverList();
  } catch (e) { console.error('Error loading drivers:', e); }

  try {
    const res = await fetch('/api/buses');
    if (res.ok) window.busesList = await res.json();
    renderBusList();
  } catch (e) { console.error('Error loading buses:', e); }

  try {
    const res = await fetch('/api/mechanics');
    if (res.ok) window.mechanicsList = await res.json();
    renderMechList();
  } catch (e) { console.error('Error loading mechanics:', e); }

  await window.fetchAdminWhitelist();
  await window.loadSchedule();
};

window.syncDirectory = async function(role) {
  try {
    const res = await fetch('/api/sync/' + role, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      alert(data.message);
      window.fetchData();
    } else {
      alert('Error: ' + (data.error || 'Sync failed'));
    }
  } catch (err) {
    alert('Error connecting to server: ' + err.message);
  }
};

window.clearAllDrivers = async function() {
  if (!confirm("⚠️ ARE YOU SURE?\n\nThis will permanently delete ALL drivers from the database!")) return;
  try {
    const res = await fetch('/api/drivers/clear-all', { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      alert(data.message);
      window.fetchData();
    } else {
      alert('Error: ' + (data.error || 'Failed to clear drivers'));
    }
  } catch (err) {
    alert('Error connecting to server: ' + err.message);
  }
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

  dSel.onchange = function() { dSel.dataset.assignedVal = dSel.value; updateOptions(containerId); };
  bSel.onchange = function() { bSel.dataset.assignedVal = bSel.value; updateOptions(containerId); };
  div.querySelector('.btn-remove-row').onclick = function() { div.remove(); updateOptions(containerId); };

  container.appendChild(div);
  updateOptions(containerId);
};

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

    if (Array.isArray(data.amRoutes)) data.amRoutes.forEach(r => window.addRouteRow('amContainer', r));
    if (Array.isArray(data.pmRoutes)) data.pmRoutes.forEach(r => window.addRouteRow('pmContainer', r));
    if (Array.isArray(data.fieldTrips)) data.fieldTrips.forEach(r => window.addRouteRow('tripContainer', r));
  } catch (err) {
    console.error('Error loading schedule:', err);
  }
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
    window.fetchData();
  } else {
    alert('Error: ' + (data.error || 'Upload failed'));
  }
};

window.fetchAdminWhitelist = async function() {
  try {
    const res = await fetch('/api/admin-whitelist');
    if (!res.ok) return;
    const admins = await res.json();
    const el = document.getElementById('adminWhitelist');
    if (!el) return;
    el.innerHTML = '';
    (Array.isArray(admins) ? admins : []).forEach(a => {
      const li = document.createElement('li');
      li.style.cssText = 'display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding:6px 0; font-size:12px;';
      
      const infoSpan = document.createElement('span');
      infoSpan.innerHTML = '<b>' + (a.email || '') + '</b> <span style="color:#888; font-size:10px;">(Added by ' + (a.addedBy || 'System') + ')</span>';
      
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-action btn-delete';
      delBtn.innerText = '🗑 Remove';
      delBtn.onclick = function() { removeAdmin(a._id); };

      li.appendChild(infoSpan);
      li.appendChild(delBtn);
      el.appendChild(li);
    });
  } catch (e) { console.error('Error loading admin whitelist:', e); }
};

function renderDriverList() {
  const el = document.getElementById('driverList');
  if (!el) return;
  el.innerHTML = '';
  (window.driversList || []).forEach(d => {
    const li = document.createElement('li');
    li.style.cssText = 'display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding:6px 0; font-size:12px;';
    
    const infoSpan = document.createElement('span');
    infoSpan.innerHTML = '<b>' + (d.name || '') + '</b> (' + (d.email || '') + ')';
    
    const btnDiv = document.createElement('div');
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-action btn-delete';
    delBtn.innerText = '🗑 Delete';
    delBtn.onclick = function() { deleteItem('driver', d._id); };
    
    btnDiv.appendChild(delBtn);
    li.appendChild(infoSpan);
    li.appendChild(btnDiv);
    el.appendChild(li);
  });
}

function renderBusList() {
  const el = document.getElementById('busList');
  if (!el) return;
  el.innerHTML = '';
  (window.busesList || []).forEach(b => {
    const li = document.createElement('li');
    li.style.cssText = 'display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding:6px 0; font-size:12px;';
    
    const infoSpan = document.createElement('span');
    infoSpan.innerHTML = '<b>Bus #' + (b.busNumber || '') + '</b> ' + (b.isSpare ? '(Spare)' : '') + ' ' + (b.status === 'In Shop' ? '<b style="color:#DD0000;">[IN SHOP]</b>' : '');
    
    const btnDiv = document.createElement('div');
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-action btn-delete';
    delBtn.innerText = '🗑 Delete';
    delBtn.onclick = function() { deleteItem('bus', b._id); };
    
    btnDiv.appendChild(delBtn);
    li.appendChild(infoSpan);
    li.appendChild(btnDiv);
    el.appendChild(li);
  });
}

function renderMechList() {
  const el = document.getElementById('mechList');
  if (!el) return;
  el.innerHTML = '';
  (window.mechanicsList || []).forEach(m => {
    const li = document.createElement('li');
    li.style.cssText = 'display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding:6px 0; font-size:12px;';
    
    const infoSpan = document.createElement('span');
    infoSpan.innerHTML = '<b>' + (m.name || '') + '</b> (' + (m.email || '') + ')';
    
    const btnDiv = document.createElement('div');
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-action btn-delete';
    delBtn.innerText = '🗑 Delete';
    delBtn.onclick = function() { deleteItem('mechanic', m._id); };
    
    btnDiv.appendChild(delBtn);
    li.appendChild(infoSpan);
    li.appendChild(btnDiv);
    el.appendChild(li);
  });
}

async function deleteItem(type, id) {
  if (!confirm('Are you sure you want to delete this ' + type + '?')) return;
  const endpoint = type === 'driver' ? '/api/drivers/' : type === 'bus' ? '/api/buses/' : '/api/mechanics/';
  let res = await fetch(endpoint + id, { method: 'DELETE' });
  let data = await res.json();

  if (!res.ok && data.hasConflict) {
    const forceDelete = confirm(data.error + '\n\nDo you want to FORCE DELETE anyway?');
    if (forceDelete) {
      res = await fetch(endpoint + id + '?force=true', { method: 'DELETE' });
      data = await res.json();
      if (res.ok) { alert(type.toUpperCase() + ' force deleted.'); window.fetchData(); }
      else { alert('Error: ' + data.error); }
    }
  } else if (res.ok) { window.fetchData(); }
  else { alert('Error: ' + data.error); }
}

async function removeAdmin(id) {
  if (!confirm('Are you sure you want to remove this admin record?')) return;
  await fetch('/api/admin-whitelist/' + id, { method: 'DELETE' });
  window.fetchAdminWhitelist();
}

// ================= DOM INITIALIZATION =================

document.addEventListener('DOMContentLoaded', function() {
  const schedDateEl = document.getElementById('scheduleDate');
  if (schedDateEl) {
    schedDateEl.value = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  }

  const adminForm = document.getElementById('adminWhitelistForm');
  if (adminForm) {
    adminForm.onsubmit = async function(e) {
      e.preventDefault();
      const emailInput = document.getElementById('aEmail');
      const res = await fetch('/api/admin-whitelist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput.value })
      });
      if (res.ok) { emailInput.value = ''; window.fetchAdminWhitelist(); }
      else { const data = await res.json(); alert('Error: ' + (data.error || 'Failed to add admin')); }
    };
  }

  const dForm = document.getElementById('driverForm');
  if (dForm) {
    dForm.onsubmit = async function(e) {
      e.preventDefault();
      const res = await fetch('/api/drivers', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ name: document.getElementById('dName').value, email: document.getElementById('dEmail').value })
      });
      if (res.ok) { e.target.reset(); window.fetchData(); }
      else { const data = await res.json(); alert('Error: ' + data.error); }
    };
  }

  const bForm = document.getElementById('busForm');
  if (bForm) {
    bForm.onsubmit = async function(e) {
      e.preventDefault();
      await fetch('/api/buses', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ busNumber: document.getElementById('bNumber').value, isSpare: document.getElementById('bSpare').checked })
      });
      e.target.reset();
      window.fetchData();
    };
  }

  const mForm = document.getElementById('mechForm');
  if (mForm) {
    mForm.onsubmit = async function(e) {
      e.preventDefault();
      const res = await fetch('/api/mechanics', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ name: document.getElementById('mName').value, email: document.getElementById('mEmail').value })
      });
      if (res.ok) { e.target.reset(); window.fetchData(); }
      else { const data = await res.json(); alert('Error: ' + data.error); }
    };
  }

  window.fetchData();
});