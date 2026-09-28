const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/myappdb';

const connectWithRetry = () => {
  console.log('Connecting to MongoDB...');
  mongoose.connect(MONGO_URI)
    .then(() => {
      console.log('Successfully connected to MongoDB!');
      startDelayedRouteScanner();
    })
    .catch((err) => {
      console.error('MongoDB connection error:', err.message);
      setTimeout(connectWithRetry, 5000);
    });
};

connectWithRetry();

// ================= SCHEMAS =================
const Driver = mongoose.model('Driver', new mongoose.Schema({
  name: { type: String, required: true },
  staffId: { type: String, required: true, unique: true },
  phoneNumber: { type: String, required: true }
}));

const Bus = mongoose.model('Bus', new mongoose.Schema({
  busNumber: { type: String, required: true, unique: true },
  isSpare: { type: Boolean, default: false },
  status: { type: String, enum: ['Available', 'In Shop'], default: 'Available' },
  offlineReason: { type: String, default: '' },
  expectedReturnDate: { type: String, default: '' }
}));

const Mechanic = mongoose.model('Mechanic', new mongoose.Schema({
  name: { type: String, required: true },
  phoneNumber: { type: String, required: true }
}));

const RouteEntrySchema = new mongoose.Schema({
  routeName: String,
  scheduledTime: { type: String, default: '07:00' },
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
  busId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus' },
  status: { 
    type: String, 
    enum: ['Pending', 'Delayed', 'En Route', 'Returned - On Site', 'Returned - Left for the Day'], 
    default: 'Pending' 
  },
  checkInTime: String,
  returnTime: String
});

const DailySchedule = mongoose.model('DailySchedule', new mongoose.Schema({
  date: { type: String, required: true, unique: true },
  amRoutes: [RouteEntrySchema],
  pmRoutes: [RouteEntrySchema],
  fieldTrips: [RouteEntrySchema]
}));

// ================= AUTOMATED DELAYED ROUTE MONITOR =================
function startDelayedRouteScanner() {
  console.log('Starting background delayed route scanner...');
  setInterval(async () => {
    try {
      const todayStr = new Date().toISOString().split('T')[0];
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();

      const schedule = await DailySchedule.findOne({ date: todayStr });
      if (!schedule) return;

      let updated = false;
      const categories = ['amRoutes', 'pmRoutes', 'fieldTrips'];

      categories.forEach(cat => {
        schedule[cat].forEach(route => {
          if (route.status === 'Pending' && route.scheduledTime) {
            const [hours, minutes] = route.scheduledTime.split(':').map(Number);
            const scheduledMinutes = hours * 60 + minutes;

            if (currentMinutes > scheduledMinutes + 10) {
              route.status = 'Delayed';
              updated = true;
              console.log(`[ALERT] Route "${route.routeName}" on ${todayStr} flagged as DELAYED.`);
            }
          }
        });
      });

      if (updated) {
        await schedule.save();
      }
    } catch (err) {
      console.error('Error scanning delayed routes:', err.message);
    }
  }, 60000);
}

const validateNoDuplicates = (routes, categoryName) => {
  const driversSeen = new Set();
  const busesSeen = new Set();

  for (let r of routes) {
    if (r.driverId) {
      const dId = r.driverId.toString();
      if (driversSeen.has(dId)) throw new Error(`Conflict in ${categoryName}: Driver assigned multiple times.`);
      driversSeen.add(dId);
    }
    if (r.busId) {
      const bId = r.busId.toString();
      if (busesSeen.has(bId)) throw new Error(`Conflict in ${categoryName}: Bus assigned multiple times.`);
      busesSeen.add(bId);
    }
  }
};

// ================= HELPER FOR STANDARDIZED HEADER =================
function renderHeader(activePage, showFullscreen = false) {
  return `
  <header>
    <div>
      <div class="brand-title">PARKWAY SCHOOLS</div>
      <div class="brand-tagline">HIGHER EXPECTATIONS. BRIGHTER FUTURES.</div>
    </div>
    <div style="display:flex; align-items:center;">
      ${showFullscreen ? '<button class="nav-btn" onclick="toggleFullScreen()">📺 Fullscreen</button>' : ''}
      <a href="/dashboard" class="nav-btn ${activePage === 'dashboard' ? 'nav-active' : ''}">📺 Live Monitor</a>
      <a href="/dispatch" class="nav-btn ${activePage === 'dispatch' ? 'nav-active' : ''}">📱 Driver Kiosk</a>
      <a href="/admin" class="nav-btn ${activePage === 'admin' ? 'nav-active' : ''}">📋 Admin Portal</a>
      <a href="/mechanics" class="nav-btn ${activePage === 'mechanics' ? 'nav-active' : ''}">🛠️ Shop Portal</a>
    </div>
  </header>
  `;
}

const COMMON_CSS = `
  body { font-family: 'Trebuchet MS', sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; color: #000; }
  header { background-color: #DD0000; color: #fff; padding: 10px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #FF9F3D; }
  .brand-title { font-size: 18px; font-weight: bold; text-transform: uppercase; }
  .brand-tagline { font-size: 10px; letter-spacing: 1px; color: #fff; }
  .nav-btn { color:#fff; font-weight:bold; background:#666; padding:6px 12px; border:none; cursor:pointer; text-decoration:none; font-size:11px; margin-left: 6px; border-radius: 2px; font-family:'Trebuchet MS'; display:inline-block; }
  .nav-btn:hover { background: #444; }
  .nav-active { background: #DD0000; border: 1.5px solid #ffffff; }
`;

// ================= SAMPLE CSV DOWNLOAD ENDPOINTS =================

app.get('/api/samples/drivers', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="drivers_sample.csv"');
  res.send("name,staffId,phoneNumber\nJohn Doe,DRV101,314-555-0101\nJane Smith,DRV102,314-555-0102\n");
});

app.get('/api/samples/buses', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="buses_sample.csv"');
  res.send("busNumber,isSpare\n101,false\n102,true\n103,false\n");
});

app.get('/api/samples/mechanics', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="mechanics_sample.csv"');
  res.send("name,phoneNumber\nMike Taylor,314-555-0199\nSarah Connor,314-555-0188\n");
});

app.get('/api/samples/schedule', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="schedule_sample.csv"');
  res.send("date,slot,routeName,scheduledTime,staffId,busNumber\n2026-09-28,amRoutes,Route 12,07:00,DRV101,101\n2026-09-28,amRoutes,Route 14,07:15,DRV102,103\n2026-09-28,pmRoutes,Route 12,14:30,DRV101,101\n2026-09-28,fieldTrips,Zoo Trip,09:00,DRV102,102\n");
});

// ================= CSV UPLOAD API ENDPOINTS =================

app.post('/api/upload/drivers', upload.single('file'), (req, res) => {
  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      try {
        for (let row of results) {
          if (row.name && row.staffId && row.phoneNumber) {
            await Driver.findOneAndUpdate(
              { staffId: row.staffId.trim() },
              { name: row.name.trim(), staffId: row.staffId.trim(), phoneNumber: row.phoneNumber.trim() },
              { upsert: true }
            );
          }
        }
        fs.unlinkSync(req.file.path);
        res.json({ message: `Successfully imported/updated ${results.length} drivers!` });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });
});

app.post('/api/upload/buses', upload.single('file'), (req, res) => {
  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      try {
        for (let row of results) {
          if (row.busNumber) {
            const isSpare = String(row.isSpare).toLowerCase() === 'true';
            await Bus.findOneAndUpdate(
              { busNumber: row.busNumber.trim() },
              { busNumber: row.busNumber.trim(), isSpare },
              { upsert: true }
            );
          }
        }
        fs.unlinkSync(req.file.path);
        res.json({ message: `Successfully imported/updated ${results.length} buses!` });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });
});

app.post('/api/upload/mechanics', upload.single('file'), (req, res) => {
  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      try {
        for (let row of results) {
          if (row.name && row.phoneNumber) {
            await Mechanic.findOneAndUpdate(
              { name: row.name.trim() },
              { name: row.name.trim(), phoneNumber: row.phoneNumber.trim() },
              { upsert: true }
            );
          }
        }
        fs.unlinkSync(req.file.path);
        res.json({ message: `Successfully imported/updated ${results.length} mechanics!` });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });
});

app.post('/api/upload/schedule', upload.single('file'), (req, res) => {
  const rows = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => rows.push(data))
    .on('end', async () => {
      try {
        const drivers = await Driver.find();
        const buses = await Bus.find();

        const driverMap = new Map(drivers.map(d => [d.staffId, d._id]));
        const busMap = new Map(buses.map(b => [b.busNumber, b._id]));

        const schedulesByDate = {};

        for (let row of rows) {
          const { date, slot, routeName, scheduledTime, staffId, busNumber } = row;
          if (!date || !slot || !routeName) continue;

          if (!schedulesByDate[date]) {
            schedulesByDate[date] = { amRoutes: [], pmRoutes: [], fieldTrips: [] };
          }

          const driverId = driverMap.get(staffId?.trim()) || null;
          const busId = busMap.get(busNumber?.trim()) || null;

          if (schedulesByDate[date][slot]) {
            schedulesByDate[date][slot].push({ 
              routeName: routeName.trim(), 
              scheduledTime: scheduledTime ? scheduledTime.trim() : '07:00',
              driverId, 
              busId 
            });
          }
        }

        for (let date in schedulesByDate) {
          await DailySchedule.findOneAndUpdate(
            { date },
            schedulesByDate[date],
            { upsert: true, new: true }
          );
        }

        fs.unlinkSync(req.file.path);
        res.json({ message: `Successfully imported schedules for ${Object.keys(schedulesByDate).length} date(s)!` });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });
});

// ================= ROUTE AND STATUS APIs =================

// --- Drivers CRUD with Auto-Unassign ---
app.get('/api/drivers', async (req, res) => res.json(await Driver.find()));
app.post('/api/drivers', async (req, res) => {
  try {
    const driver = new Driver(req.body);
    await driver.save();
    res.status(201).json(driver);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/drivers/:id', async (req, res) => {
  try {
    const driver = await Driver.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(driver);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/drivers/:id', async (req, res) => {
  try {
    const driverId = req.params.id;
    const force = req.query.force === 'true';
    const todayStr = new Date().toISOString().split('T')[0];

    const futureSchedules = await DailySchedule.find({
      date: { $gte: todayStr },$or: [
        { 'amRoutes.driverId': driverId },
        { 'pmRoutes.driverId': driverId },
        { 'fieldTrips.driverId': driverId }
      ]
    });

    if (futureSchedules.length > 0 && !force) {
      const dates = futureSchedules.map(s => s.date).join(', ');
      return res.status(400).json({
        hasConflict: true,
        error: `Driver is assigned to future route schedules on: ${dates}. Please reassign them first or confirm force deletion to unassign them automatically.`
      });
    }

    if (force && futureSchedules.length > 0) {
      await DailySchedule.updateMany(
        { date: { $gte: todayStr } },
        {
          $set: {
            'amRoutes.$[elem1].driverId': null,
            'pmRoutes.$[elem2].driverId': null,
            'fieldTrips.$[elem3].driverId': null
          }
        },
        {
          arrayFilters: [
            { 'elem1.driverId': driverId },
            { 'elem2.driverId': driverId },
            { 'elem3.driverId': driverId }
          ]
        }
      );
    }

    await Driver.findByIdAndDelete(driverId);
    res.json({ success: true, unassignedSchedules: force ? futureSchedules.length : 0 });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// --- Buses CRUD with Auto-Unassign ---
app.get('/api/buses', async (req, res) => res.json(await Bus.find()));
app.post('/api/buses', async (req, res) => {
  try {
    const bus = new Bus(req.body);
    await bus.save();
    res.status(201).json(bus);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/buses/:id', async (req, res) => {
  try {
    const bus = await Bus.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(bus);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/buses/:id', async (req, res) => {
  try {
    const busId = req.params.id;
    const force = req.query.force === 'true';
    const todayStr = new Date().toISOString().split('T')[0];

    const futureSchedules = await DailySchedule.find({
      date: { $gte: todayStr },$or: [
        { 'amRoutes.busId': busId },
        { 'pmRoutes.busId': busId },
        { 'fieldTrips.busId': busId }
      ]
    });

    if (futureSchedules.length > 0 && !force) {
      const dates = futureSchedules.map(s => s.date).join(', ');
      return res.status(400).json({
        hasConflict: true,
        error: `Bus is assigned to future route schedules on: ${dates}. Please reassign it first or confirm force deletion to unassign it automatically.`
      });
    }

    if (force && futureSchedules.length > 0) {
      await DailySchedule.updateMany(
        { date: { $gte: todayStr } },
        {
          $set: {
            'amRoutes.$[elem1].busId': null,
            'pmRoutes.$[elem2].busId': null,
            'fieldTrips.$[elem3].busId': null
          }
        },
        {
          arrayFilters: [
            { 'elem1.busId': busId },
            { 'elem2.busId': busId },
            { 'elem3.busId': busId }
          ]
        }
      );
    }

    await Bus.findByIdAndDelete(busId);
    res.json({ success: true, unassignedSchedules: force ? futureSchedules.length : 0 });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/buses/update-status', async (req, res) => {
  const { busId, status, offlineReason, expectedReturnDate } = req.body;
  try {
    const bus = await Bus.findByIdAndUpdate(
      busId,
      { status, offlineReason: status === 'In Shop' ? offlineReason : '', expectedReturnDate: status === 'In Shop' ? expectedReturnDate : '' },
      { new: true }
    );
    res.json(bus);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// --- Mechanics CRUD ---
app.get('/api/mechanics', async (req, res) => res.json(await Mechanic.find()));
app.post('/api/mechanics', async (req, res) => {
  try {
    const mechanic = new Mechanic(req.body);
    await mechanic.save();
    res.status(201).json(mechanic);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.put('/api/mechanics/:id', async (req, res) => {
  try {
    const mechanic = await Mechanic.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(mechanic);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/mechanics/:id', async (req, res) => {
  try {
    await Mechanic.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/schedule/:date', async (req, res) => {
  let schedule = await DailySchedule.findOne({ date: req.params.date })
    .populate('amRoutes.driverId amRoutes.busId')
    .populate('pmRoutes.driverId pmRoutes.busId')
    .populate('fieldTrips.driverId fieldTrips.busId');
  
  if (!schedule) {
    schedule = { date: req.params.date, amRoutes: [], pmRoutes: [], fieldTrips: [] };
  }
  res.json(schedule);
});

app.post('/api/schedule', async (req, res) => {
  const { date, amRoutes, pmRoutes, fieldTrips } = req.body;
  try {
    validateNoDuplicates(amRoutes, 'AM Routes');
    validateNoDuplicates(pmRoutes, 'PM Routes');
    validateNoDuplicates(fieldTrips, 'Field Trips');

    const schedule = await DailySchedule.findOneAndUpdate(
      { date },
      { amRoutes, pmRoutes, fieldTrips },
      { upsert: true, new: true }
    );
    res.json(schedule);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/schedule/update-status', async (req, res) => {
  const { date, category, routeId, status } = req.body;
  try {
    const schedule = await DailySchedule.findOne({ date });
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

    let route = null;
    if (category === 'all') {
      ['amRoutes', 'pmRoutes', 'fieldTrips'].forEach(cat => {
        const found = schedule[cat].id(routeId);
        if (found) route = found;
      });
    } else {
      route = schedule[category].id(routeId);
    }

    if (!route) return res.status(404).json({ error: 'Route item not found' });

    const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    route.status = status;
    if (status === 'En Route') {
      route.checkInTime = nowStr;
    } else if (status === 'Pending' || status === 'Delayed') {
      route.checkInTime = null;
      route.returnTime = null;
    } else if (status.startsWith('Returned')) {
      route.returnTime = nowStr;
    }

    await schedule.save();
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/schedule/copy-forward', async (req, res) => {
  const { targetDate } = req.body;
  try {
    const targetObj = new Date(targetDate);
    targetObj.setDate(targetObj.getDate() - 1);
    const prevDate = targetObj.toISOString().split('T')[0];

    const prevSchedule = await DailySchedule.findOne({ date: prevDate });
    if (!prevSchedule) {
      return res.status(404).json({ error: `No schedule found for previous day (${prevDate}) to copy.` });
    }

    const resetRoutes = (routes) => routes.map(r => ({
      routeName: r.routeName,
      scheduledTime: r.scheduledTime,
      driverId: r.driverId,
      busId: r.busId,
      notes: r.notes,
      status: 'Pending',
      checkInTime: null,
      returnTime: null
    }));

    const newSchedule = await DailySchedule.findOneAndUpdate(
      { date: targetDate },
      {
        amRoutes: resetRoutes(prevSchedule.amRoutes),
        pmRoutes: resetRoutes(prevSchedule.pmRoutes),
        fieldTrips: resetRoutes(prevSchedule.fieldTrips)
      },
      { upsert: true, new: true }
    );
    res.json(newSchedule);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ================= VIEW-ONLY DISPATCH MONITOR DASHBOARD =================
app.get('/dashboard', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Parkway Schools - Live Dispatch Monitor</title>
  <style>
    ${COMMON_CSS}
    .toolbar { background: #fff; padding: 8px 20px; display: flex; gap: 15px; align-items: center; border-bottom: 1px solid #ccc; }
    .kiosk-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; padding: 10px; height: calc(100vh - 105px); box-sizing: border-box; }
    .column { background: #fff; border-radius: 4px; border-top: 4px solid #666; padding: 8px; display: flex; flex-direction: column; box-shadow: 0 1px 4px rgba(0,0,0,0.1); overflow-y: auto; }
    .column-pending { border-top-color: #FF9F3D; }
    .column-enroute { border-top-color: #DD0000; }
    .column-returned { border-top-color: #2e7d32; }
    .col-title { font-size: 13px; font-weight: bold; text-transform: uppercase; padding-bottom: 4px; margin-bottom: 6px; border-bottom: 2px solid #ddd; display: flex; justify-content: space-between; }
    
    .route-card {
      background: #fafafa;
      border: 1px solid #e0e0e0;
      border-left: 4px solid #666;
      padding: 6px 10px;
      margin-bottom: 5px;
      border-radius: 2px;
      font-size: 11px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      white-space: nowrap;
      gap: 8px;
    }
    .route-card-delayed { border: 1.5px solid #DD0000; border-left: 5px solid #DD0000; background: #fff0f0; }
    .route-card-title { font-weight: bold; font-size: 12px; color: #DD0000; }
    .badge { background: #eee; padding: 2px 5px; border-radius: 3px; font-size: 9px; font-weight: bold; }
    .badge-slot { background: #666; color: #fff; text-transform: uppercase; }
    .badge-delayed { background: #DD0000; color: #fff; text-transform: uppercase; }
  </style>
</head>
<body>
  ${renderHeader('dashboard', true)}

  <div class="toolbar">
    <label style="font-weight: bold; font-size: 12px;">Date: 
      <input type="date" id="dashDate" onchange="loadDashData()" style="padding:2px; font-family:'Trebuchet MS';" />
    </label>
    <label style="font-weight: bold; font-size: 12px;">Slot: 
      <select id="slotFilter" onchange="loadDashData()" style="font-family:'Trebuchet MS'; padding:2px;">
        <option value="all">All Routes</option>
        <option value="amRoutes">AM Routes</option>
        <option value="pmRoutes">PM Routes</option>
        <option value="fieldTrips">Field Trips</option>
      </select>
    </label>
    <span style="margin-left: auto; font-size:10px; color:#666;">Auto-refreshes every 10s</span>
  </div>

  <div class="kiosk-grid">
    <div class="column column-pending">
      <div class="col-title">1. Pending / Delayed <span id="countPending" class="badge">0</span></div>
      <div id="colPending"></div>
    </div>
    <div class="column column-enroute">
      <div class="col-title">2. En Route <span id="countEnRoute" class="badge">0</span></div>
      <div id="colEnRoute"></div>
    </div>
    <div class="column column-returned">
      <div class="col-title">3. Returned <span id="countReturned" class="badge">0</span></div>
      <div id="colReturned"></div>
    </div>
  </div>

  <script>
    document.getElementById('dashDate').value = new Date().toISOString().split('T')[0];

    function toggleFullScreen() {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => alert(err.message));
      } else {
        if (document.exitFullscreen) document.exitFullscreen();
      }
    }

    async function loadDashData() {
      const date = document.getElementById('dashDate').value;
      const slot = document.getElementById('slotFilter').value;
      const res = await fetch('/api/schedule/' + date);
      const schedule = await res.json();

      let routes = [];
      if (slot === 'all') {
        const ams = (schedule.amRoutes || []).map(r => ({ ...r, categoryTag: 'AM' }));
        const pms = (schedule.pmRoutes || []).map(r => ({ ...r, categoryTag: 'PM' }));
        const trips = (schedule.fieldTrips || []).map(r => ({ ...r, categoryTag: 'Field Trip' }));
        routes = [...ams, ...pms, ...trips];
      } else {
        routes = (schedule[slot] || []).map(r => ({ 
          ...r, 
          categoryTag: slot === 'amRoutes' ? 'AM' : slot === 'pmRoutes' ? 'PM' : 'Field Trip' 
        }));
      }

      const colPending = document.getElementById('colPending');
      const colEnRoute = document.getElementById('colEnRoute');
      const colReturned = document.getElementById('colReturned');

      colPending.innerHTML = ''; colEnRoute.innerHTML = ''; colReturned.innerHTML = '';
      let cPending = 0, cEnRoute = 0, cReturned = 0;

      routes.forEach(r => {
        const driverName = r.driverId ? r.driverId.name : 'Unassigned';
        const busNum = r.busId ? ('Bus #' + r.busId.busNumber) : 'Unassigned';
        const card = document.createElement('div');
        
        const isDelayed = r.status === 'Delayed';
        card.className = 'route-card ' + (isDelayed ? 'route-card-delayed' : '');

        if (r.status === 'Pending' || isDelayed) {
          cPending++;
          card.innerHTML = \`
            <div style="display:flex; align-items:center; gap:5px; overflow:hidden;">
              <span class="route-card-title">\${r.routeName}</span>
              <span class="badge badge-slot">\${r.categoryTag}</span>
              \${isDelayed ? '<span class="badge badge-delayed">⚠️ Delayed</span>' : ''}
            </div>
            <div style="color:#444;">👤 \${driverName} | 🚌 \${busNum}</div>
            <div style="font-weight:bold; color:#666;">⏰ \${r.scheduledTime || 'N/A'}</div>
          \`;
          colPending.appendChild(card);
        } else if (r.status === 'En Route') {
          cEnRoute++;
          card.innerHTML = \`
            <div style="display:flex; align-items:center; gap:5px; overflow:hidden;">
              <span class="route-card-title">\${r.routeName}</span>
              <span class="badge badge-slot">\${r.categoryTag}</span>
            </div>
            <div style="color:#444;">👤 \${driverName} | 🚌 \${busNum}</div>
            <div style="color:#DD0000; font-weight:bold;">⏱️ \${r.checkInTime || 'N/A'}</div>
          \`;
          colEnRoute.appendChild(card);
        } else {
          cReturned++;
          card.innerHTML = \`
            <div style="display:flex; align-items:center; gap:5px; overflow:hidden;">
              <span class="route-card-title">\${r.routeName}</span>
              <span class="badge badge-slot">\${r.categoryTag}</span>
            </div>
            <div style="color:#444;">👤 \${driverName} | 🚌 \${busNum}</div>
            <div style="color:#2e7d32; font-weight:bold;">🏁 \${r.returnTime || 'N/A'}</div>
          \`;
          colReturned.appendChild(card);
        }
      });

      document.getElementById('countPending').innerText = cPending;
      document.getElementById('countEnRoute').innerText = cEnRoute;
      document.getElementById('countReturned').innerText = cReturned;
    }

    loadDashData();
    setInterval(loadDashData, 10000);
  </script>
</body>
</html>
  `);
});

// ================= DISPATCH KIOSK DASHBOARD PAGE =================
app.get('/dispatch', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Parkway Schools - Dispatch Kiosk</title>
  <style>
    ${COMMON_CSS}
    .toolbar { background: #fff; padding: 8px 20px; display: flex; gap: 15px; align-items: center; border-bottom: 1px solid #ccc; }
    .kiosk-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; padding: 10px; height: calc(100vh - 105px); box-sizing: border-box; }
    .column { background: #fff; border-radius: 4px; border-top: 4px solid #666; padding: 8px; display: flex; flex-direction: column; box-shadow: 0 1px 4px rgba(0,0,0,0.1); overflow-y: auto; }
    .column-pending { border-top-color: #FF9F3D; }
    .column-enroute { border-top-color: #DD0000; }
    .column-returned { border-top-color: #2e7d32; }
    .col-title { font-size: 13px; font-weight: bold; text-transform: uppercase; padding-bottom: 4px; margin-bottom: 6px; border-bottom: 2px solid #ddd; display: flex; justify-content: space-between; }
    
    .route-card {
      background: #fafafa;
      border: 1px solid #e0e0e0;
      border-left: 4px solid #666;
      padding: 6px 10px;
      margin-bottom: 5px;
      border-radius: 2px;
      font-size: 11px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      white-space: nowrap;
      gap: 6px;
    }
    .route-card-delayed { border: 1.5px solid #DD0000; border-left: 5px solid #DD0000; background: #fff0f0; }
    .route-card-title { font-weight: bold; font-size: 12px; color: #DD0000; }
    button, select { font-family: 'Trebuchet MS', sans-serif; font-size: 10px; padding: 3px 6px; font-weight: bold; border-radius: 2px; cursor: pointer; }
    .btn-checkin { background: #DD0000; color: #fff; border: none; }
    .btn-checkin:hover { background: #b30000; }
    .btn-undo { background: #666; color: #fff; border: none; }
    .btn-undo:hover { background: #444; }
    .badge { background: #eee; padding: 2px 5px; border-radius: 3px; font-size: 9px; font-weight: bold; }
    .badge-slot { background: #666; color: #fff; text-transform: uppercase; }
    .badge-delayed { background: #DD0000; color: #fff; }
  </style>
</head>
<body>
  ${renderHeader('dispatch', true)}

  <div class="toolbar">
    <label style="font-weight: bold; font-size: 12px;">Date: 
      <input type="date" id="kioskDate" onchange="loadKioskData()" style="padding:2px;" />
    </label>
    <label style="font-weight: bold; font-size: 12px;">Slot: 
      <select id="slotFilter" onchange="loadKioskData()">
        <option value="all">All Routes</option>
        <option value="amRoutes">AM Routes</option>
        <option value="pmRoutes">PM Routes</option>
        <option value="fieldTrips">Field Trips</option>
      </select>
    </label>
    <button onclick="loadKioskData()" class="btn-undo">🔄 Refresh</button>
  </div>

  <div class="kiosk-grid">
    <div class="column column-pending">
      <div class="col-title">1. Pending / Delayed <span id="countPending" class="badge">0</span></div>
      <div id="colPending"></div>
    </div>
    <div class="column column-enroute">
      <div class="col-title">2. En Route <span id="countEnRoute" class="badge">0</span></div>
      <div id="colEnRoute"></div>
    </div>
    <div class="column column-returned">
      <div class="col-title">3. Returned <span id="countReturned" class="badge">0</span></div>
      <div id="colReturned"></div>
    </div>
  </div>

  <script>
    document.getElementById('kioskDate').value = new Date().toISOString().split('T')[0];

    function toggleFullScreen() {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => alert(err.message));
      } else {
        if (document.exitFullscreen) document.exitFullscreen();
      }
    }

    async function loadKioskData() {
      const date = document.getElementById('kioskDate').value;
      const slot = document.getElementById('slotFilter').value;
      const res = await fetch('/api/schedule/' + date);
      const schedule = await res.json();

      let routes = [];
      if (slot === 'all') {
        const ams = (schedule.amRoutes || []).map(r => ({ ...r, categoryTag: 'AM' }));
        const pms = (schedule.pmRoutes || []).map(r => ({ ...r, categoryTag: 'PM' }));
        const trips = (schedule.fieldTrips || []).map(r => ({ ...r, categoryTag: 'Field Trip' }));
        routes = [...ams, ...pms, ...trips];
      } else {
        routes = (schedule[slot] || []).map(r => ({ 
          ...r, 
          categoryTag: slot === 'amRoutes' ? 'AM' : slot === 'pmRoutes' ? 'PM' : 'Field Trip' 
        }));
      }

      const colPending = document.getElementById('colPending');
      const colEnRoute = document.getElementById('colEnRoute');
      const colReturned = document.getElementById('colReturned');

      colPending.innerHTML = ''; colEnRoute.innerHTML = ''; colReturned.innerHTML = '';
      let cPending = 0, cEnRoute = 0, cReturned = 0;

      routes.forEach(r => {
        const driverName = r.driverId ? r.driverId.name : 'Unassigned';
        const busNum = r.busId ? ('Bus #' + r.busId.busNumber) : 'Unassigned';
        const card = document.createElement('div');
        
        const isDelayed = r.status === 'Delayed';
        card.className = 'route-card ' + (isDelayed ? 'route-card-delayed' : '');

        if (r.status === 'Pending' || isDelayed) {
          cPending++;
          card.innerHTML = \`
            <div style="display:flex; align-items:center; gap:5px; overflow:hidden;">
              <span class="route-card-title">\${r.routeName}</span>
              <span class="badge badge-slot">\${r.categoryTag}</span>
              \${isDelayed ? '<span class="badge badge-delayed">⚠️</span>' : ''}
            </div>
            <div style="color:#444; font-size:10px;">👤 \${driverName} | 🚌 \${busNum}</div>
            <button class="btn-checkin" onclick="updateStatus('\${r._id}', 'En Route')">Check In ➔</button>
          \`;
          colPending.appendChild(card);
        } else if (r.status === 'En Route') {
          cEnRoute++;
          card.innerHTML = \`
            <div style="display:flex; align-items:center; gap:5px; overflow:hidden;">
              <span class="route-card-title">\${r.routeName}</span>
              <span class="badge badge-slot">\${r.categoryTag}</span>
            </div>
            <div style="color:#444; font-size:10px;">👤 \${driverName} | 🚌 \${busNum}</div>
            <div style="display:flex; gap:3px; align-items:center;">
              <select onchange="if(this.value) updateStatus('\${r._id}', this.value)">
                <option value="">Return...</option>
                <option value="Returned - On Site">On Site</option>
                <option value="Returned - Left for the Day">Left Day</option>
              </select>
              <button class="btn-undo" onclick="updateStatus('\${r._id}', 'Pending')">Undo</button>
            </div>
          \`;
          colEnRoute.appendChild(card);
        } else {
          cReturned++;
          card.innerHTML = \`
            <div style="display:flex; align-items:center; gap:5px; overflow:hidden;">
              <span class="route-card-title">\${r.routeName}</span>
              <span class="badge badge-slot">\${r.categoryTag}</span>
            </div>
            <div style="color:#444; font-size:10px;">👤 \${driverName} | 🚌 \${busNum}</div>
            <button class="btn-undo" onclick="updateStatus('\${r._id}', 'En Route')">Undo</button>
          \`;
          colReturned.appendChild(card);
        }
      });

      document.getElementById('countPending').innerText = cPending;
      document.getElementById('countEnRoute').innerText = cEnRoute;
      document.getElementById('countReturned').innerText = cReturned;
    }

    async function updateStatus(routeId, status) {
      const date = document.getElementById('kioskDate').value;
      const category = document.getElementById('slotFilter').value;
      await fetch('/api/schedule/update-status', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ date, category, routeId, status })
      });
      loadKioskData();
    }

    loadKioskData();
    setInterval(loadKioskData, 30000);
  </script>
</body>
</html>
  `);
});

// ADMIN PORTAL PAGE
app.get('/admin', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Parkway Schools - Transportation Admin</title>
  <style>
    ${COMMON_CSS}
    .container { padding: 20px 30px; }
    h2 { color: #DD0000; font-size: 16px; text-transform: uppercase; border-bottom: 2px solid #666; padding-bottom: 4px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
    .card { background: #fff; padding: 18px; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); border-top: 3px solid #666; }
    form { display: flex; flex-direction: column; gap: 10px; margin-bottom: 10px; }
    input, select, button { padding: 8px 12px; border: 1px solid #666; font-family: 'Trebuchet MS', sans-serif; }
    button { background: #DD0000; color: #fff; font-weight: bold; border: none; cursor: pointer; text-transform: uppercase; }
    button:hover { background: #b30000; }
    .btn-secondary { background: #666; }
    .btn-action { padding: 3px 6px; font-size: 11px; font-weight: normal; margin-left: 4px; }
    .btn-edit { background: #666; }
    .btn-delete { background: #DD0000; }
    .route-group { background: #fafafa; border: 1px solid #ddd; padding: 12px; margin-bottom: 10px; }
    .upload-box { background: #fdfdfd; border: 1px dashed #666; padding: 10px; margin-top: 10px; font-size: 12px; }
    
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; z-index: 1000; }
    .modal-content { background: #fff; padding: 20px; border-top: 4px solid #DD0000; border-radius: 4px; width: 350px; }
  </style>
</head>
<body>
  ${renderHeader('admin', false)}

  <div class="container">
    <div class="grid">
      <div class="card">
        <h2>Drivers</h2>
        <form id="driverForm">
          <input type="text" id="dName" placeholder="Full Name" required />
          <input type="text" id="dStaffId" placeholder="Staff ID" required />
          <input type="text" id="dPhone" placeholder="Phone Number" required />
          <button type="submit">Add Driver</button>
        </form>

        <div class="upload-box">
          <b>📁 Batch Upload Drivers (CSV):</b><br/>
          <a href="/api/samples/drivers" style="color:#DD0000; font-weight:bold;">⬇️ Download Sample CSV</a>
          <input type="file" id="driverCsv" accept=".csv" style="margin-top:6px;" />
          <button type="button" onclick="uploadCsv('/api/upload/drivers', 'driverCsv')">Upload Drivers CSV</button>
        </div>

        <ul id="driverList" style="margin-top:15px; padding-left:0; list-style:none;"></ul>
      </div>

      <div class="card">
        <h2>Buses</h2>
        <form id="busForm">
          <input type="text" id="bNumber" placeholder="Bus Number" required />
          <label><input type="checkbox" id="bSpare" /> Is Spare Bus</label>
          <button type="submit">Add Bus</button>
        </form>

        <div class="upload-box">
          <b>📁 Batch Upload Buses (CSV):</b><br/>
          <a href="/api/samples/buses" style="color:#DD0000; font-weight:bold;">⬇️ Download Sample CSV</a>
          <input type="file" id="busCsv" accept=".csv" style="margin-top:6px;" />
          <button type="button" onclick="uploadCsv('/api/upload/buses', 'busCsv')">Upload Buses CSV</button>
        </div>

        <ul id="busList" style="margin-top:15px; padding-left:0; list-style:none;"></ul>
      </div>

      <div class="card">
        <h2>Mechanics</h2>
        <form id="mechForm">
          <input type="text" id="mName" placeholder="Full Name" required />
          <input type="text" id="mPhone" placeholder="Phone Number" required />
          <button type="submit">Add Mechanic</button>
        </form>

        <div class="upload-box">
          <b>📁 Batch Upload Mechanics (CSV):</b><br/>
          <a href="/api/samples/mechanics" style="color:#DD0000; font-weight:bold;">⬇️ Download Sample CSV</a>
          <input type="file" id="mechCsv" accept=".csv" style="margin-top:6px;" />
          <button type="button" onclick="uploadCsv('/api/upload/mechanics', 'mechCsv')">Upload Mechanics CSV</button>
        </div>

        <ul id="mechList" style="margin-top:15px; padding-left:0; list-style:none;"></ul>
      </div>
    </div>

    <div class="card" style="margin-top: 25px; border-top-color: #DD0000;">
      <h2>Daily Route Schedule Builder</h2>
      
      <div class="upload-box" style="margin-bottom: 20px;">
        <b>📁 Batch Upload Daily Schedules (CSV):</b><br/>
        <a href="/api/samples/schedule" style="color:#DD0000; font-weight:bold;">⬇️ Download Sample Schedule CSV</a>
        <input type="file" id="scheduleCsv" accept=".csv" style="margin-top:6px;" />
        <button type="button" onclick="uploadCsv('/api/upload/schedule', 'scheduleCsv')">Upload Schedule CSV</button>
      </div>

      <div style="display: flex; gap: 15px; align-items: center; margin-bottom: 20px;">
        <label style="font-weight: bold;">Date: <input type="date" id="scheduleDate" /></label>
        <button onclick="loadSchedule()">Load Date</button>
        <button onclick="copyForward()" class="btn-secondary">📋 Copy Previous Day Route</button>
      </div>

      <div class="grid">
        <div class="route-group">
          <h3>AM Routes</h3>
          <div id="amContainer"></div>
          <button onclick="addRouteRow('amContainer')" style="margin-top:8px;">+ Add AM Route</button>
        </div>

        <div class="route-group">
          <h3>PM Routes</h3>
          <div id="pmContainer"></div>
          <button onclick="addRouteRow('pmContainer')" style="margin-top:8px;">+ Add PM Route</button>
        </div>

        <div class="route-group">
          <h3>Field Trips</h3>
          <div id="tripContainer"></div>
          <button onclick="addRouteRow('tripContainer')" style="margin-top:8px;">+ Add Field Trip</button>
        </div>
      </div>

      <br />
      <button onclick="saveSchedule()" style="padding: 12px 24px;">💾 Save Daily Schedule</button>
    </div>
  </div>

  <div id="editModal" class="modal-overlay">
    <div class="modal-content">
      <h3 id="modalTitle" style="margin-top:0; color:#DD0000;">Edit Record</h3>
      <form id="editForm">
        <div id="modalFields"></div>
        <div style="display:flex; gap:10px; margin-top:10px;">
          <button type="submit" style="flex:1;">Save Changes</button>
          <button type="button" onclick="closeModal()" class="btn-secondary" style="flex:1;">Cancel</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    let drivers = [], buses = [], mechanics = [];
    let currentEditType = null, currentEditId = null;

    document.getElementById('scheduleDate').value = new Date().toISOString().split('T')[0];

    async function fetchData() {
      drivers = await (await fetch('/api/drivers')).json();
      buses = await (await fetch('/api/buses')).json();
      mechanics = await (await fetch('/api/mechanics')).json();

      document.getElementById('driverList').innerHTML = drivers.map(d => \`
        <li style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding:6px 0; font-size:12px;">
          <span><b>\${d.name}</b> (\${d.staffId}) - \${d.phoneNumber}</span>
          <div>
            <button class="btn-action btn-edit" onclick="openEdit('driver', '\${d._id}')">✏️ Edit</button>
            <button class="btn-action btn-delete" onclick="deleteItem('driver', '\${d._id}')">🗑️ Delete</button>
          </div>
        </li>
      \`).join('');

      document.getElementById('busList').innerHTML = buses.map(b => \`
        <li style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding:6px 0; font-size:12px;">
          <span><b>Bus #\${b.busNumber}</b> \${b.isSpare ? '(Spare)' : ''} \${b.status === 'In Shop' ? '<b style="color:#DD0000;">[IN SHOP]</b>' : ''}</span>
          <div>
            <button class="btn-action btn-edit" onclick="openEdit('bus', '\${b._id}')">✏️ Edit</button>
            <button class="btn-action btn-delete" onclick="deleteItem('bus', '\${b._id}')">🗑️ Delete</button>
          </div>
        </li>
      \`).join('');

      document.getElementById('mechList').innerHTML = mechanics.map(m => \`
        <li style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding:6px 0; font-size:12px;">
          <span><b>\${m.name}</b> - \${m.phoneNumber}</span>
          <div>
            <button class="btn-action btn-edit" onclick="openEdit('mechanic', '\${m._id}')">✏️ Edit</button>
            <button class="btn-action btn-delete" onclick="deleteItem('mechanic', '\${m._id}')">🗑️ Delete</button>
          </div>
        </li>
      \`).join('');

      loadSchedule();
    }

    async function deleteItem(type, id) {
      if (!confirm(\`Are you sure you want to delete this \${type}?\`)) return;

      const endpoint = type === 'driver' ? '/api/drivers/' : type === 'bus' ? '/api/buses/' : '/api/mechanics/';
      
      let res = await fetch(endpoint + id, { method: 'DELETE' });
      let data = await res.json();

      if (!res.ok && data.hasConflict) {
        const forceDelete = confirm(\`\${data.error}\\n\\nDo you want to FORCE DELETE anyway?\`);
        if (forceDelete) {
          res = await fetch(\`\${endpoint}\${id}?force=true\`, { method: 'DELETE' });
          data = await res.json();
          if (res.ok) {
            alert(\`\${type.toUpperCase()} force deleted and unassigned from future schedules.\`);
            fetchData();
          } else {
            alert('Error: ' + data.error);
          }
        }
      } else if (res.ok) {
        fetchData();
      } else {
        alert('Error: ' + data.error);
      }
    }

    function openEdit(type, id) {
      currentEditType = type;
      currentEditId = id;
      const modalFields = document.getElementById('modalFields');

      if (type === 'driver') {
        const item = drivers.find(d => d._id === id);
        document.getElementById('modalTitle').innerText = 'Edit Driver';
        modalFields.innerHTML = \`
          <input type="text" id="mDName" value="\${item.name}" placeholder="Name" required style="width:100%; margin-bottom:8px;" />
          <input type="text" id="mDStaffId" value="\${item.staffId}" placeholder="Staff ID" required style="width:100%; margin-bottom:8px;" />
          <input type="text" id="mDPhone" value="\${item.phoneNumber}" placeholder="Phone" required style="width:100%; margin-bottom:8px;" />
        \`;
      } else if (type === 'bus') {
        const item = buses.find(b => b._id === id);
        document.getElementById('modalTitle').innerText = 'Edit Bus';
        modalFields.innerHTML = \`
          <input type="text" id="mBNumber" value="\${item.busNumber}" placeholder="Bus Number" required style="width:100%; margin-bottom:8px;" />
          <label style="font-size:12px;"><input type="checkbox" id="mBSpare" \${item.isSpare ? 'checked' : ''} /> Is Spare Bus</label>
        \`;
      } else if (type === 'mechanic') {
        const item = mechanics.find(m => m._id === id);
        document.getElementById('modalTitle').innerText = 'Edit Mechanic';
        modalFields.innerHTML = \`
          <input type="text" id="mMName" value="\${item.name}" placeholder="Name" required style="width:100%; margin-bottom:8px;" />
          <input type="text" id="mMPhone" value="\${item.phoneNumber}" placeholder="Phone" required style="width:100%; margin-bottom:8px;" />
        \`;
      }

      document.getElementById('editModal').style.display = 'flex';
    }

    function closeModal() {
      document.getElementById('editModal').style.display = 'none';
    }

    document.getElementById('editForm').onsubmit = async (e) => {
      e.preventDefault();
      let payload = {};
      let endpoint = '';

      if (currentEditType === 'driver') {
        endpoint = '/api/drivers/' + currentEditId;
        payload = {
          name: document.getElementById('mDName').value,
          staffId: document.getElementById('mDStaffId').value,
          phoneNumber: document.getElementById('mDPhone').value
        };
      } else if (currentEditType === 'bus') {
        endpoint = '/api/buses/' + currentEditId;
        payload = {
          busNumber: document.getElementById('mBNumber').value,
          isSpare: document.getElementById('mBSpare').checked
        };
      } else if (currentEditType === 'mechanic') {
        endpoint = '/api/mechanics/' + currentEditId;
        payload = {
          name: document.getElementById('mMName').value,
          phoneNumber: document.getElementById('mMPhone').value
        };
      }

      await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      closeModal();
      fetchData();
    };

    async function uploadCsv(endpoint, inputId) {
      const fileInput = document.getElementById(inputId);
      if (!fileInput.files[0]) {
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
        fetchData();
      } else {
        alert('Error: ' + data.error);
      }
    }

    document.getElementById('driverForm').onsubmit = async (e) => {
      e.preventDefault();
      await fetch('/api/drivers', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          name: document.getElementById('dName').value,
          staffId: document.getElementById('dStaffId').value,
          phoneNumber: document.getElementById('dPhone').value
        })
      });
      e.target.reset();
      fetchData();
    };

    document.getElementById('busForm').onsubmit = async (e) => {
      e.preventDefault();
      await fetch('/api/buses', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          busNumber: document.getElementById('bNumber').value,
          isSpare: document.getElementById('bSpare').checked
        })
      });
      e.target.reset();
      fetchData();
    };

    document.getElementById('mechForm').onsubmit = async (e) => {
      e.preventDefault();
      await fetch('/api/mechanics', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          name: document.getElementById('mName').value,
          phoneNumber: document.getElementById('mPhone').value
        })
      });
      e.target.reset();
      fetchData();
    };

    function addRouteRow(containerId, data = {}) {
      const div = document.createElement('div');
      div.style.display = 'flex';
      div.style.gap = '5px';
      div.style.marginBottom = '6px';

      div.innerHTML = \`
        <input type="text" placeholder="Route No." value="\${data.routeName || ''}" style="width: 25%;" class="r-name" />
        <input type="time" value="\${data.scheduledTime || '07:00'}" style="width: 20%;" class="r-time" />
        <select class="r-driver" style="width: 25%;" onchange="updateOptions('\${containerId}')">
          <option value="">Select Driver</option>
        </select>
        <select class="r-bus" style="width: 25%;" onchange="updateOptions('\${containerId}')">
          <option value="">Select Bus</option>
        </select>
        <button onclick="this.parentElement.remove(); updateOptions('\${containerId}');" style="background:#666;">X</button>
      \`;
      document.getElementById(containerId).appendChild(div);

      updateOptions(containerId, data.driverId?._id || data.driverId, data.busId?._id || data.busId);
    }

    function updateOptions(containerId, initialDriverId, initialBusId) {
      const container = document.getElementById(containerId);
      const rows = Array.from(container.children);

      const selectedDrivers = new Set();
      const selectedBuses = new Set();

      rows.forEach(row => {
        const dVal = row.querySelector('.r-driver').value;
        const bVal = row.querySelector('.r-bus').value;
        if (dVal) selectedDrivers.add(dVal);
        if (bVal) selectedBuses.add(bVal);
      });

      const availableBuses = buses.filter(b => b.status !== 'In Shop');

      rows.forEach(row => {
        const driverSelect = row.querySelector('.r-driver');
        const busSelect = row.querySelector('.r-bus');

        const currentDriver = initialDriverId || driverSelect.value;
        const currentBus = initialBusId || busSelect.value;

        driverSelect.innerHTML = '<option value="">Select Driver</option>' + 
          drivers.map(d => {
            const isTaken = selectedDrivers.has(d._id) && d._id !== currentDriver;
            return isTaken ? '' : \`<option value="\${d._id}" \${currentDriver == d._id ? 'selected' : ''}>\${d.name}</option>\`;
          }).join('');

        busSelect.innerHTML = '<option value="">Select Bus</option>' + 
          availableBuses.map(b => {
            const isTaken = selectedBuses.has(b._id) && b._id !== currentBus;
            return isTaken ? '' : \`<option value="\${b._id}" \${currentBus == b._id ? 'selected' : ''}>Bus \${b.busNumber}\${b.isSpare ? ' (Spare)' : ''}</option>\`;
          }).join('');
      });

      initialDriverId = null;
      initialBusId = null;
    }

    async function loadSchedule() {
      const date = document.getElementById('scheduleDate').value;
      const res = await fetch('/api/schedule/' + date);
      const data = await res.json();

      ['amContainer', 'pmContainer', 'tripContainer'].forEach(id => document.getElementById(id).innerHTML = '');

      (data.amRoutes || []).forEach(r => addRouteRow('amContainer', r));
      (data.pmRoutes || []).forEach(r => addRouteRow('pmContainer', r));
      (data.fieldTrips || []).forEach(r => addRouteRow('tripContainer', r));
    }

    function extractRoutes(containerId) {
      const rows = document.getElementById(containerId).children;
      const routes = [];
      for (let row of rows) {
        const routeName = row.querySelector('.r-name').value;
        const scheduledTime = row.querySelector('.r-time').value;
        const driverId = row.querySelector('.r-driver').value;
        const busId = row.querySelector('.r-bus').value;
        if (routeName) {
          routes.push({ routeName, scheduledTime, driverId: driverId || null, busId: busId || null });
        }
      }
      return routes;
    }

    async function saveSchedule() {
      const date = document.getElementById('scheduleDate').value;
      const payload = {
        date,
        amRoutes: extractRoutes('amContainer'),
        pmRoutes: extractRoutes('pmContainer'),
        fieldTrips: extractRoutes('tripContainer')
      };

      const res = await fetch('/api/schedule', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ date, ...payload })
      });

      if (res.ok) {
        alert('Schedule saved successfully!');
      } else {
        const err = await res.json();
        alert('Error: ' + err.error);
      }
    }

    async function copyForward() {
      const targetDate = document.getElementById('scheduleDate').value;
      const res = await fetch('/api/schedule/copy-forward', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ targetDate })
      });

      if (res.ok) {
        alert('Copied previous day schedule!');
        loadSchedule();
      } else {
        const err = await res.json();
        alert(err.error);
      }
    }

    fetchData();
  </script>
</body>
</html>
  `);
});

// ================= MECHANICS PORTAL =================
app.get('/mechanics', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Parkway Schools - Shop & Fleet Status</title>
  <style>
    ${COMMON_CSS}
    .container { padding: 20px 30px; }
    h2 { color: #DD0000; font-size: 16px; text-transform: uppercase; border-bottom: 2px solid #666; padding-bottom: 4px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; }
    .card { background: #fff; padding: 18px; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); border-top: 3px solid #666; }
    .card-in-shop { border-top-color: #DD0000; background: #fff8f8; }
    .status-badge { display: inline-block; padding: 3px 8px; font-size: 11px; font-weight: bold; border-radius: 3px; color: #fff; }
    .badge-available { background: #2e7d32; }
    .badge-shop { background: #DD0000; }
    form { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
    input, select, button { padding: 8px 10px; border: 1px solid #666; font-family: 'Trebuchet MS', sans-serif; font-size: 13px; }
    button { background: #DD0000; color: #fff; font-weight: bold; border: none; cursor: pointer; text-transform: uppercase; }
    button:hover { background: #b30000; }
  </style>
</head>
<body>
  ${renderHeader('mechanics', false)}

  <div class="container">
    <h2>🛠️ Fleet Maintenance & Shop Portal</h2>
    <div id="busGrid" class="grid"></div>
  </div>

  <script>
    async function loadBuses() {
      const buses = await (await fetch('/api/buses')).json();
      const grid = document.getElementById('busGrid');
      grid.innerHTML = '';

      buses.forEach(b => {
        const inShop = b.status === 'In Shop';
        const card = document.createElement('div');
        card.className = 'card ' + (inShop ? 'card-in-shop' : '');

        card.innerHTML = \`
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <h3 style="margin:0; font-size:18px;">Bus #\${b.busNumber} \${b.isSpare ? '(Spare)' : ''}</h3>
            <span class="status-badge \${inShop ? 'badge-shop' : 'badge-available'}">\${b.status}</span>
          </div>

          <form onsubmit="saveBusStatus(event, '\${b._id}')">
            <label style="font-size:12px; font-weight:bold;">Status:</label>
            <select class="b-status" onchange="toggleShopFields(this)">
              <option value="Available" \${!inShop ? 'selected' : ''}>Available</option>
              <option value="In Shop" \${inShop ? 'selected' : ''}>In Shop</option>
            </select>

            <div class="shop-fields" style="display: \${inShop ? 'flex' : 'none'}; flex-direction:column; gap:8px;">
              <input type="text" class="b-reason" placeholder="Reason (e.g. Brakes, Oil Change)" value="\${b.offlineReason || ''}" />
              <label style="font-size:11px; font-weight:bold;">Expected Return Date:
                <input type="date" class="b-return" value="\${b.expectedReturnDate || ''}" />
              </label>
            </div>

            <button type="submit" style="margin-top:6px;">Update Bus</button>
          </form>
        \`;
        grid.appendChild(card);
      });
    }

    function toggleShopFields(selectEl) {
      const fields = selectEl.parentElement.querySelector('.shop-fields');
      fields.style.display = selectEl.value === 'In Shop' ? 'flex' : 'none';
    }

    async function saveBusStatus(e, busId) {
      e.preventDefault();
      const form = e.target;
      const status = form.querySelector('.b-status').value;
      const offlineReason = form.querySelector('.b-reason').value;
      const expectedReturnDate = form.querySelector('.b-return').value;

      await fetch('/api/buses/update-status', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ busId, status, offlineReason, expectedReturnDate })
      });

      alert('Bus status updated!');
      loadBuses();
    }

    loadBuses();
  </script>
</body>
</html>
  `);
});

app.get('/', (req, res) => res.redirect('/dashboard'));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
