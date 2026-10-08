require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: 'uploads/' });

process.env.TZ = 'America/Chicago';

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ================= SESSION & PASSPORT CONFIGURATION =================
app.use(session({
  secret: process.env.SESSION_SECRET || 'parkway_transportation_secure_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

async function getGoogleDirectoryProfile(email) {
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '';
  privateKey = privateKey.replace(/^"|"$/g, '').replace(/\\n/g, '\n');
  const adminEmail = process.env.GOOGLE_ADMIN_EMAIL;

  if (!serviceAccountEmail || !privateKey || !adminEmail) {
    return { orgUnitPath: '/parkwayschools.net/Staff', jobTitle: 'Staff Member' };
  }

  try {
    const auth = new google.auth.JWT({
      email: serviceAccountEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
      subject: adminEmail
    });

    await auth.authorize();
    const service = google.admin({ version: 'directory_v1', auth });
    const res = await service.users.get({ userKey: email });

    const user = res.data;
    const orgUnitPath = user.orgUnitPath || '';
    const jobTitle = user.organizations && user.organizations[0] ? user.organizations[0].title : '';

    return { orgUnitPath, jobTitle };
  } catch (err) {
    console.error('[DIRECTORY API ERROR]:', err.message);
    return { orgUnitPath: '/parkwayschools.net/Staff', jobTitle: 'Staff Member' };
  }
}

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'DUMMY_CLIENT_ID',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'DUMMY_CLIENT_SECRET',
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/api/auth/callback/google'
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails && profile.emails[0] ? profile.emails[0].value : '';
      const allowedDomain = process.env.ALLOWED_DOMAIN || 'parkwayschools.net';

      if (!email.toLowerCase().endsWith(`@${allowedDomain.toLowerCase()}`)) {
        return done(null, false, { message: `Unauthorized domain. Must end with @${allowedDomain}` });
      }

      const directoryInfo = await getGoogleDirectoryProfile(email);

      const user = {
        id: profile.id,
        name: profile.displayName,
        email,
        photo: profile.photos && profile.photos[0] ? profile.photos[0].value : '',
        orgUnitPath: directoryInfo.orgUnitPath,
        jobTitle: directoryInfo.jobTitle
      };

      return done(null, user);
    } catch (err) {
      return done(err, null);
    }
  }
));

async function getUserRoles(user) {
  if (!user || !user.email) {
    return { isAdmin: false, isDriver: false, isMechanic: false };
  }

  const email = user.email.toLowerCase();
  const envAdmins = (process.env.APP_ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  const isAdminEnv = envAdmins.includes(email);
  const dbAdmin = await AdminWhitelist.findOne({ email });
  const isAdmin = isAdminEnv || Boolean(dbAdmin);

  const isDriver = Boolean(await Driver.findOne({ email }));
  const isMechanic = Boolean(await Mechanic.findOne({ email }));

  return { isAdmin, isDriver, isMechanic };
}

function getObjIdStr(val) {
  if (!val) return '';
  if (typeof val === 'object' && val._id) return String(val._id);
  return String(val);
}

function requireStaffView(allowedOUs = ['/parkwayschools.net/Staff']) {
  return async (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return next();
    if (!req.isAuthenticated || !req.isAuthenticated()) return res.redirect('/login');

    const user = req.user;
    const userEmail = (user && user.email ? user.email : '').toLowerCase();

    try {
      const envAdmins = (process.env.APP_ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
      if (envAdmins.includes(userEmail)) return next();

      const dbAdmin = await AdminWhitelist.findOne({ email: userEmail });
      if (dbAdmin) return next();

      const driver = await Driver.findOne({ email: userEmail });
      if (driver) return next();

      const mechanic = await Mechanic.findOne({ email: userEmail });
      if (mechanic) return next();
    } catch (err) {
      console.error('Error checking staff view access:', err.message);
    }

    const userOU = (user.orgUnitPath || '').toUpperCase();
    const matchesOU = allowedOUs.some(targetOU => {
      const formatted = targetOU.toUpperCase();
      return userOU.includes(formatted) || userOU.startsWith(formatted);
    });

    if (matchesOU) return next();

    res.status(403).send(`Access Denied: Must be in /parkwayschools.net/Staff or an authorized role.`);
  };
}

function requireAdminAccess() {
  return async (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return next();
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.status(401).json({ error: 'Unauthenticated. Please log in.' });
    }

    const userEmail = (req.user && req.user.email ? req.user.email : '').toLowerCase();

    try {
      const envAdmins = (process.env.APP_ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
      if (envAdmins.includes(userEmail)) return next();

      const dbAdmin = await AdminWhitelist.findOne({ email: userEmail });
      if (dbAdmin) return next();
    } catch (err) {
      console.error('Error verifying admin access:', err.message);
    }

    res.status(403).json({ error: '403 Access Denied. Admin privileges required.' });
  };
}

function requireDriverOrAdmin() {
  return async (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return next();
    if (!req.isAuthenticated || !req.isAuthenticated()) return res.redirect('/login');

    const userEmail = (req.user && req.user.email ? req.user.email : '').toLowerCase();

    try {
      const envAdmins = (process.env.APP_ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
      if (envAdmins.includes(userEmail)) return next();

      const dbAdmin = await AdminWhitelist.findOne({ email: userEmail });
      if (dbAdmin) return next();

      const driver = await Driver.findOne({ email: userEmail });
      if (driver) return next();
    } catch (err) {
      console.error('Error verifying driver access:', err.message);
    }

    res.status(403).send(`Access Denied: Registered Driver or Admin required.`);
  };
}

function requireMechanicOrAdmin() {
  return async (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return next();
    if (!req.isAuthenticated || !req.isAuthenticated()) return res.redirect('/login');

    const userEmail = (req.user && req.user.email ? req.user.email : '').toLowerCase();

    try {
      const envAdmins = (process.env.APP_ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
      if (envAdmins.includes(userEmail)) return next();

      const dbAdmin = await AdminWhitelist.findOne({ email: userEmail });
      if (dbAdmin) return next();

      const mechanic = await Mechanic.findOne({ email: userEmail });
      if (mechanic) return next();
    } catch (err) {
      console.error('Error verifying mechanic access:', err.message);
    }

    res.status(403).send(`Access Denied: Registered Mechanic or Admin required.`);
  };
}

// ================= DATABASE CONNECTION =================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/myappdb';

const connectWithRetry = () => {
  console.log('Connecting to MongoDB...');
  mongoose.connect(MONGO_URI)
    .then(() => {
      console.log('[MONGO] Connected successfully to Atlas');
      if (typeof startGoogleSheetPoller === 'function') {
        startGoogleSheetPoller();
        console.log('[POLLER] Google Sheet poller started.');
      }
      if (typeof startDelayedRouteScanner === 'function') {
        startDelayedRouteScanner();
      }
    })
    .catch(err => {
      console.error('[MONGO ERROR]:', err.message);
    });
};

connectWithRetry();

// ================= DATE & TIME HELPER FUNCTIONS =================

function normalizeDateStr(dateStr) {
  if (!dateStr) return '';
  const trimmed = dateStr.toString().trim().replace(/^"|"$/g, '');
  
  if (trimmed.includes('-')) {
    const parts = trimmed.split('-');
    if (parts.length === 3) {
      let year = parts[0];
      if (year.length === 2) year = '20' + year;
      const month = parts[1].padStart(2, '0');
      const day = parts[2].padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }

  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    if (parts.length === 3) {
      const month = parts[0].padStart(2, '0');
      const day = parts[1].padStart(2, '0');
      let year = parts[2];
      if (year.length === 2) year = '20' + year;
      return `${year}-${month}-${day}`;
    }
  }

  return trimmed;
}

function getCentralTimeStr() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

function formatTo12Hour(time24) {
  if (!time24) return '';
  if (time24.includes('AM') || time24.includes('PM')) return time24;
  const parts = time24.split(':');
  if (parts.length < 2) return time24;
  let hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  if (isNaN(hours) || isNaN(minutes)) return time24;
  const period = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  const minStr = minutes < 10 ? '0' + minutes : minutes;
  return `${hours}:${minStr} ${period}`;
}

function parse12HourTo24Hour(timeStr) {
  if (!timeStr) return '07:00';
  const trimmed = timeStr.toString().trim();
  if (!trimmed) return '07:00';

  const match = trimmed.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return '07:00';

  let hours = parseInt(match[1], 10);
  const minutes = match[2];
  const period = match[3] ? match[3].toUpperCase() : null;

  if (period === 'PM' && hours < 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;

  const hhStr = hours < 10 ? '0' + hours : '' + hours;
  return `${hhStr}:${minutes}`;
}

// ================= SCHEMAS =================
const AdminWhitelist = mongoose.model('AdminWhitelist', new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  addedBy: { type: String, default: 'System' },
  addedAt: { type: Date, default: Date.now }
}));

const Driver = mongoose.model('Driver', new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true }
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
  email: { type: String, required: true, unique: true, lowercase: true, trim: true }
}));

const RouteEntrySchema = new mongoose.Schema({
  routeName: String,
  scheduledTime: { type: String, default: '07:00' },
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
  busId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus' },
  startMileage: { type: Number, default: 0 },
  endMileage: { type: Number, default: 0 },
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

const FieldTripAuditSchema = new mongoose.Schema({
  date: { type: String, required: true },
  tripType: { type: String, default: 'Athletic' },
  school: String,
  classTeam: String,
  destination: String,
  pickupTime: String,
  dropOffTime: String,
  numBuses: { type: Number, default: 1 },
  
  busAssignments: [{
    busId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus', default: null },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', default: null },
    startHours: { type: Number, default: 0 },
    endHours: { type: Number, default: 0 },
    startMiles: { type: Number, default: 0 },
    endMiles: { type: Number, default: 0 },
    totalHours: { type: Number, default: 0 },
    totalMiles: { type: Number, default: 0 },
    charge: { type: Number, default: 0 }
  }],

  requestedBy: { type: String, default: '' },
  approverName: { type: String, default: '' },
  notes: String,
  coachCommLine: String,
  accountCode: String,
  ratePerHour: { type: Number, default: 25.00 },
  ratePerMile: { type: Number, default: 2.50 },
  
  totalHours: { type: Number, default: 0 },
  totalMiles: { type: Number, default: 0 },
  charge: { type: Number, default: 0 },

  accountCodeCheck: { type: String, enum: ['Pending', 'Verified', 'Flagged'], default: 'Pending' }
});

FieldTripAuditSchema.pre('save', function(next) {
  this.date = normalizeDateStr(this.date);
  const hourlyRate = this.ratePerHour !== undefined ? this.ratePerHour : 25.00;
  const mileageRate = this.ratePerMile !== undefined ? this.ratePerMile : 2.50;

  let grandHours = 0;
  let grandMiles = 0;
  let grandCharge = 0;

  (this.busAssignments || []).forEach(b => {
    b.totalHours = Math.max(0, (b.endHours || 0) - (b.startHours || 0));
    b.totalMiles = Math.max(0, (b.endMiles || 0) - (b.startMiles || 0));
    b.charge = (b.totalHours * hourlyRate) + (b.totalMiles * mileageRate);

    grandHours += b.totalHours;
    grandMiles += b.totalMiles;
    grandCharge += b.charge;
  });

  this.totalHours = grandHours;
  this.totalMiles = grandMiles;
  this.charge = grandCharge;

  next();
});

const FieldTripAudit = mongoose.model('FieldTripAudit', FieldTripAuditSchema);

const SystemSetting = mongoose.model('SystemSetting', new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: mongoose.Schema.Types.Mixed
}));

async function syncFieldTripToDailySchedule(trip) {
  if (!trip || !trip.date) return;

  const isNotFlagged = trip.accountCodeCheck !== 'Flagged';
  const hasTime = Boolean(trip.pickupTime && trip.pickupTime.trim());
  const hasAssignments = Array.isArray(trip.busAssignments) && trip.busAssignments.some(b => b.busId || b.driverId);
  const isApproved = trip.accountCodeCheck === 'Verified';

  const isSchedulable = isNotFlagged && hasTime && (isApproved || hasAssignments);

  const scheduleDate = normalizeDateStr(trip.date);
  const baseRouteName = `${trip.school || 'Field Trip'} - ${trip.destination || 'Event'}`.trim();
  const scheduledTime = parse12HourTo24Hour(trip.pickupTime);

  let schedule = await DailySchedule.findOne({ date: scheduleDate });
  if (!schedule) {
    schedule = new DailySchedule({ date: scheduleDate, amRoutes: [], pmRoutes: [], fieldTrips: [] });
  }

  const existingRouteMap = new Map();
  (schedule.fieldTrips || []).forEach(r => {
    if (r.routeName.toLowerCase().startsWith(baseRouteName.toLowerCase())) {
      existingRouteMap.set(r.routeName.toLowerCase(), {
        status: r.status,
        checkInTime: r.checkInTime,
        returnTime: r.returnTime
      });
    }
  });

  schedule.fieldTrips = schedule.fieldTrips.filter(r => 
    !r.routeName.toLowerCase().startsWith(baseRouteName.toLowerCase())
  );

  if (isSchedulable) {
    const numBusesNeeded = Math.max(1, trip.numBuses || 1);
    const assignments = trip.busAssignments || [];

    for (let i = 0; i < numBusesNeeded; i++) {
      const busTag = numBusesNeeded > 1 ? ` (Bus ${i + 1})` : '';
      const routeName = `${baseRouteName}${busTag}`;
      const pair = assignments[i] || {};

      const busId = getObjIdStr(pair.busId) || null;
      const driverId = getObjIdStr(pair.driverId) || null;

      const savedState = existingRouteMap.get(routeName.toLowerCase()) || {};

      schedule.fieldTrips.push({
        routeName,
        scheduledTime,
        driverId,
        busId,
        status: savedState.status || 'Pending',
        checkInTime: savedState.checkInTime || null,
        returnTime: savedState.returnTime || null
      });
    }

    await schedule.save();
  } else {
    await schedule.save();
  }
}

function sanitizeBusAssignments(assignments) {
  if (!Array.isArray(assignments)) return [];
  return assignments.map(b => ({
    busId: (b.busId && mongoose.Types.ObjectId.isValid(b.busId)) ? b.busId : null,
    driverId: (b.driverId && mongoose.Types.ObjectId.isValid(b.driverId)) ? b.driverId : null,
    startHours: parseFloat(b.startHours) || 0,
    endHours: parseFloat(b.endHours) || 0,
    startMiles: parseFloat(b.startMiles) || 0,
    endMiles: parseFloat(b.endMiles) || 0
  }));
}

function startDelayedRouteScanner() {
  setInterval(async () => {
    if (mongoose.connection.readyState !== 1) return;

    try {
      const options = { timeZone: 'America/Chicago' };
      const todayStr = new Date().toLocaleDateString('en-CA', options);
      const now = new Date();
      
      const centralNow = new Date(now.toLocaleString('en-US', options));
      const currentMinutes = centralNow.getHours() * 60 + centralNow.getMinutes();

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

async function executeSheetSync(sheetUrlOrId, rangeName = null) {
  const match = sheetUrlOrId.match(/\/d\/([a-zA-Z0-9-_]+)/);
  const spreadsheetId = match ? match[1] : sheetUrlOrId.trim();

  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '';
  privateKey = privateKey.replace(/^"|"$/g, '').replace(/\\n/g, '\n');

  if (!serviceAccountEmail || !privateKey) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is missing from .env');
  }

  const auth = new google.auth.JWT({
    email: serviceAccountEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });

  await auth.authorize();
  const sheets = google.sheets({ version: 'v4', auth });

  let targetTab = rangeName;
  if (!targetTab) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    targetTab = meta.data.sheets[0].properties.title;
  }

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${targetTab}'!A1:Z5000`
  });

  const rows = response.data.values;
  if (!rows || rows.length < 2) {
    return { count: 0, tab: targetTab };
  }

  const headers = rows[0].map(h => h.trim());
  const getColIdx = (name) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());

  const idxDate = getColIdx('Date of Trip');
  const idxSchool = getColIdx('Primary School Requesting');
  const idxGroup = getColIdx('Grade or Group Taking Trip');
  const idxType = getColIdx('Fieldtrip Type');
  const idxDestName = getColIdx('Destination Name');
  const idxDestAddr = getColIdx('Destination Address');
  const idxPickup = getColIdx('Pickup Time at School');
  const idxReturn = getColIdx('Return Time');
  const idxBuses = getColIdx('Number of Buses');
  const idxApplicant = getColIdx('Applicant Name');
  const idxApprover = getColIdx('Name of Approving Principal or Director');
  const idxNotes = getColIdx('Special Instructions/ Miscellaneous Info');
  const idxAccount = getColIdx('Account code to be billed');
  const idxApproveReject = getColIdx('Approve / Reject');

  let hourlySetting = await SystemSetting.findOne({ key: 'defaultRatePerHour' });
  let mileSetting = await SystemSetting.findOne({ key: 'defaultRatePerMile' });

  let importedCount = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rawDate = idxDate !== -1 ? row[idxDate] : null;

    if (rawDate) {
      const tripDate = normalizeDateStr(rawDate);
      
      let dest = idxDestName !== -1 ? (row[idxDestName] || '') : '';
      if (idxDestAddr !== -1 && row[idxDestAddr]) {
        dest += dest ? ` (${row[idxDestAddr]})` : row[idxDestAddr];
      }

      let accountStatusFromSheet = 'Pending';
      if (idxApproveReject !== -1 && row[idxApproveReject]) {
        const decision = row[idxApproveReject].trim().toLowerCase();
        if (decision === 'approve') accountStatusFromSheet = 'Verified';
        else if (decision === 'reject') accountStatusFromSheet = 'Flagged';
      }

      const existingDoc = await FieldTripAudit.findOne({
        date: tripDate,
        school: idxSchool !== -1 ? (row[idxSchool] || '') : '',
        destination: dest
      });

      let finalAccountStatus = accountStatusFromSheet;
      if (existingDoc && existingDoc.accountCodeCheck && existingDoc.accountCodeCheck !== 'Pending') {
        finalAccountStatus = existingDoc.accountCodeCheck;
      }

      const tripData = {
        date: tripDate,
        tripType: idxType !== -1 ? (row[idxType] || 'Academic') : 'Academic',
        school: idxSchool !== -1 ? (row[idxSchool] || '') : '',
        classTeam: idxGroup !== -1 ? (row[idxGroup] || '') : '',
        destination: dest,
        pickupTime: idxPickup !== -1 ? formatTo12Hour(row[idxPickup] || '') : '',
        dropOffTime: idxReturn !== -1 ? formatTo12Hour(row[idxReturn] || '') : '',
        numBuses: idxBuses !== -1 ? (parseInt(row[idxBuses], 10) || 1) : 1,
        requestedBy: idxApplicant !== -1 ? (row[idxApplicant] || '') : '',
        approverName: idxApprover !== -1 ? (row[idxApprover] || '') : '',
        notes: idxNotes !== -1 ? (row[idxNotes] || '') : '',
        accountCode: idxAccount !== -1 ? (row[idxAccount] || '') : '',
        accountCodeCheck: finalAccountStatus,
        ratePerHour: hourlySetting ? parseFloat(hourlySetting.value) : 25.00,
        ratePerMile: mileSetting ? parseFloat(mileSetting.value) : 2.50
      };

      const savedTrip = await FieldTripAudit.findOneAndUpdate(
        { date: tripDate, school: tripData.school, destination: tripData.destination },
        tripData,
        { upsert: true, new: true }
      );

      await syncFieldTripToDailySchedule(savedTrip);
      importedCount++;
    }
  }

  return { count: importedCount, tab: targetTab };
}

function startGoogleSheetPoller() {
  const SHEET_URL_OR_ID = process.env.DEFAULT_FIELD_TRIP_SHEET_ID;

  if (!SHEET_URL_OR_ID) return;

  executeSheetSync(SHEET_URL_OR_ID).catch(err => console.error('[POLLER ERROR]:', err.message));

  setInterval(async () => {
    try {
      await executeSheetSync(SHEET_URL_OR_ID);
    } catch (err) {
      console.error('[POLLER ERROR]:', err.message);
    }
  }, 3 * 60 * 1000);
}

async function renderHeader(activePage, showFullscreen = false, user = null) {
  const { isAdmin, isDriver, isMechanic } = await getUserRoles(user);

  let navLinks = '<a href="/dashboard" class="nav-btn ' + (activePage === 'dashboard' ? 'nav-active' : '') + '">📺 Live Monitor</a>';

  if (isDriver || isAdmin) {
    navLinks += '<a href="/dispatch" class="nav-btn ' + (activePage === 'dispatch' ? 'nav-active' : '') + '">📱 Driver Kiosk</a>';
  }

  if (isMechanic || isAdmin) {
    navLinks += '<a href="/mechanics" class="nav-btn ' + (activePage === 'mechanics' ? 'nav-active' : '') + '">🛠 Shop Portal</a>';
  }

  if (isAdmin) {
    navLinks += '<a href="/admin" class="nav-btn ' + (activePage === 'admin' ? 'nav-active' : '') + '">📋 Admin Portal</a>';
    navLinks += '<a href="/reports" class="nav-btn ' + (activePage === 'reports' ? 'nav-active' : '') + '">📊 EOD Reports</a>';
    navLinks += '<a href="/field-trips" class="nav-btn ' + (activePage === 'field-trips' ? 'nav-active' : '') + '">🚌 District Trips</a>';
  }

  return '<header><div><div class="brand-title">PARKWAY SCHOOLS</div><div class="brand-tagline">HIGHER EXPECTATIONS. BRIGHTER FUTURES.</div></div>' +
    '<div style="display:flex; align-items:center;">' +
    (showFullscreen ? '<button class="nav-btn" onclick="toggleFullScreen()">📺 Fullscreen</button>' : '') +
    navLinks +
    (user ? '<a href="/logout" class="nav-btn" style="background:#000;">🔒 Logout (' + (user.name ? user.name.split(' ')[0] : 'User') + ')</a>' : '') +
    '</div></header>';
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

// ================= AUTHENTICATION ROUTES =================
app.get('/login', async (req, res) => {
  const headerHtml = await renderHeader('none', false, req.user);
  res.send('<!DOCTYPE html><html><head><title>Parkway Schools - Transportation Login</title><style>' + COMMON_CSS +
    '.login-card { background:#fff; width:350px; margin:80px auto; padding:30px; border-top:5px solid #DD0000; box-shadow:0 2px 10px rgba(0,0,0,0.1); text-align:center; }' +
    '.google-btn { background:#4285F4; color:#fff; font-weight:bold; padding:12px 20px; text-decoration:none; display:inline-block; border-radius:2px; font-size:13px; margin-top:20px; }' +
    '</style></head><body>' + headerHtml + '<div class="login-card"><h2 style="color:#DD0000; margin-top:0;">DISTRICT SSO PORTAL</h2>' +
    '<p style="font-size:12px; color:#555;">Please log in with your official Parkway Schools Google Workspace account.</p>' +
    '<a href="/auth/google" class="google-btn">🔑 Sign in with Google SSO</a></div></body></html>');
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/api/auth/callback/google', 
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => res.redirect('/dashboard')
);

app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/login'));
});

app.get('/api/me', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ authenticated: false, message: 'Not logged in.' });
  }
  res.json({ authenticated: true, ssoProfile: req.user });
});

// ================= SAMPLE CSV DOWNLOAD ENDPOINTS =================

app.get('/api/samples/drivers', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="drivers_sample.csv"');
  res.send("name,email\nJohn Doe,jdoe@parkwayschools.net\nJane Smith,jsmith@parkwayschools.net\n");
});

app.get('/api/samples/buses', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="buses_sample.csv"');
  res.send("busNumber,isSpare\n101,false\n102,true\n103,false\n");
});

app.get('/api/samples/mechanics', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="mechanics_sample.csv"');
  res.send("name,email\nMike Taylor,mtaylor@parkwayschools.net\nSarah Connor,sconnor@parkwayschools.net\n");
});

app.get('/api/samples/schedule', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="schedule_sample.csv"');
  res.send("date,slot,routeName,scheduledTime,driverEmail,busNumber\n2026-09-28,amRoutes,Route 12,07:00,jdoe@parkwayschools.net,101\n2026-09-28,amRoutes,Route 14,07:15,jsmith@parkwayschools.net,103\n2026-09-28,pmRoutes,Route 12,14:30,jdoe@parkwayschools.net,101\n2026-09-28,fieldTrips,Zoo Trip,09:00,jsmith@parkwayschools.net,102\n");
});

app.get('/api/samples/district-field-trips', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="district_field_trips_sample.csv"');
  res.send("Date,Trip Type,School,Class / Team,Destination,Pickup Time,Drop Off Time,# of Buses,Applicant Name,Name of Approving Principal or Director,Notes,Coach Communications Line,Account Code,Start Hours,End Hours,Rate Per Hour,Start Miles,End Miles,Rate Per Mile,Account Code Check\n2026-10-05,Athletic,Parkway Central,Varsity Football,Eureka High,3:30 PM,9:00 PM,2,John Doe,Jane Smith,Equipment trailer attached,314-555-0199,100-2710-6341,15.0,21.5,25.00,12040,12095,2.50,Verified\n");
});

// ================= BATCH CSV UPLOAD ENDPOINTS =================

app.post('/api/upload/drivers', requireAdminAccess(), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded.' });

  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      let count = 0;
      for (let row of results) {
        if (row.name && row.email) {
          await Driver.findOneAndUpdate(
            { email: row.email.toLowerCase().trim() },
            { name: row.name.trim(), email: row.email.toLowerCase().trim() },
            { upsert: true }
          );
          count++;
        }
      }
      fs.unlinkSync(req.file.path);
      res.json({ message: `Successfully imported/updated ${count} driver(s)!` });
    })
    .on('error', (err) => res.status(500).json({ error: err.message }));
});

app.post('/api/upload/buses', requireAdminAccess(), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded.' });

  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      let count = 0;
      for (let row of results) {
        if (row.busNumber) {
          const isSpare = String(row.isSpare).toLowerCase() === 'true';
          await Bus.findOneAndUpdate(
            { busNumber: row.busNumber.toString().trim() },
            { busNumber: row.busNumber.toString().trim(), isSpare },
            { upsert: true }
          );
          count++;
        }
      }
      fs.unlinkSync(req.file.path);
      res.json({ message: `Successfully imported/updated ${count} bus(es)!` });
    })
    .on('error', (err) => res.status(500).json({ error: err.message }));
});

app.post('/api/upload/mechanics', requireAdminAccess(), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded.' });

  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      let count = 0;
      for (let row of results) {
        if (row.name && row.email) {
          await Mechanic.findOneAndUpdate(
            { email: row.email.toLowerCase().trim() },
            { name: row.name.trim(), email: row.email.toLowerCase().trim() },
            { upsert: true }
          );
          count++;
        }
      }
      fs.unlinkSync(req.file.path);
      res.json({ message: `Successfully imported/updated ${count} mechanic(s)!` });
    })
    .on('error', (err) => res.status(500).json({ error: err.message }));
});

app.post('/api/upload/schedule', requireAdminAccess(), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded.' });

  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      const scheduleMap = {};

      for (let row of results) {
        if (!row.date || !row.slot || !row.routeName) continue;
        const normDate = normalizeDateStr(row.date);

        if (!scheduleMap[normDate]) {
          scheduleMap[normDate] = { amRoutes: [], pmRoutes: [], fieldTrips: [] };
        }

        let driverId = null;
        if (row.driverEmail) {
          const d = await Driver.findOne({ email: row.driverEmail.toLowerCase().trim() });
          if (d) driverId = d._id;
        }

        let busId = null;
        if (row.busNumber) {
          const b = await Bus.findOne({ busNumber: row.busNumber.toString().trim() });
          if (b) busId = b._id;
        }

        const entry = {
          routeName: row.routeName.trim(),
          scheduledTime: parse12HourTo24Hour(row.scheduledTime || '07:00'),
          driverId,
          busId,
          status: 'Pending'
        };

        if (['amRoutes', 'pmRoutes', 'fieldTrips'].includes(row.slot.trim())) {
          scheduleMap[normDate][row.slot.trim()].push(entry);
        }
      }

      let count = 0;
      for (let dateKey of Object.keys(scheduleMap)) {
        await DailySchedule.findOneAndUpdate(
          { date: dateKey },
          scheduleMap[dateKey],
          { upsert: true }
        );
        count++;
      }

      fs.unlinkSync(req.file.path);
      res.json({ message: `Successfully imported/updated schedule data for ${count} date(s)!` });
    })
    .on('error', (err) => res.status(500).json({ error: err.message }));
});

// ================= SYSTEM DEFAULT RATES APIs =================

app.get('/api/system-rates', async (req, res) => {
  try {
    let hourlySetting = await SystemSetting.findOne({ key: 'defaultRatePerHour' });
    let mileSetting = await SystemSetting.findOne({ key: 'defaultRatePerMile' });

    res.json({
      ratePerHour: hourlySetting ? parseFloat(hourlySetting.value) : 25.00,
      ratePerMile: mileSetting ? parseFloat(mileSetting.value) : 2.50
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/system-rates', requireAdminAccess(), async (req, res) => {
  try {
    const { ratePerHour, ratePerMile } = req.body;

    if (ratePerHour !== undefined) {
      await SystemSetting.findOneAndUpdate(
        { key: 'defaultRatePerHour' },
        { value: parseFloat(ratePerHour) },
        { upsert: true }
      );
    }

    if (ratePerMile !== undefined) {
      await SystemSetting.findOneAndUpdate(
        { key: 'defaultRatePerMile' },
        { value: parseFloat(ratePerMile) },
        { upsert: true }
      );
    }

    res.json({ success: true, message: 'District default billing rates updated successfully!' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ================= GOOGLE DIRECTORY AUTO-SYNC ENDPOINTS =================

app.post('/api/sync/drivers', requireAdminAccess(), async (req, res) => {
  try {
    const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    let privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '';
    privateKey = privateKey.replace(/^"|"$/g, '').replace(/\\n/g, '\n');
    const adminEmail = process.env.GOOGLE_ADMIN_EMAIL;

    if (!serviceAccountEmail || !privateKey || !adminEmail) {
      return res.status(400).json({ error: 'Google Directory Service Account credentials not fully configured in .env' });
    }

    const auth = new google.auth.JWT({
      email: serviceAccountEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
      subject: adminEmail
    });

    await auth.authorize();
    const service = google.admin({ version: 'directory_v1', auth });

    let pageToken = null;
    let syncedCount = 0;
    let totalExamined = 0;

    do {
      const response = await service.users.list({
        customer: 'my_customer',
        projection: 'full',
        maxResults: 500,
        pageToken
      });

      const users = response.data.users || [];
      totalExamined += users.length;

      for (let u of users) {
        const jobTitle = (u.organizations && u.organizations[0] ? (u.organizations[0].title || '') : '').toLowerCase();
        const ouPath = (u.orgUnitPath || '').toUpperCase();
        const email = u.primaryEmail ? u.primaryEmail.toLowerCase().trim() : '';
        
        const isActive = !u.suspended && u.archived !== true;
        const hasDriverTitle = /\bdriver\b/i.test(jobTitle);
        const isInTraOU = ouPath.includes('/TRA') || ouPath.endsWith('/TRA');

        if (isActive && hasDriverTitle && isInTraOU && email) {
          await Driver.findOneAndUpdate(
            { email },
            { name: u.name ? u.name.fullName : email, email },
            { upsert: true }
          );
          syncedCount++;
        }
      }

      pageToken = response.data.nextPageToken;
    } while (pageToken);

    res.json({ message: `Examined ${totalExamined} Workspace accounts. Successfully synced ${syncedCount} active TRA driver(s)!` });
  } catch (err) {
    console.error('[SYNC DRIVERS ERROR]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/drivers/clear-all', requireAdminAccess(), async (req, res) => {
  try {
    const result = await Driver.deleteMany({});
    res.json({ message: `Successfully deleted ${result.deletedCount} driver(s).`, count: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sync/mechanics', requireAdminAccess(), async (req, res) => {
  try {
    const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    let privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '';
    privateKey = privateKey.replace(/^"|"$/g, '').replace(/\\n/g, '\n');
    const adminEmail = process.env.GOOGLE_ADMIN_EMAIL;

    if (!serviceAccountEmail || !privateKey || !adminEmail) {
      return res.status(400).json({ error: 'Google Directory Service Account credentials not fully configured in .env' });
    }

    const auth = new google.auth.JWT({
      email: serviceAccountEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
      subject: adminEmail
    });

    await auth.authorize();
    const service = google.admin({ version: 'directory_v1', auth });

    let pageToken = null;
    let syncedCount = 0;

    do {
      const response = await service.users.list({
        customer: 'my_customer',
        projection: 'full',
        maxResults: 500,
        pageToken
      });

      const users = response.data.users || [];

      for (let u of users) {
        const jobTitle = (u.organizations && u.organizations[0] ? (u.organizations[0].title || '') : '').toLowerCase();
        const ouPath = (u.orgUnitPath || '').toLowerCase();
        const email = u.primaryEmail ? u.primaryEmail.toLowerCase().trim() : '';

        const isMechanic = jobTitle.includes('mechanic') && ouPath.includes('tra');

        if (isMechanic && email) {
          await Mechanic.findOneAndUpdate(
            { email },
            { name: u.name ? u.name.fullName : email, email },
            { upsert: true }
          );
          syncedCount++;
        }
      }

      pageToken = response.data.nextPageToken;
    } while (pageToken);

    res.json({ message: `Successfully synced ${syncedCount} mechanic(s)!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= APPLICATION ADMIN WHITELIST APIs =================

app.get('/api/admin-whitelist', requireAdminAccess(), async (req, res) => {
  try {
    const admins = await AdminWhitelist.find().sort({ addedAt: -1 });
    res.json(admins);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin-whitelist', requireAdminAccess(), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const newAdmin = new AdminWhitelist({
      email: email.toLowerCase().trim(),
      addedBy: req.user ? req.user.email : 'System Admin'
    });

    await newAdmin.save();
    res.status(201).json(newAdmin);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Email is already in the admin whitelist.' });
    }
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin-whitelist/:id', requireAdminAccess(), async (req, res) => {
  try {
    await AdminWhitelist.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ================= DISTRICT FIELD TRIP AUDIT APIs =================

// GET /api/district-field-trips/single/:id - Load single trip record
app.get('/api/district-field-trips/single/:id', async (req, res) => {
  try {
    const trip = await FieldTripAudit.findById(req.params.id)
      .populate('busAssignments.busId')
      .populate('busAssignments.driverId');
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    res.json(trip);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/district-field-trips/month/:yearMonth - Load trips for an entire month
app.get('/api/district-field-trips/month/:yearMonth', async (req, res) => {
  try {
    const { yearMonth } = req.params;
    const trips = await FieldTripAudit.find({ date: { $regex: `^${yearMonth}` } })
      .populate('busAssignments.busId')
      .populate('busAssignments.driverId')
      .sort({ date: 1, pickupTime: 1 });
    res.json(trips);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/district-field-trips/:date - Load trips for a single date
app.get('/api/district-field-trips/:date', async (req, res) => {
  try {
    const normalizedDate = normalizeDateStr(req.params.date);
    const trips = await FieldTripAudit.find({ date: normalizedDate })
      .populate('busAssignments.busId')
      .populate('busAssignments.driverId')
      .sort({ pickupTime: 1 });
    res.json(trips || []);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/district-field-trips - Create new trip record
app.post('/api/district-field-trips', async (req, res) => {
  try {
    if (req.body.date) {
      req.body.date = normalizeDateStr(req.body.date);
    }
    
    let hourlySetting = await SystemSetting.findOne({ key: 'defaultRatePerHour' });
    let mileSetting = await SystemSetting.findOne({ key: 'defaultRatePerMile' });

    if (req.body.ratePerHour === undefined) {
      req.body.ratePerHour = hourlySetting ? parseFloat(hourlySetting.value) : 25.00;
    }
    if (req.body.ratePerMile === undefined) {
      req.body.ratePerMile = mileSetting ? parseFloat(mileSetting.value) : 2.50;
    }

    if (req.body.busAssignments) {
      req.body.busAssignments = sanitizeBusAssignments(req.body.busAssignments);
    }

    const trip = new FieldTripAudit(req.body);
    await trip.save();

    await syncFieldTripToDailySchedule(trip);

    res.status(201).json(trip);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/district-field-trips/:id - Update existing trip record
app.put('/api/district-field-trips/:id', async (req, res) => {
  try {
    const trip = await FieldTripAudit.findById(req.params.id);
    if (!trip) return res.status(404).json({ error: 'Record not found' });

    if (req.body.date) {
      req.body.date = normalizeDateStr(req.body.date);
    }

    if (req.body.busAssignments) {
      req.body.busAssignments = sanitizeBusAssignments(req.body.busAssignments);
    }

    Object.assign(trip, req.body);
    await trip.save();

    const populatedTrip = await FieldTripAudit.findById(trip._id)
      .populate('busAssignments.busId')
      .populate('busAssignments.driverId');

    await syncFieldTripToDailySchedule(populatedTrip);

    res.json(populatedTrip);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/district-field-trips/:id - Remove trip record
app.delete('/api/district-field-trips/:id', async (req, res) => {
  try {
    const trip = await FieldTripAudit.findByIdAndDelete(req.params.id);
    if (trip) {
      trip.accountCodeCheck = 'Flagged';
      await syncFieldTripToDailySchedule(trip);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/district-field-trips/export/:date - Export trips to CSV
app.get('/api/district-field-trips/export/:date', async (req, res) => {
  try {
    const normalizedDate = normalizeDateStr(req.params.date);
    const trips = await FieldTripAudit.find({ date: { $regex: `^${normalizedDate}` } })
      .populate('busAssignments.busId')
      .populate('busAssignments.driverId')
      .sort({ date: 1 });

    let csvContent = 'Date,Trip Type,School,Class / Team,Destination,Pickup Time,Drop Off Time,# of Buses,Bus Number,Driver Name,Bus Start Hr,Bus End Hr,Bus Tot Hr,Bus Start Mi,Bus End Mi,Bus Tot Mi,Bus Charge,Requested By,Approver,Notes,Coach Communications Line,Account Code,Rate Per Hour,Rate Per Mile,Trip Grand Total,Account Code Check\n';

    trips.forEach(t => {
      const assignments = t.busAssignments && t.busAssignments.length > 0 ? t.busAssignments : [{}];

      assignments.forEach((p) => {
        const bNum = p.busId ? p.busId.busNumber : 'Unassigned';
        const dName = p.driverId ? p.driverId.name : 'Unassigned';
        const bStartHr = p.startHours || 0;
        const bEndHr = p.endHours || 0;
        const bTotHr = (p.totalHours || 0).toFixed(1);
        const bStartMi = p.startMiles || 0;
        const bEndMi = p.endMiles || 0;
        const bTotMi = p.totalMiles || 0;
        const bCharge = (p.charge || 0).toFixed(2);

        csvContent += `"${t.date}","${t.tripType}","${t.school}","${t.classTeam}","${t.destination}","${formatTo12Hour(t.pickupTime)}","${formatTo12Hour(t.dropOffTime)}","${t.numBuses}","Bus #${bNum}","${dName}","${bStartHr}","${bEndHr}","${bTotHr}","${bStartMi}","${bEndMi}","${bTotMi}","$${bCharge}","${t.requestedBy || ''}","${t.approverName || ''}","${t.notes || ''}","${t.coachCommLine || ''}","${t.accountCode || ''}","$${(t.ratePerHour || 25).toFixed(2)}","$${(t.ratePerMile || 2.5).toFixed(2)}","$${t.charge.toFixed(2)}","${t.accountCodeCheck}"\n`;
      });
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="district_field_trips_${normalizedDate}.csv"`);
    res.send(csvContent);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ================= DAILY REPORTS API =================

// GET /api/reports/daily/:date - Fetch daily dispatch report summary and routes
app.get('/api/reports/daily/:date', async (req, res) => {
  try {
    const normalizedDate = normalizeDateStr(req.params.date);
    const schedule = await DailySchedule.findOne({ date: normalizedDate })
      .populate('amRoutes.driverId amRoutes.busId')
      .populate('pmRoutes.driverId pmRoutes.busId')
      .populate('fieldTrips.driverId fieldTrips.busId');

    if (!schedule) {
      return res.status(404).json({ error: `No dispatch data recorded for ${normalizedDate}.` });
    }

    const allRoutes = [
      ...(schedule.amRoutes || []).map(r => ({ ...r.toObject(), categoryTag: 'AM' })),
      ...(schedule.pmRoutes || []).map(r => ({ ...r.toObject(), categoryTag: 'PM' })),
      ...(schedule.fieldTrips || []).map(r => ({ ...r.toObject(), categoryTag: 'Field Trip' }))
    ];

    const totalRoutes = allRoutes.length;
    const completedRoutes = allRoutes.filter(r => r.status && r.status.startsWith('Returned')).length;
    const delayedRoutes = allRoutes.filter(r => r.status === 'Delayed').length;
    const unassignedRoutes = allRoutes.filter(r => !r.driverId || !r.busId).length;
    const onTimeRate = totalRoutes > 0 ? Math.round(((completedRoutes - delayedRoutes) / totalRoutes) * 100) : 0;

    res.json({
      date: normalizedDate,
      summary: {
        totalRoutes,
        completedRoutes,
        delayedRoutes,
        unassignedRoutes,
        onTimeRate: Math.max(0, onTimeRate)
      },
      routes: allRoutes
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/daily/:date/export - Export daily report to CSV
app.get('/api/reports/daily/:date/export', async (req, res) => {
  try {
    const normalizedDate = normalizeDateStr(req.params.date);
    const schedule = await DailySchedule.findOne({ date: normalizedDate })
      .populate('amRoutes.driverId amRoutes.busId')
      .populate('pmRoutes.driverId pmRoutes.busId')
      .populate('fieldTrips.driverId fieldTrips.busId');

    if (!schedule) {
      return res.status(404).send('No data found for this date.');
    }

    const formatRow = (r, slot) => {
      const driver = r.driverId ? r.driverId.name : 'Unassigned';
      const driverEmail = r.driverId ? r.driverId.email : 'N/A';
      const bus = r.busId ? r.busId.busNumber : 'Unassigned';
      return `"${normalizedDate}","${slot}","${r.routeName}","${r.scheduledTime || ''}","${driver}","${driverEmail}","${bus}","${r.status}","${r.checkInTime || ''}","${r.returnTime || ''}"\n`;
    };

    let csvContent = 'Date,Slot,Route Name,Scheduled Time,Driver Name,Driver Email,Bus Number,Final Status,Check-In Time,Return Time\n';

    (schedule.amRoutes || []).forEach(r => { csvContent += formatRow(r, 'AM'); });
    (schedule.pmRoutes || []).forEach(r => { csvContent += formatRow(r, 'PM'); });
    (schedule.fieldTrips || []).forEach(r => { csvContent += formatRow(r, 'Field Trip'); });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="parkway_dispatch_report_${normalizedDate}.csv"`);
    res.send(csvContent);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ================= ROUTE AND STATUS APIs =================

app.get('/api/drivers', async (req, res) => res.json(await Driver.find().sort({ name: 1 })));
app.post('/api/drivers', async (req, res) => {
  try {
    const driver = new Driver({
      name: req.body.name,
      email: req.body.email ? req.body.email.toLowerCase().trim() : ''
    });
    await driver.save();
    res.status(201).json(driver);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/drivers/:id', async (req, res) => {
  try {
    const driverId = req.params.id;
    const force = req.query.force === 'true';
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

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

app.get('/api/buses', async (req, res) => res.json(await Bus.find().sort({ busNumber: 1 })));
app.post('/api/buses', async (req, res) => {
  try {
    const bus = new Bus(req.body);
    await bus.save();
    res.status(201).json(bus);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/buses/:id', async (req, res) => {
  try {
    const busId = req.params.id;
    const force = req.query.force === 'true';
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

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
  const { busId, status, offlineReason, expectedReturnDate, autoSwapSpare = true } = req.body;

  try {
    const bus = await Bus.findByIdAndUpdate(
      busId,
      { 
        status, 
        offlineReason: status === 'In Shop' ? offlineReason : '', 
        expectedReturnDate: status === 'In Shop' ? expectedReturnDate : '' 
      },
      { new: true }
    );

    let swapMessage = '';

    if (status === 'In Shop') {
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

      const affectedSchedules = await DailySchedule.find({
        date: { $gte: todayStr },$or: [
          { 'amRoutes.busId': busId },
          { 'pmRoutes.busId': busId },
          { 'fieldTrips.busId': busId }
        ]
      });

      if (affectedSchedules.length > 0) {
        if (autoSwapSpare) {
          const spareBus = await Bus.findOne({ isSpare: true, status: 'Available' });

          if (spareBus) {
            const spareId = spareBus._id;
            for (let schedule of affectedSchedules) {
              ['amRoutes', 'pmRoutes', 'fieldTrips'].forEach(cat => {
                schedule[cat].forEach(route => {
                  if (route.busId && route.busId.toString() === busId.toString()) {
                    route.busId = spareId;
                  }
                });
              });
              await schedule.save();
            }
            swapMessage = ` Bus #${bus.busNumber} was assigned to ${affectedSchedules.length} schedule(s). Automatically swapped affected routes to Spare Bus #${spareBus.busNumber}!`;
          } else {
            swapMessage = ` ⚠ Bus #${bus.busNumber} is assigned to ${affectedSchedules.length} schedule(s), but NO available spare bus was found in inventory!`;
          }
        } else {
          swapMessage = ` ⚠ Bus #${bus.busNumber} is assigned to ${affectedSchedules.length} active schedule(s).`;
        }
      }
    }

    res.json({ bus, message: `Bus #${bus.busNumber} status updated to ${status}.${swapMessage}` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/mechanics', async (req, res) => res.json(await Mechanic.find()));
app.post('/api/mechanics', async (req, res) => {
  try {
    const mechanic = new Mechanic({
      name: req.body.name,
      email: req.body.email ? req.body.email.toLowerCase().trim() : ''
    });
    await mechanic.save();
    res.status(201).json(mechanic);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/mechanics/:id', async (req, res) => {
  try {
    await Mechanic.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/schedule/:date - Load schedule for a specific date
app.get('/api/schedule/:date', async (req, res) => {
  try {
    const schedule = await DailySchedule.findOne({ date: req.params.date })
      .populate('amRoutes.driverId amRoutes.busId')
      .populate('pmRoutes.driverId pmRoutes.busId')
      .populate('fieldTrips.driverId fieldTrips.busId');

    res.json(schedule || { date: req.params.date, amRoutes: [], pmRoutes: [], fieldTrips: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/schedule - Save or update a daily schedule
app.post('/api/schedule', requireAdminAccess(), async (req, res) => {
  try {
    const { date, amRoutes, pmRoutes, fieldTrips } = req.body;

    if (!date) {
      return res.status(400).json({ error: 'Date is required.' });
    }

    const sanitizeRoutes = (arr) => {
      if (!Array.isArray(arr)) return [];
      return arr
        .filter(r => r && r.routeName && String(r.routeName).trim() !== '')
        .map(r => ({
          routeName: String(r.routeName).trim(),
          scheduledTime: r.scheduledTime || '07:00',
          driverId: (r.driverId && String(r.driverId).trim() !== '') ? r.driverId : null,
          busId: (r.busId && String(r.busId).trim() !== '') ? r.busId : null,
          startMileage: Number(r.startMileage) || 0,
          endMileage: Number(r.endMileage) || 0
        }));
    };

    const cleanAm = sanitizeRoutes(amRoutes);
    const cleanPm = sanitizeRoutes(pmRoutes);
    const cleanTrips = sanitizeRoutes(fieldTrips);

    const schedule = await DailySchedule.findOneAndUpdate(
      { date },
      {
        date,
        amRoutes: cleanAm,
        pmRoutes: cleanPm,
        fieldTrips: cleanTrips
      },
      { upsert: true, new: true, runValidators: false }
    );

    res.json({ message: 'Schedule saved successfully!', schedule });

  } catch (err) {
    console.error('[SAVE SCHEDULE ERROR]:', err);
    res.status(500).json({ error: err.message || 'Server error while saving schedule' });
  }
});

app.delete('/api/schedule/clear-all', requireAdminAccess(), async (req, res) => {
  try {
    const result = await DailySchedule.deleteMany({});
    res.json({ message: `Successfully deleted ${result.deletedCount} schedule records.`, count: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/schedule/update-status', async (req, res) => {
  const { date, category, routeId, status, startMiles, endMiles } = req.body;
  const normalizedDate = normalizeDateStr(date);

  try {
    const schedule = await DailySchedule.findOne({ date: normalizedDate });
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

    const nowStr = getCentralTimeStr();
    const centralNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const currentDecimalHours = parseFloat((centralNow.getHours() + centralNow.getMinutes() / 60).toFixed(1));

    route.status = status;
    if (status === 'En Route') {
      route.checkInTime = nowStr;
    } else if (status === 'Pending' || status === 'Delayed') {
      route.checkInTime = null;
      route.returnTime = null;
    } else if (status.startsWith('Returned')) {
      route.returnTime = nowStr;
      if (startMiles !== undefined && startMiles !== null && !isNaN(startMiles)) {
        route.startMileage = Number(startMiles);
      }
      if (endMiles !== undefined && endMiles !== null && !isNaN(endMiles)) {
        route.endMileage = Number(endMiles);
      }
    }

    await schedule.save();

    const cleanRouteName = route.routeName.replace(/\s*\(Bus \d+\)$/i, '').trim();

    const matchingTrip = await FieldTripAudit.findOne({
      date: normalizedDate,
      $or: [
        { 'busAssignments.busId': route.busId },
        { 'busAssignments.driverId': route.driverId }
      ]
    });

    if (matchingTrip) {
      const assignment = matchingTrip.busAssignments.find(b => {
        const bBusId = getObjIdStr(b.busId);
        const rBusId = getObjIdStr(route.busId);
        const bDrvId = getObjIdStr(b.driverId);
        const rDrvId = getObjIdStr(route.driverId);

        return (rBusId && bBusId === rBusId) || (rDrvId && bDrvId === rDrvId);
      });

      if (assignment) {
        if (status === 'En Route') {
          assignment.startHours = currentDecimalHours;
        } else if (status.startsWith('Returned')) {
          assignment.endHours = currentDecimalHours;
          if (startMiles !== undefined && startMiles !== null && !isNaN(startMiles)) {
            assignment.startMiles = Number(startMiles);
          }
          if (endMiles !== undefined && endMiles !== null && !isNaN(endMiles)) {
            assignment.endMiles = Number(endMiles);
          }
        }

        matchingTrip.markModified('busAssignments');
        await matchingTrip.save();
      }
    }

    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/schedule/copy-forward', async (req, res) => {
  const { targetDate } = req.body;
  const normalizedTarget = normalizeDateStr(targetDate);

  try {
    const targetObj = new Date(normalizedTarget);
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
      status: 'Pending',
      checkInTime: null,
      returnTime: null
    }));

    const newSchedule = await DailySchedule.findOneAndUpdate(
      { date: normalizedTarget },
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

// ================= PAGE VIEWS / VIEW ROUTES =================

app.get('/dashboard', requireStaffView(['/parkwayschools.net/Staff']), async (req, res) => {
  const headerHtml = await renderHeader('dashboard', true, req.user);
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
    .route-card { background: #fafafa; border: 1px solid #e0e0e0; border-left: 4px solid #666; padding: 6px 10px; margin-bottom: 5px; border-radius: 2px; font-size: 11px; display: flex; align-items: center; justify-content: space-between; white-space: nowrap; gap: 8px; }
    .route-card-delayed { border: 1.5px solid #DD0000; border-left: 5px solid #DD0000; background: #fff0f0; }
    .route-card-title { font-weight: bold; font-size: 12px; color: #DD0000; }
    .badge { background: #eee; padding: 2px 5px; border-radius: 3px; font-size: 9px; font-weight: bold; }
    .badge-slot { background: #666; color: #fff; text-transform: uppercase; }
    .badge-delayed { background: #DD0000; color: #fff; }
  </style>
</head>
<body>
  ${headerHtml}
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
    <span style="margin-left: auto; font-size:10px; color:#666;">Auto-refreshes every 10s (Central Time)</span>
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
    document.getElementById('dashDate').value = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

    function toggleFullScreen() {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => alert(err.message));
      } else {
        if (document.exitFullscreen) document.exitFullscreen();
      }
    }

    function formatTo12Hour(time24) {
      if (!time24) return 'N/A';
      if (time24.includes('AM') || time24.includes('PM')) return time24;
      const parts = time24.split(':');
      if (parts.length < 2) return time24;
      const hours = parseInt(parts[0], 10);
      const minutes = parseInt(parts[1], 10);
      if (isNaN(hours) || isNaN(minutes)) return time24;
      const period = hours >= 12 ? 'PM' : 'AM';
      const hours12 = hours % 12 || 12;
      const minStr = minutes < 10 ? '0' + minutes : minutes;
      return hours12 + ':' + minStr + ' ' + period;
    }

    async function loadDashData() {
      const date = document.getElementById('dashDate').value;
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

        if (r.status === 'Pending' || isDelayed) {
          cPending++;
          card.innerHTML = '<div style="display:flex; align-items:center; gap:5px; overflow:hidden;">' +
            '<span class="route-card-title">' + r.routeName + '</span>' +
            '<span class="badge badge-slot">' + r.categoryTag + '</span>' + inShopAlert +
            (isDelayed ? '<span class="badge badge-delayed">⚠️ Delayed</span>' : '') + '</div>' +
            '<div style="color:#444;">👤 ' + driverName + ' | 🚌 ' + busNum + '</div>' +
            '<div style="font-weight:bold; color:#666;">⏰ ' + formatTo12Hour(r.scheduledTime) + '</div>';
          colPending.appendChild(card);
        } else if (r.status === 'En Route') {
          cEnRoute++;
          card.innerHTML = '<div style="display:flex; align-items:center; gap:5px; overflow:hidden;">' +
            '<span class="route-card-title">' + r.routeName + '</span>' +
            '<span class="badge badge-slot">' + r.categoryTag + '</span>' + inShopAlert + '</div>' +
            '<div style="color:#444;">👤 ' + driverName + ' | 🚌 ' + busNum + '</div>' +
            '<div style="color:#DD0000; font-weight:bold;">⏱ ' + (r.checkInTime || 'N/A') + '</div>';
          colEnRoute.appendChild(card);
        } else {
          cReturned++;
          card.innerHTML = '<div style="display:flex; align-items:center; gap:5px; overflow:hidden;">' +
            '<span class="route-card-title">' + r.routeName + '</span>' +
            '<span class="badge badge-slot">' + r.categoryTag + '</span>' + inShopAlert + '</div>' +
            '<div style="color:#444;">👤 ' + driverName + ' | 🚌 ' + busNum + '</div>' +
            '<div style="color:#2e7d32; font-weight:bold;">🏁 ' + (r.returnTime || 'N/A') + '</div>';
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

app.get('/dispatch', requireDriverOrAdmin(), async (req, res) => {
  const headerHtml = await renderHeader('dispatch', true, req.user);
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
    .route-card { background: #fafafa; border: 1px solid #e0e0e0; border-left: 4px solid #666; padding: 6px 10px; margin-bottom: 5px; border-radius: 2px; font-size: 11px; display: flex; align-items: center; justify-content: space-between; white-space: nowrap; gap: 6px; }
    .route-card-delayed { border: 1.5px solid #DD0000; border-left: 5px solid #DD0000; background: #fff0f0; }
    .route-card-title { font-weight: bold; font-size: 12px; color: #DD0000; }
    button, select, input[type="text"] { font-family: 'Trebuchet MS', sans-serif; font-size: 10px; padding: 3px 6px; font-weight: bold; border-radius: 2px; }
    .btn-checkin { background: #DD0000; color: #fff; border: none; cursor: pointer; }
    .btn-checkin:hover { background: #b30000; }
    .btn-undo { background: #666; color: #fff; border: none; cursor: pointer; }
    .btn-undo:hover { background: #444; }
    .badge { background: #eee; padding: 2px 5px; border-radius: 3px; font-size: 9px; font-weight: bold; }
    .badge-slot { background: #666; color: #fff; text-transform: uppercase; }
    .badge-delayed { background: #DD0000; color: #fff; }
  </style>
</head>
<body>
  ${headerHtml}
  <div class="toolbar">
    <label style="font-weight: bold; font-size: 12px;">Date: <input type="date" id="kioskDate" onchange="loadKioskData()" style="padding:2px;" /></label>
    <label style="font-weight: bold; font-size: 12px;">Slot: 
      <select id="slotFilter" onchange="loadKioskData()">
        <option value="all">All Routes</option>
        <option value="amRoutes">AM Routes</option>
        <option value="pmRoutes">PM Routes</option>
        <option value="fieldTrips">Field Trips</option>
      </select>
    </label>
    <label style="font-weight: bold; font-size: 12px;">Search Driver: <input type="text" id="driverSearch" placeholder="Type driver name..." oninput="filterByDriver()" style="padding:2px; font-weight:normal;" /></label>
    <button onclick="loadKioskData()" class="btn-undo">🔄 Refresh</button>
  </div>
  <div class="kiosk-grid">
    <div class="column column-pending"><div class="col-title">1. Pending / Delayed <span id="countPending" class="badge">0</span></div><div id="colPending"></div></div>
    <div class="column column-enroute"><div class="col-title">2. En Route <span id="countEnRoute" class="badge">0</span></div><div id="colEnRoute"></div></div>
    <div class="column column-returned"><div class="col-title">3. Returned <span id="countReturned" class="badge">0</span></div><div id="colReturned"></div></div>
  </div>
  <script src="/js/dispatch.js"></script>
</body>
</html>
  `);
});

app.get('/mechanics', requireMechanicOrAdmin(), async (req, res) => {
  const headerHtml = await renderHeader('mechanics', false, req.user);
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
  ${headerHtml}
  <div class="container">
    <h2>🛠 Fleet Maintenance & Shop Portal</h2>
    <div id="busGrid" class="grid"></div>
  </div>
  <script src="/js/mechanics.js"></script>
</body>
</html>
  `);
});

app.get('/field-trips', requireAdminAccess(), async (req, res) => {
  const headerHtml = await renderHeader('field-trips', false, req.user);
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Parkway Schools - District Field Trip Audit</title>
  <style>
    ${COMMON_CSS}
    .container { padding: 15px 25px; }
    .card { background: #fff; padding: 15px; border-radius: 4px; border-top: 4px solid #DD0000; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 15px; }
    .grid-table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 10px; }
    .grid-table th, .grid-table td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; }
    .grid-table th { background: #f0f0f0; font-weight: bold; position: sticky; top: 0; }
    input[type="text"], input[type="number"], input[type="date"], select { width: 95%; font-family: 'Trebuchet MS'; font-size: 10px; padding: 2px 4px; border: 1px solid #ccc; }
    .btn-del { background: #DD0000; color: #fff; border: none; padding: 3px 6px; cursor: pointer; font-weight: bold; }
    .kpi-row { display: flex; gap: 15px; margin: 10px 0; font-size: 12px; font-weight: bold; align-items: center; }
    .kpi-badge { background: #eee; padding: 4px 8px; border-radius: 3px; border-left: 3px solid #DD0000; }
    .rate-controls { background: #fafafa; border: 1px solid #ccc; padding: 6px 12px; border-radius: 3px; display: flex; gap: 12px; align-items: center; margin-left: auto; font-size: 11px; }
    .pair-container { display: flex; flex-direction: column; gap: 4px; }
    .pair-row { display: flex; flex-direction: column; gap: 2px; background: #fafafa; padding: 4px; border: 1px solid #e0e0e0; border-radius: 2px; }
    .pair-inputs { display: flex; gap: 4px; align-items: center; }
    .pair-inputs label { font-size: 9px; font-weight: bold; color: #555; }
    @media print { header, .upload-box, .toolbar, button, .no-print, .rate-controls { display: none !important; } }
  </style>
</head>
<body>
  ${headerHtml}
  <div class="container">
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h2 style="margin:0; color:#DD0000; font-size:16px;">🚌 DISTRICT FIELD TRIP TRACKER & AUDIT GRID</h2>
        <div>
          <button onclick="window.print()" class="nav-btn" style="background:#666;">🖨 Print Audit</button>
          <button onclick="exportTripsCSV()" class="nav-btn">⬇ Export CSV</button>
        </div>
      </div>
      <div style="display:flex; gap:15px; align-items:center; margin-bottom:10px; margin-top:10px;">
        <label style="font-weight:bold; font-size:12px;">View Mode: 
          <select id="viewMode" onchange="toggleViewMode()" style="padding:2px; font-family:'Trebuchet MS';">
            <option value="day">Single Day</option>
            <option value="month">Full Month</option>
          </select>
        </label>
        <label id="dayPickerContainer" style="font-weight:bold; font-size:12px;">Date: <input type="date" id="tripDate" onchange="loadTrips()" style="padding:2px; font-family:'Trebuchet MS';" /></label>
        <label id="monthPickerContainer" style="font-weight:bold; font-size:12px; display:none;">Month: <input type="month" id="tripMonth" onchange="loadTrips()" style="padding:2px; font-family:'Trebuchet MS';" /></label>
        <button onclick="addEmptyTripRow()" class="nav-btn" style="background:#2e7d32;">+ Add New Field Trip</button>
        <div class="rate-controls no-print">
          <span><b>⚙ Default Billing Rates:</b></span>
          <label>$/Hr: $<input type="number" id="defRateHr" step="0.50" style="width:50px;" onchange="saveSystemRates()" /></label>
          <label>$/Mi: $<input type="number" id="defRateMi" step="0.05" style="width:50px;" onchange="saveSystemRates()" /></label>
        </div>
      </div>
      <div class="kpi-row">
        <div class="kpi-badge">Total Trips: <span id="kpiCount">0</span></div>
        <div class="kpi-badge">Total Hours: <span id="kpiHours">0</span> hrs</div>
        <div class="kpi-badge">Total Miles: <span id="kpiMiles">0</span> mi</div>
        <div class="kpi-badge">Total Charge: $<span id="kpiCharge">0.00</span></div>
        <span style="margin-left:auto; font-size:10px; color:#666; font-weight:normal;">🔄 Auto-refreshes every 30s</span>
      </div>
      <div style="overflow-x: auto; max-height: 60vh;">
        <table class="grid-table">
          <thead>
            <tr>
              <th style="min-width:90px;">Date</th>
              <th>Type</th>
              <th>School</th>
              <th>Class/Team</th>
              <th>Destination</th>
              <th style="min-width:60px;">Pickup</th>
              <th style="min-width:60px;">Dropoff</th>
              <th>Buses</th>
              <th style="min-width:420px;">Assigned Vehicle, Driver & Billing Ledger per Bus</th>
              <th>Requested By</th>
              <th>Approver</th>
              <th>Account Code</th>
              <th style="min-width:45px;">$/Hr</th>
              <th style="min-width:45px;">$/Mi</th>
              <th>Tot Hr</th>
              <th>Tot Mi</th>
              <th>Charge</th>
              <th>Check Status</th>
              <th>Status / Action</th>
            </tr>
          </thead>
          <tbody id="tripTableBody"></tbody>
        </table>
      </div>
    </div>
  </div>
  <script src="/js/field-trips.js"></script>
</body>
</html>
  `);
});

app.get('/admin', requireAdminAccess(), async (req, res) => {
  const headerHtml = await renderHeader('admin', false, req.user);
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
  ${headerHtml}

  <div class="container">
    <div class="grid">
      <div class="card">
        <h2>Drivers</h2>
        <form id="driverForm">
          <input type="text" id="dName" placeholder="Full Name" required />
          <input type="email" id="dEmail" placeholder="driver@parkwayschools.net" required />
          <button type="submit">Add Driver</button>
        </form>
        <button type="button" onclick="syncDirectory('drivers')" class="btn-secondary" style="margin-top:6px;">🔄 Sync Drivers from Google Directory</button>
        <button type="button" onclick="clearAllDrivers()" class="btn-delete" style="flex:1;">🗑 Clear All Drivers</button>

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
          <a href="/api/samples/buses" style="color:#DD0000; font-weight:bold;">⬇ Download Sample CSV</a>
          <input type="file" id="busCsv" accept=".csv" style="margin-top:6px;" />
          <button type="button" onclick="uploadCsv('/api/upload/buses', 'busCsv')">Upload Buses CSV</button>
        </div>

        <ul id="busList" style="margin-top:15px; padding-left:0; list-style:none;"></ul>
      </div>

      <div class="card">
        <h2>Mechanics</h2>
        <form id="mechForm">
          <input type="text" id="mName" placeholder="Full Name" required />
          <input type="email" id="mEmail" placeholder="mechanic@parkwayschools.net" required />
          <button type="submit">Add Mechanic</button>
        </form>
        <button type="button" onclick="syncDirectory('mechanics')" class="btn-secondary" style="margin-top:6px;">🔄 Sync Mechanics from Google Directory</button>

        <div class="upload-box">
          <b>📁 Batch Upload Mechanics (CSV):</b><br/>
          <a href="/api/samples/mechanics" style="color:#DD0000; font-weight:bold;">⬇ Download Sample CSV</a>
          <input type="file" id="mechCsv" accept=".csv" style="margin-top:6px;" />
          <button type="button" onclick="uploadCsv('/api/upload/mechanics', 'mechCsv')">Upload Mechanics CSV</button>
        </div>

        <ul id="mechList" style="margin-top:15px; padding-left:0; list-style:none;"></ul>
      </div>

      <div class="card">
        <h2>Application Administrators</h2>
        <p style="font-size: 11px; color: #555; margin-top: -5px;">Designated administrative contacts for app management.</p>
        <form id="adminWhitelistForm">
          <input type="email" id="aEmail" placeholder="admin.user@parkwayschools.net" required />
          <button type="submit">Add Admin Record</button>
        </form>

        <ul id="adminWhitelist" style="margin-top:15px; padding-left:0; list-style:none;"></ul>
      </div>
    </div>

    <div class="card" style="margin-top: 25px; border-top-color: #DD0000;">
      <h2>Daily Route Schedule Builder</h2>
      
      <div class="upload-box" style="margin-bottom: 20px;">
        <b>📁 Batch Upload Daily Schedules (CSV):</b><br/>
        <a href="/api/samples/schedule" style="color:#DD0000; font-weight:bold;">⬇ Download Sample Schedule CSV</a>
        <input type="file" id="scheduleCsv" accept=".csv" style="margin-top:6px;" />
        <button type="button" onclick="uploadCsv('/api/upload/schedule', 'scheduleCsv')">Upload Schedule CSV</button>
      </div>

      <div style="display: flex; gap: 15px; align-items: center; margin-bottom: 20px;">
        <label style="font-weight: bold;">Date: <input type="date" id="scheduleDate" /></label>
        <button onclick="loadSchedule()">Load Date</button>
        <button onclick="copyForward()" class="btn-secondary">📋 Copy Previous Day Route</button>
        <button onclick="clearAllSchedules()" class="btn-delete" style="margin-left: auto;">🗑 Clear All Schedules</button>
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

  <script src="/js/admin.js"></script>
</body>
</html>
  `);
});

app.get('/reports', requireAdminAccess(), async (req, res) => {
  const headerHtml = await renderHeader('reports', false, req.user);
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Parkway Schools - End of Day Report</title>
  <style>
    ${COMMON_CSS}
    .container { padding: 20px 30px; }
    .report-card { background: #fff; padding: 20px; border-radius: 4px; border-top: 4px solid #DD0000; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin: 15px 0; }
    .kpi-box { background: #fafafa; border: 1px solid #ddd; padding: 12px; text-align: center; border-radius: 3px; }
    .kpi-value { font-size: 22px; font-weight: bold; color: #DD0000; }
    .kpi-label { font-size: 11px; text-transform: uppercase; color: #666; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 12px; }
    th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; }
    th { background: #f0f0f0; color: #000; font-weight: bold; }
    tr:nth-child(even) { background: #fafafa; }
    @media print { header, .toolbar, button { display: none !important; } }
  </style>
</head>
<body>
  ${headerHtml}

  <div class="container">
    <div class="report-card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h2 style="margin:0; color:#DD0000; font-size:18px;">📊 END OF DAY DISPATCH REPORT</h2>
        <div>
          <button onclick="window.print()" class="nav-btn" style="background:#666;">🖨 Print Report</button>
          <button onclick="downloadCSV()" class="nav-btn">⬇ Export CSV</button>
        </div>
      </div>

      <div style="margin-top:15px; display:flex; gap:10px; align-items:center;">
        <label style="font-weight:bold; font-size:13px;">Select Report Date: 
          <input type="date" id="reportDate" onchange="loadReport()" style="padding:4px; font-family:'Trebuchet MS';" />
        </label>
      </div>

      <div class="kpi-grid">
        <div class="kpi-box"><div class="kpi-value" id="kpiTotal">0</div><div class="kpi-label">Total Routes</div></div>
        <div class="kpi-box"><div class="kpi-value" id="kpiCompleted" style="color:#2e7d32;">0</div><div class="kpi-label">Completed</div></div>
        <div class="kpi-box"><div class="kpi-value" id="kpiDelayed" style="color:#DD0000;">0</div><div class="kpi-label">Delayed</div></div>
        <div class="kpi-box"><div class="kpi-value" id="kpiUnassigned" style="color:#FF9F3D;">0</div><div class="kpi-label">Unassigned</div></div>
        <div class="kpi-box"><div class="kpi-value" id="kpiRate" style="color:#000;">0%</div><div class="kpi-label">On-Time Rate</div></div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Slot</th>
            <th>Route Name</th>
            <th>Scheduled Time</th>
            <th>Driver</th>
            <th>Bus Number</th>
            <th>Check-In Time</th>
            <th>Return Time</th>
            <th>Final Status</th>
          </tr>
        </thead>
        <tbody id="reportTableBody"></tbody>
      </table>
    </div>
  </div>

  <script>
    document.getElementById('reportDate').value = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

    async function loadReport() {
      const date = document.getElementById('reportDate').value;
      const tableBody = document.getElementById('reportTableBody');

      try {
        const res = await fetch('/api/reports/daily/' + date);

        if (!res.ok) {
          // Date has no saved schedule records yet — reset UI gracefully without throwing console errors
          document.getElementById('kpiTotal').innerText = '0';
          document.getElementById('kpiCompleted').innerText = '0';
          document.getElementById('kpiDelayed').innerText = '0';
          document.getElementById('kpiUnassigned').innerText = '0';
          document.getElementById('kpiRate').innerText = '0%';
          tableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:#666;">No dispatch records found for selected date.</td></tr>';
          return;
        }

        const data = await res.json();
        document.getElementById('kpiTotal').innerText = data.summary.totalRoutes;
        document.getElementById('kpiCompleted').innerText = data.summary.completedRoutes;
        document.getElementById('kpiDelayed').innerText = data.summary.delayedRoutes;
        document.getElementById('kpiUnassigned').innerText = data.summary.unassignedRoutes;
        document.getElementById('kpiRate').innerText = data.summary.onTimeRate + '%';

        const routeList = Array.isArray(data.routes) ? data.routes : [];

        tableBody.innerHTML = routeList.map(r => '<tr>' +
          '<td><b>' + r.categoryTag + '</b></td>' +
          '<td>' + r.routeName + '</td>' +
          '<td>' + (r.scheduledTime || 'N/A') + '</td>' +
          '<td>' + (r.driverId ? r.driverId.name : '<span style="color:#DD0000;">Unassigned</span>') + '</td>' +
          '<td>' + (r.busId ? 'Bus #' + r.busId.busNumber : '<span style="color:#DD0000;">Unassigned</span>') + '</td>' +
          '<td>' + (r.checkInTime || 'N/A') + '</td>' +
          '<td>' + (r.returnTime || 'N/A') + '</td>' +
          '<td><b>' + r.status + '</b></td>' +
          '</tr>').join('');
      } catch (err) {
        console.warn('Unable to load report for date:', date);
      }
    }

    function downloadCSV() {
      const date = document.getElementById('reportDate').value;
      window.location.href = '/api/reports/daily/' + date + '/export';
    }

    loadReport();
  </script>
</body>
</html>
  `);
});

app.get('/', (req, res) => res.redirect('/dashboard'));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});