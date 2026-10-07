let systemRateHr = 25.00;
let systemRateMi = 2.50;
let masterDriversList = [];
let masterBusesList = [];

document.addEventListener('DOMContentLoaded', () => {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const dateEl = document.getElementById('tripDate');
  const monthEl = document.getElementById('tripMonth');
  if (dateEl) dateEl.value = todayStr;
  if (monthEl) monthEl.value = todayStr.substring(0, 7);

  loadTrips();

  setInterval(() => {
    const activeEl = document.activeElement;
    const isEditing = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT');
    if (!isEditing) {
      loadTrips();
    }
  }, 30000);
});

async function loadSystemRates() {
  try {
    const res = await fetch('/api/system-rates');
    if (res.ok) {
      const rates = await res.json();
      systemRateHr = rates.ratePerHour;
      systemRateMi = rates.ratePerMile;
      const rHr = document.getElementById('defRateHr');
      const rMi = document.getElementById('defRateMi');
      if (rHr) rHr.value = systemRateHr.toFixed(2);
      if (rMi) rMi.value = systemRateMi.toFixed(2);
    }
  } catch (e) { console.error('Error loading default rates:', e); }
}

async function fetchDriversList() {
  try {
    const res = await fetch('/api/drivers');
    if (res.ok) {
      const data = await res.json();
      masterDriversList = Array.isArray(data) ? data : [];
    }
  } catch (e) { console.error('Error loading drivers list:', e); }
}

async function fetchBusesList() {
  try {
    const res = await fetch('/api/buses');
    if (res.ok) {
      const allBuses = await res.json();
      masterBusesList = Array.isArray(allBuses) ? allBuses.filter(b => b.status !== 'In Shop') : [];
    }
  } catch (e) { console.error('Error loading buses list:', e); }
}

async function saveSystemRates() {
  const ratePerHour = parseFloat(document.getElementById('defRateHr').value) || 25.00;
  const ratePerMile = parseFloat(document.getElementById('defRateMi').value) || 2.50;

  const res = await fetch('/api/system-rates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ratePerHour, ratePerMile })
  });

  if (res.ok) {
    systemRateHr = ratePerHour;
    systemRateMi = ratePerMile;
  }
}

function format12HourTime(timeStr) {
  if (!timeStr) return '';
  if (timeStr.includes('AM') || timeStr.includes('PM')) return timeStr;
  
  const parts = timeStr.split(':');
  if (parts.length < 2) return timeStr;
  
  let hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  if (isNaN(hours) || isNaN(minutes)) return timeStr;
  
  const period = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  const minStr = minutes < 10 ? '0' + minutes : minutes;
  
  return hours + ':' + minStr + ' ' + period;
}

function toggleViewMode() {
  const mode = document.getElementById('viewMode').value;
  const dayContainer = document.getElementById('dayPickerContainer');
  const monthContainer = document.getElementById('monthPickerContainer');

  if (mode === 'day') {
    dayContainer.style.display = 'inline-block';
    monthContainer.style.display = 'none';
  } else {
    dayContainer.style.display = 'none';
    monthContainer.style.display = 'inline-block';
  }
  loadTrips();
}

function buildBusDriverAssignmentHtml(tripId, numBuses, busAssignments) {
  const count = Math.max(1, parseInt(numBuses, 10) || 1);
  busAssignments = busAssignments || [];
  let html = '<div class="pair-container">';

  for (let i = 0; i < count; i++) {
    const pair = busAssignments[i] || {};
    const currentBusId = pair.busId ? String(pair.busId._id || pair.busId) : '';
    const currentDriverId = pair.driverId ? String(pair.driverId._id || pair.driverId) : '';

    const startHr = pair.startHours || 0;
    const endHr = pair.endHours || 0;
    const startMi = pair.startMiles || 0;
    const endMi = pair.endMiles || 0;
    const bCharge = (pair.charge || 0).toFixed(2);

    html += '<div class="pair-row"><div class="pair-inputs">';
    html += '<select class="bus-pair-select" data-trip-id="' + tripId + '" data-idx="' + i + '" onchange="savePairAssignment(\'' + tripId + '\', ' + i + ')">';
    html += '<option value="">Select Bus ' + (count > 1 ? (i + 1) : '') + '</option>';
    (masterBusesList || []).forEach(b => {
      const bId = String(b._id);
      const isSel = bId === currentBusId;
      html += '<option value="' + bId + '" ' + (isSel ? 'selected' : '') + '>Bus #' + b.busNumber + (b.isSpare ? ' (Spare)' : '') + '</option>';
    });
    html += '</select>';

    html += '<select class="driver-pair-select" data-trip-id="' + tripId + '" data-idx="' + i + '" onchange="savePairAssignment(\'' + tripId + '\', ' + i + ')">';
    html += '<option value="">Select Driver ' + (count > 1 ? (i + 1) : '') + '</option>';
    (masterDriversList || []).forEach(d => {
      const dId = String(d._id);
      const isSel = dId === currentDriverId;
      html += '<option value="' + dId + '" ' + (isSel ? 'selected' : '') + '>' + d.name + '</option>';
    });
    html += '</select></div>';

    html += '<div class="pair-inputs" style="margin-top:2px;">';
    html += '<label>Start Hr: <input type="number" step="0.1" value="' + startHr + '" class="bus-start-hr" style="width:35px;" onblur="savePairAssignment(\'' + tripId + '\', ' + i + ')" /></label>';
    html += '<label>End Hr: <input type="number" step="0.1" value="' + endHr + '" class="bus-end-hr" style="width:35px;" onblur="savePairAssignment(\'' + tripId + '\', ' + i + ')" /></label>';
    html += '<label>Start Mi: <input type="number" value="' + startMi + '" class="bus-start-mi" style="width:40px;" onblur="savePairAssignment(\'' + tripId + '\', ' + i + ')" /></label>';
    html += '<label>End Mi: <input type="number" value="' + endMi + '" class="bus-end-mi" style="width:40px;" onblur="savePairAssignment(\'' + tripId + '\', ' + i + ')" /></label>';
    html += '<span style="margin-left:auto; font-weight:bold; color:#2e7d32;">$' + bCharge + '</span>';
    html += '</div></div>';
  }

  html += '</div>';
  return html;
}

function updateAllConflictDropdowns() {
  const busDropdowns = document.querySelectorAll('.bus-pair-select');
  const driverDropdowns = document.querySelectorAll('.driver-pair-select');

  const takenBusIds = new Set();
  busDropdowns.forEach(dd => { if (dd.value) takenBusIds.add(dd.value); });

  const takenDriverIds = new Set();
  driverDropdowns.forEach(dd => { if (dd.value) takenDriverIds.add(dd.value); });

  busDropdowns.forEach(dd => {
    Array.from(dd.options).forEach((opt, idx) => {
      if (idx === 0) return;
      const isTaken = takenBusIds.has(opt.value) && dd.value !== opt.value;
      opt.style.display = isTaken ? 'none' : '';
      opt.disabled = isTaken;
    });
  });

  driverDropdowns.forEach(dd => {
    Array.from(dd.options).forEach((opt, idx) => {
      if (idx === 0) return;
      const isTaken = takenDriverIds.has(opt.value) && dd.value !== opt.value;
      opt.style.display = isTaken ? 'none' : '';
      opt.disabled = isTaken;
    });
  });
}

async function handleNumBusesChange(tripId, inputEl) {
  const oldVal = parseInt(inputEl.dataset.oldVal, 10) || 1;
  const newVal = parseInt(inputEl.value, 10) || 1;

  if (newVal === oldVal) return;

  const res = await fetch('/api/district-field-trips/single/' + tripId);
  if (!res.ok) { inputEl.value = oldVal; return; }
  const trip = await res.json();

  let busAssignments = (trip.busAssignments || []).map(p => ({
    busId: p.busId ? (p.busId._id || p.busId) : null,
    driverId: p.driverId ? (p.driverId._id || p.driverId) : null,
    startHours: p.startHours || 0,
    endHours: p.endHours || 0,
    startMiles: p.startMiles || 0,
    endMiles: p.endMiles || 0
  }));

  if (newVal > oldVal) {
    const diff = newVal - oldVal;
    for (let i = 0; i < diff; i++) {
      busAssignments.push({ busId: null, driverId: null, startHours: 0, endHours: 0, startMiles: 0, endMiles: 0 });
    }
    inputEl.dataset.oldVal = newVal;
    await autoSave(tripId, 'numBuses', newVal);
    await autoSave(tripId, 'busAssignments', busAssignments);
    loadTrips();
  } else if (newVal < oldVal) {
    let promptLines = ['Number of buses decreased from ' + oldVal + ' to ' + newVal + '.', 'Which bus assignment would you like to remove?\n'];

    busAssignments.forEach((p, idx) => {
      const bMatch = masterBusesList.find(b => String(b._id) === String(p.busId));
      const dMatch = masterDriversList.find(d => String(d._id) === String(p.driverId));
      const bNum = bMatch ? ('Bus #' + bMatch.busNumber) : 'Unassigned Bus';
      const dName = dMatch ? dMatch.name : 'Unassigned Driver';
      promptLines.push('[' + (idx + 1) + '] ' + bNum + ' (' + dName + ')');
    });

    promptLines.push('\nEnter the number [1-' + busAssignments.length + '] to delete, or click Cancel:');

    const choice = prompt(promptLines.join('\n'));
    if (!choice) {
      inputEl.value = oldVal;
      return;
    }

    const deleteIdx = parseInt(choice, 10) - 1;
    if (isNaN(deleteIdx) || deleteIdx < 0 || deleteIdx >= busAssignments.length) {
      alert('Invalid selection. Action cancelled.');
      inputEl.value = oldVal;
      return;
    }

    busAssignments.splice(deleteIdx, 1);
    inputEl.dataset.oldVal = busAssignments.length;
    
    await autoSave(tripId, 'numBuses', busAssignments.length);
    await autoSave(tripId, 'busAssignments', busAssignments);
    loadTrips();
  }
}

async function savePairAssignment(tripId, index) {
  const row = document.getElementById('row_' + tripId);
  if (!row) return;

  const busSelects = row.querySelectorAll('.bus-pair-select');
  const driverSelects = row.querySelectorAll('.driver-pair-select');
  const startHrs = row.querySelectorAll('.bus-start-hr');
  const endHrs = row.querySelectorAll('.bus-end-hr');
  const startMis = row.querySelectorAll('.bus-start-mi');
  const endMis = row.querySelectorAll('.bus-end-mi');

  const busAssignments = [];
  for (let i = 0; i < busSelects.length; i++) {
    const busVal = busSelects[i] ? busSelects[i].value : '';
    const driverVal = driverSelects[i] ? driverSelects[i].value : '';
    const startH = parseFloat(startHrs[i] ? startHrs[i].value : 0) || 0;
    const endH = parseFloat(endHrs[i] ? endHrs[i].value : 0) || 0;
    const startM = parseInt(startMis[i] ? startMis[i].value : 0, 10) || 0;
    const endM = parseInt(endMis[i] ? endMis[i].value : 0, 10) || 0;

    busAssignments.push({
      busId: busVal || null,
      driverId: driverVal || null,
      startHours: startH,
      endHours: endH,
      startMiles: startM,
      endMiles: endM
    });
  }

  await autoSave(tripId, 'busAssignments', busAssignments);
  updateAllConflictDropdowns();
}

async function loadTrips() {
  await loadSystemRates();
  await fetchDriversList();
  await fetchBusesList();

  const mode = document.getElementById('viewMode').value;
  let endpoint = '';
  let dateVal = '';

  if (mode === 'day') {
    dateVal = document.getElementById('tripDate').value;
    endpoint = '/api/district-field-trips/' + dateVal;
  } else {
    dateVal = document.getElementById('tripMonth').value;
    endpoint = '/api/district-field-trips/month/' + dateVal;
  }

  const res = await fetch(endpoint);
  let trips = await res.json();

  if (!Array.isArray(trips)) {
    console.error('API Error loading trips:', trips);
    trips = [];
  }

  const tbody = document.getElementById('tripTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  let totHours = 0, totMiles = 0, totCharge = 0;

  for (let t of trips) {
    totHours += t.totalHours || 0;
    totMiles += t.totalMiles || 0;
    totCharge += t.charge || 0;

    const row = document.createElement('tr');
    row.id = 'row_' + t._id;
    row.innerHTML = '<td><input type="date" value="' + t.date + '" onblur="autoSave(\'' + t._id + '\', \'date\', this.value)" style="width:90px;" /></td>' +
      '<td><input type="text" value="' + (t.tripType || '') + '" onblur="autoSave(\'' + t._id + '\', \'tripType\', this.value)" /></td>' +
      '<td><input type="text" value="' + (t.school || '') + '" onblur="autoSave(\'' + t._id + '\', \'school\', this.value)" /></td>' +
      '<td><input type="text" value="' + (t.classTeam || '') + '" onblur="autoSave(\'' + t._id + '\', \'classTeam\', this.value)" /></td>' +
      '<td><input type="text" value="' + (t.destination || '') + '" onblur="autoSave(\'' + t._id + '\', \'destination\', this.value)" /></td>' +
      '<td><input type="text" value="' + format12HourTime(t.pickupTime || '') + '" onblur="this.value = format12HourTime(this.value); autoSave(\'' + t._id + '\', \'pickupTime\', this.value)" placeholder="3:30 PM" style="width:50px;" /></td>' +
      '<td><input type="text" value="' + format12HourTime(t.dropOffTime || '') + '" onblur="this.value = format12HourTime(this.value); autoSave(\'' + t._id + '\', \'dropOffTime\', this.value)" placeholder="9:00 PM" style="width:50px;" /></td>' +
      '<td><input type="number" value="' + (t.numBuses || 1) + '" data-old-val="' + (t.numBuses || 1) + '" onfocus="this.dataset.oldVal=this.value" onchange="handleNumBusesChange(\'' + t._id + '\', this)" style="width:28px;" /></td>' +
      '<td>' + buildBusDriverAssignmentHtml(t._id, t.numBuses, t.busAssignments) + '</td>' +
      '<td><input type="text" value="' + (t.requestedBy || '') + '" onblur="autoSave(\'' + t._id + '\', \'requestedBy\', this.value)" placeholder="Applicant" /></td>' +
      '<td><input type="text" value="' + (t.approverName || '') + '" onblur="autoSave(\'' + t._id + '\', \'approverName\', this.value)" placeholder="Approver" /></td>' +
      '<td><input type="text" value="' + (t.accountCode || '') + '" onblur="autoSave(\'' + t._id + '\', \'accountCode\', this.value)" /></td>' +
      '<td><input type="number" step="0.01" value="' + (t.ratePerHour !== undefined ? t.ratePerHour : systemRateHr) + '" onblur="autoSave(\'' + t._id + '\', \'ratePerHour\', this.value)" style="width:38px;" /></td>' +
      '<td><input type="number" step="0.01" value="' + (t.ratePerMile !== undefined ? t.ratePerMile : systemRateMi) + '" onblur="autoSave(\'' + t._id + '\', \'ratePerMile\', this.value)" style="width:38px;" /></td>' +
      '<td id="th_' + t._id + '"><b>' + (t.totalHours || 0).toFixed(1) + '</b></td>' +
      '<td id="tm_' + t._id + '"><b>' + (t.totalMiles || 0) + '</b></td>' +
      '<td id="ch_' + t._id + '"><b>$' + (t.charge || 0).toFixed(2) + '</b></td>' +
      '<td><select onchange="autoSave(\'' + t._id + '\', \'accountCodeCheck\', this.value)">' +
      '<option value="Pending" ' + (t.accountCodeCheck === 'Pending' ? 'selected' : '') + '>Pending</option>' +
      '<option value="Verified" ' + (t.accountCodeCheck === 'Verified' ? 'selected' : '') + '>Verified (Approved)</option>' +
      '<option value="Flagged" ' + (t.accountCodeCheck === 'Flagged' ? 'selected' : '') + '>Flagged (Rejected)</option>' +
      '</select></td>' +
      '<td><span id="status_' + t._id + '" style="font-size:10px; color:#2e7d32; font-weight:bold;">Saved ✓</span>' +
      '<button class="btn-del" onclick="deleteTripRow(\'' + t._id + '\')" style="margin-left:4px;">🗑️</button></td>';
    tbody.appendChild(row);
  }

  document.getElementById('kpiCount').innerText = trips.length;
  document.getElementById('kpiHours').innerText = totHours.toFixed(1);
  document.getElementById('kpiMiles').innerText = totMiles;
  document.getElementById('kpiCharge').innerText = totCharge.toFixed(2);

  updateAllConflictDropdowns();
}

async function autoSave(id, fieldName, value) {
  const statusEl = document.getElementById('status_' + id);
  if (statusEl) {
    statusEl.innerText = 'Saving...';
    statusEl.style.color = '#FF9F3D';
  }

  const payload = {};
  payload[fieldName] = value;

  const res = await fetch('/api/district-field-trips/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (res.ok) {
    const updatedTrip = await res.json();
    
    const th = document.getElementById('th_' + id);
    const tm = document.getElementById('tm_' + id);
    const ch = document.getElementById('ch_' + id);
    if (th) th.innerHTML = '<b>' + (updatedTrip.totalHours || 0).toFixed(1) + '</b>';
    if (tm) tm.innerHTML = '<b>' + (updatedTrip.totalMiles || 0) + '</b>';
    if (ch) ch.innerHTML = '<b>$' + (updatedTrip.charge || 0).toFixed(2) + '</b>';
    
    if (statusEl) {
      statusEl.innerText = 'Saved ✓';
      statusEl.style.color = '#2e7d32';
    }
    recalculateKPIs();
  } else {
    if (statusEl) {
      statusEl.innerText = 'Error ⚠️';
      statusEl.style.color = '#DD0000';
    }
  }
}

function recalculateKPIs() {
  const rows = document.querySelectorAll('#tripTableBody tr');
  let totHours = 0, totMiles = 0, totCharge = 0;

  rows.forEach(r => {
    const id = r.id.replace('row_', '');
    const thEl = document.getElementById('th_' + id);
    const tmEl = document.getElementById('tm_' + id);
    const chEl = document.getElementById('ch_' + id);

    if (thEl && tmEl && chEl) {
      totHours += parseFloat(thEl.innerText) || 0;
      totMiles += parseInt(tmEl.innerText, 10) || 0;
      totCharge += parseFloat(chEl.innerText.replace('$', '')) || 0;
    }
  });

  const kCount = document.getElementById('kpiCount');
  const kHours = document.getElementById('kpiHours');
  const kMiles = document.getElementById('kpiMiles');
  const kCharge = document.getElementById('kpiCharge');

  if (kCount) kCount.innerText = rows.length;
  if (kHours) kHours.innerText = totHours.toFixed(1);
  if (kMiles) kMiles.innerText = totMiles;
  if (kCharge) kCharge.innerText = totCharge.toFixed(2);
}

async function addEmptyTripRow() {
  const mode = document.getElementById('viewMode').value;
  const date = mode === 'day' 
    ? document.getElementById('tripDate').value 
    : (document.getElementById('tripMonth').value + '-01');

  await fetch('/api/district-field-trips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      date, 
      school: 'Parkway Central', 
      tripType: 'Athletic', 
      ratePerHour: systemRateHr, 
      ratePerMile: systemRateMi 
    })
  });
  loadTrips();
}

async function deleteTripRow(id) {
  if (!confirm('Are you sure you want to delete this trip record?')) return;
  await fetch('/api/district-field-trips/' + id, { method: 'DELETE' });
  loadTrips();
}

function exportTripsCSV() {
  const mode = document.getElementById('viewMode').value;
  const dateVal = mode === 'day' ? document.getElementById('tripDate').value : document.getElementById('tripMonth').value;
  window.location.href = '/api/district-field-trips/export/' + dateVal;
}