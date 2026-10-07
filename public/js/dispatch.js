document.addEventListener('DOMContentLoaded', () => {
  const dateEl = document.getElementById('kioskDate');
  if (dateEl) {
    dateEl.value = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  }
  loadKioskData();
  setInterval(loadKioskData, 30000);
});

function toggleFullScreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(err => alert(err.message));
  } else if (document.exitFullscreen) {
    document.exitFullscreen();
  }
}

function filterByDriver() {
  const searchVal = document.getElementById('driverSearch').value.toLowerCase();
  document.querySelectorAll('.route-card').forEach(card => {
    const driverText = card.getAttribute('data-driver') || '';
    card.style.display = driverText.toLowerCase().includes(searchVal) ? 'flex' : 'none';
  });
}

async function loadKioskData() {
  const date = document.getElementById('kioskDate').value;
  const slot = document.getElementById('slotFilter').value;
  const res = await fetch('/api/schedule/' + date);
  const schedule = await res.json();

  let routes = [];
  if (slot === 'all') {
    const ams = Array.isArray(schedule.amRoutes) ? schedule.amRoutes.map(r => ({ ...r, categoryTag: 'AM' })) : [];
    const pms = Array.isArray(schedule.pmRoutes) ? schedule.pmRoutes.map(r => ({ ...r, categoryTag: 'PM' })) : [];
    const trips = Array.isArray(schedule.fieldTrips) ? schedule.fieldTrips.map(r => ({ ...r, categoryTag: 'Field Trip' })) : [];
    routes = [...ams, ...pms, ...trips];
  } else {
    const targetSlot = Array.isArray(schedule[slot]) ? schedule[slot] : [];
    routes = targetSlot.map(r => ({ 
      ...r, 
      categoryTag: slot === 'amRoutes' ? 'AM' : slot === 'pmRoutes' ? 'PM' : 'Field Trip' 
    }));
  }

  const colPending = document.getElementById('colPending');
  const colEnRoute = document.getElementById('colEnRoute');
  const colReturned = document.getElementById('colReturned');

  if (!colPending || !colEnRoute || !colReturned) return;

  colPending.innerHTML = ''; colEnRoute.innerHTML = ''; colReturned.innerHTML = '';
  let cPending = 0, cEnRoute = 0, cReturned = 0;

  routes.forEach(r => {
    const driverName = r.driverId ? r.driverId.name : 'Unassigned';
    const busNum = r.busId ? ('Bus #' + r.busId.busNumber) : 'Unassigned';
    const card = document.createElement('div');
    
    const isDelayed = r.status === 'Delayed';
    const inShopAlert = (r.busId && r.busId.status === 'In Shop') 
      ? '<span class="badge" style="background:#DD0000; color:#fff;">🛠 BUS IN SHOP</span>' 
      : '';

    card.className = 'route-card ' + (isDelayed ? 'route-card-delayed' : '');
    card.setAttribute('data-driver', driverName);

    if (r.status === 'Pending' || isDelayed) {
      cPending++;
      card.innerHTML = '<div style="display:flex; align-items:center; gap:5px; overflow:hidden;">' +
        '<span class="route-card-title">' + r.routeName + '</span>' +
        '<span class="badge badge-slot">' + r.categoryTag + '</span>' + inShopAlert +
        (isDelayed ? '<span class="badge badge-delayed">⚠️</span>' : '') + '</div>' +
        '<div style="color:#444; font-size:10px;">👤 ' + driverName + ' | 🚌 ' + busNum + '</div>' +
        '<button class="btn-checkin" onclick="updateStatus(\'' + r._id + '\', \'En Route\')">Check In ➔</button>';
      colPending.appendChild(card);
    } else if (r.status === 'En Route') {
      cEnRoute++;
      card.innerHTML = '<div style="display:flex; align-items:center; gap:5px; overflow:hidden;">' +
        '<span class="route-card-title">' + r.routeName + '</span>' +
        '<span class="badge badge-slot">' + r.categoryTag + '</span>' + inShopAlert + '</div>' +
        '<div style="color:#444; font-size:10px;">👤 ' + driverName + ' | 🚌 ' + busNum + '</div>' +
        '<div style="display:flex; gap:3px; align-items:center;">' +
        '<select onchange="if(this.value) updateStatus(\'' + r._id + '\', this.value)"><option value="">Return...</option><option value="Returned - On Site">On Site</option><option value="Returned - Left for the Day">Left Day</option></select>' +
        '<button class="btn-undo" onclick="updateStatus(\'' + r._id + '\', \'Pending\')">Undo</button></div>';
      colEnRoute.appendChild(card);
    } else {
      cReturned++;
      card.innerHTML = '<div style="display:flex; align-items:center; gap:5px; overflow:hidden;">' +
        '<span class="route-card-title">' + r.routeName + '</span>' +
        '<span class="badge badge-slot">' + r.categoryTag + '</span>' + inShopAlert + '</div>' +
        '<div style="color:#444; font-size:10px;">👤 ' + driverName + ' | 🚌 ' + busNum + '</div>' +
        '<button class="btn-undo" onclick="updateStatus(\'' + r._id + '\', \'En Route\')">Undo</button>';
      colReturned.appendChild(card);
    }
  });

  document.getElementById('countPending').innerText = cPending;
  document.getElementById('countEnRoute').innerText = cEnRoute;
  document.getElementById('countReturned').innerText = cReturned;

  filterByDriver();
}

async function updateStatus(routeId, status) {
  let startMiles = null;
  let endMiles = null;

  // Prompts ONLY happen during Return status update
  if (status && status.startsWith('Returned')) {
    const startInput = prompt('Enter STARTING Mileage for this trip:');
    if (startInput === null) return; // Driver clicked Cancel
    if (startInput.trim() !== '') startMiles = parseFloat(startInput.trim());

    const endInput = prompt('Enter ENDING Mileage for this trip:');
    if (endInput === null) return; // Driver clicked Cancel
    if (endInput.trim() !== '') endMiles = parseFloat(endInput.trim());
  }

  const date = document.getElementById('kioskDate').value;
  const category = document.getElementById('slotFilter').value;
  
  await fetch('/api/schedule/update-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, category, routeId, status, startMiles, endMiles })
  });
  loadKioskData();
}