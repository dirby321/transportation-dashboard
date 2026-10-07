document.addEventListener('DOMContentLoaded', () => {
  loadBuses();
});

async function loadBuses() {
  const res = await fetch('/api/buses');
  let buses = await res.json();
  if (!Array.isArray(buses)) buses = [];

  const grid = document.getElementById('busGrid');
  if (!grid) return;
  grid.innerHTML = '';

  buses.forEach(b => {
    const inShop = b.status === 'In Shop';
    const card = document.createElement('div');
    card.className = 'card ' + (inShop ? 'card-in-shop' : '');

    card.innerHTML = '<div style="display:flex; justify-content:space-between; align-items:center;">' +
      '<h3 style="margin:0; font-size:18px;">Bus #' + b.busNumber + ' ' + (b.isSpare ? '(Spare)' : '') + '</h3>' +
      '<span class="status-badge ' + (inShop ? 'badge-shop' : 'badge-available') + '">' + b.status + '</span></div>' +
      '<form onsubmit="saveBusStatus(event, \'' + b._id + '\')">' +
      '<label style="font-size:12px; font-weight:bold;">Status:</label>' +
      '<select class="b-status" onchange="toggleShopFields(this)"><option value="Available" ' + (!inShop ? 'selected' : '') + '>Available</option><option value="In Shop" ' + (inShop ? 'selected' : '') + '>In Shop</option></select>' +
      '<div class="shop-fields" style="display: ' + (inShop ? 'flex' : 'none') + '; flex-direction:column; gap:8px;">' +
      '<input type="text" class="b-reason" placeholder="Reason (e.g. Brakes, Oil Change)" value="' + (b.offlineReason || '') + '" />' +
      '<label style="font-size:11px; font-weight:bold;">Expected Return Date: <input type="date" class="b-return" value="' + (b.expectedReturnDate || '') + '" /></label></div>' +
      '<button type="submit" style="margin-top:6px;">Update Bus</button></form>';
    grid.appendChild(card);
  });
}

function toggleShopFields(selectEl) {
  const fields = selectEl.parentElement.querySelector('.shop-fields');
  if (fields) fields.style.display = selectEl.value === 'In Shop' ? 'flex' : 'none';
}

async function saveBusStatus(e, busId) {
  e.preventDefault();
  const form = e.target;
  const status = form.querySelector('.b-status').value;
  const offlineReason = form.querySelector('.b-reason').value;
  const expectedReturnDate = form.querySelector('.b-return').value;

  const res = await fetch('/api/buses/update-status', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ 
      busId, 
      status, 
      offlineReason, 
      expectedReturnDate,
      autoSwapSpare: true 
    })
  });

  const data = await res.json();
  if (res.ok) {
    alert(data.message);
    loadBuses();
  } else {
    alert('Error: ' + data.error);
  }
}