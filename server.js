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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
  // Correct server startup and poller hook structure
  mongoose.connect(process.env.MONGO_URI)
    .then(() => {
      console.log('[MONGO] Connected successfully to Atlas');
      
      // Start background poller if defined
      if (typeof startGoogleSheetPoller === 'function') {
        startGoogleSheetPoller();
        console.log('[POLLER] Google Sheet poller started.');
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
        
        // 1. Check if user account is suspended or disabled in Google Workspace
        const isActive = !u.suspended && u.archived !== true;

        // 2. Exact word boundary check for "driver" in job title (case-insensitive)
        const hasDriverTitle = /\bdriver\b/i.test(jobTitle);

        // 3. Strict OU check: Must be in /TRA or a sub-OU of /TRA (e.g., /parkwayschools.net/TRA or /TRA)
        const isInTraOU = ouPath.includes('/TRA') || ouPath.endsWith('/TRA');

        // All three criteria must be TRUE
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

// ================= REAL-TIME GOOGLE FORM WEBHOOK =================

app.post('/api/district-field-trips/webhook', async (req, res) => {
  try {
    const { 
      date, school, classTeam, tripType, destination, destinationAddr,
      pickupTime, dropOffTime, numBuses, notes, accountCode, decision,
      applicantName, approverName 
    } = req.body;

    if (!date) {
      return res.status(400).json({ error: 'Missing Date of Trip in submission.' });
    }

    const tripDate = normalizeDateStr(date);
    
    let dest = destination || '';
    if (destinationAddr) {
      dest += dest ? ` (${destinationAddr})` : destinationAddr;
    }

    let accountStatus = 'Pending';
    if (decision) {
      const cleanDecision = decision.toString().trim().toLowerCase();
      if (cleanDecision === 'approve') accountStatus = 'Verified';
      if (cleanDecision === 'reject') accountStatus = 'Flagged';
    }

    let hourlySetting = await SystemSetting.findOne({ key: 'defaultRatePerHour' });
    let mileSetting = await SystemSetting.findOne({ key: 'defaultRatePerMile' });

    const tripData = {
      date: tripDate,
      tripType: tripType || 'Academic',
      school: school || '',
      classTeam: classTeam || '',
      destination: dest,
      pickupTime: formatTo12Hour(pickupTime || ''),
      dropOffTime: formatTo12Hour(dropOffTime || ''),
      numBuses: parseInt(numBuses, 10) || 1,
      requestedBy: applicantName || '',
      approverName: approverName || '',
      notes: notes || '',
      accountCode: accountCode || '',
      accountCodeCheck: accountStatus,
      ratePerHour: hourlySetting ? parseFloat(hourlySetting.value) : 25.00,
      ratePerMile: mileSetting ? parseFloat(mileSetting.value) : 2.50
    };

    const savedTrip = await FieldTripAudit.findOneAndUpdate(
      { date: tripDate, school: tripData.school, destination: tripData.destination },
      tripData,
      { upsert: true, new: true }
    );

    await syncFieldTripToDailySchedule(savedTrip);

    res.status(200).json({ success: true, message: 'Field trip received and saved.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= GOOGLE SHEETS LIVE SYNC API =================

app.post('/api/district-field-trips/sync-google-sheet', requireAdminAccess(), async (req, res) => {
  const { sheetUrlOrId, rangeName } = req.body;

  if (!sheetUrlOrId) {
    return res.status(400).json({ error: 'Please provide a Google Sheet URL or Sheet ID.' });
  }

  try {
    const result = await executeSheetSync(sheetUrlOrId, rangeName);
    res.json({ message: `Successfully synced ${result.count} field trip record(s) from tab '${result.tab}'!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= FIELD TRIP AUDIT APIs =================

app.post('/api/district-field-trips/resync-all-schedules', requireAdminAccess(), async (req, res) => {
  try {
    const trips = await FieldTripAudit.find()
      .populate('busAssignments.busId')
      .populate('busAssignments.driverId');

    let updatedCount = 0;
    for (let trip of trips) {
      await syncFieldTripToDailySchedule(trip);
      updatedCount++;
    }

    res.json({ success: true, message: `Re-synced pickup times for ${updatedCount} field trip(s)!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.get('/api/district-field-trips/:date', async (req, res) => {
  try {
    const normalizedDate = normalizeDateStr(req.params.date);
    const trips = await FieldTripAudit.find({ date: normalizedDate })
      .populate('busAssignments.busId')
      .populate('busAssignments.driverId')
      .sort({ pickupTime: 1 });
    res.json(trips);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

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
app.put('/api/drivers/:id', async (req, res) => {
  try {
    const updateData = { name: req.body.name };
    if (req.body.email) updateData.email = req.body.email.toLowerCase().trim();
    
    const driver = await Driver.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json(driver);
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
app.put('/api/mechanics/:id', async (req, res) => {
  try {
    const updateData = { name: req.body.name };
    if (req.body.email) updateData.email = req.body.email.toLowerCase().trim();

    const mechanic = await Mechanic.findByIdAndUpdate(req.params.id, updateData, { new: true });
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
  const normalizedDate = normalizeDateStr(req.params.date);

  let schedule = await DailySchedule.findOne({ date: normalizedDate })
    .populate('amRoutes.driverId amRoutes.busId')
    .populate('pmRoutes.driverId pmRoutes.busId')
    .populate('fieldTrips.driverId fieldTrips.busId');
  
  if (!schedule) {
    schedule = { date: normalizedDate, amRoutes: [], pmRoutes: [], fieldTrips: [] };
  }
  res.json(schedule);
});

app.post('/api/schedule', async (req, res) => {
  const { date, amRoutes, pmRoutes, fieldTrips } = req.body;
  const normalizedDate = normalizeDateStr(date);

  try {
    validateNoDuplicates(amRoutes, 'AM Routes');
    validateNoDuplicates(pmRoutes, 'PM Routes');
    validateNoDuplicates(fieldTrips, 'Field Trips');

    const schedule = await DailySchedule.findOneAndUpdate(
      { date: normalizedDate },
      { amRoutes, pmRoutes, fieldTrips },
      { upsert: true, new: true }
    );
    res.json(schedule);
  } catch (err) { res.status(400).json({ error: err.message }); }
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
    }

    await schedule.save();

    // ================= BIND TO FIELD TRIP AUDIT FORM =================
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

          // Explicitly assign both odometer values on return check-in
          if (startMiles !== undefined && startMiles !== null && !isNaN(startMiles)) {
            assignment.startMiles = Number(startMiles);
          }
          if (endMiles !== undefined && endMiles !== null && !isNaN(endMiles)) {
            assignment.endMiles = Number(endMiles);
          }

          console.log(`[FIELD TRIP STAMP] Trip "${cleanRouteName}" Returned: Start Mi (${assignment.startMiles}), End Mi (${assignment.endMiles})`);
        }

        // Mark array modified so Mongoose updates the nested document
        matchingTrip.markModified('busAssignments');
        await matchingTrip.save(); // Pre-save hook recalculates total miles, hours, and charges
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
      notes: r.notes,
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

// ================= END OF DAY REPORT APIs =================

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
    res.status(400).json({ error: err.message });
  }
});

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

app.get('/js/admin.js', requireAdminAccess(), (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    let drivers = [], buses = [], mechanics = [];
    let currentEditType = null, currentEditId = null;

    document.addEventListener('DOMContentLoaded', () => {
      const schedDateEl = document.getElementById('scheduleDate');
      if (schedDateEl) {
        schedDateEl.value = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      }

      setupFormListeners();
      fetchData();
    });

    async function fetchData() {
      try {
        const res = await fetch('/api/drivers');
        if (res.ok) drivers = await res.json();
        if (!Array.isArray(drivers)) drivers = [];
        renderDriverList();
      } catch (e) { console.error('Error loading drivers:', e); }

      try {
        const res = await fetch('/api/buses');
        if (res.ok) buses = await res.json();
        if (!Array.isArray(buses)) buses = [];
        renderBusList();
      } catch (e) { console.error('Error loading buses:', e); }

      try {
        const res = await fetch('/api/mechanics');
        if (res.ok) mechanics = await res.json();
        if (!Array.isArray(mechanics)) mechanics = [];
        renderMechList();
      } catch (e) { console.error('Error loading mechanics:', e); }

      await fetchAdminWhitelist();
      await loadSchedule();
    }

    function renderDriverList() {
      const el = document.getElementById('driverList');
      if (!el) return;
      el.innerHTML = '';
      (drivers || []).forEach(d => {
        const li = document.createElement('li');
        li.style.cssText = 'display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding:6px 0; font-size:12px;';
        li.innerHTML = '<span><b>' + (d.name || '') + '</b> (' + (d.email || '') + ')</span>' +
          '<div><button class="btn-action btn-edit">✏ Edit</button><button class="btn-action btn-delete">🗑 Delete</button></div>';
        li.querySelector('.btn-edit').onclick = () => openEdit('driver', d._id);
        li.querySelector('.btn-delete').onclick = () => deleteItem('driver', d._id);
        el.appendChild(li);
      });
    }

    function renderBusList() {
      const el = document.getElementById('busList');
      if (!el) return;
      el.innerHTML = '';
      (buses || []).forEach(b => {
        const li = document.createElement('li');
        li.style.cssText = 'display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding:6px 0; font-size:12px;';
        li.innerHTML = '<span><b>Bus #' + (b.busNumber || '') + '</b> ' + (b.isSpare ? '(Spare)' : '') + ' ' + (b.status === 'In Shop' ? '<b style="color:#DD0000;">[IN SHOP]</b>' : '') + '</span>' +
          '<div><button class="btn-action btn-edit">✏ Edit</button><button class="btn-action btn-delete">🗑 Delete</button></div>';
        li.querySelector('.btn-edit').onclick = () => openEdit('bus', b._id);
        li.querySelector('.btn-delete').onclick = () => deleteItem('bus', b._id);
        el.appendChild(li);
      });
    }

    function renderMechList() {
      const el = document.getElementById('mechList');
      if (!el) return;
      el.innerHTML = '';
      (mechanics || []).forEach(m => {
        const li = document.createElement('li');
        li.style.cssText = 'display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding:6px 0; font-size:12px;';
        li.innerHTML = '<span><b>' + (m.name || '') + '</b> (' + (m.email || '') + ')</span>' +
          '<div><button class="btn-action btn-edit">✏ Edit</button><button class="btn-action btn-delete">🗑 Delete</button></div>';
        li.querySelector('.btn-edit').onclick = () => openEdit('mechanic', m._id);
        li.querySelector('.btn-delete').onclick = () => deleteItem('mechanic', m._id);
        el.appendChild(li);
      });
    }

    async function fetchAdminWhitelist() {
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
          li.innerHTML = '<span><b>' + (a.email || '') + '</b> <span style="color:#888; font-size:10px;">(Added by ' + (a.addedBy || 'System') + ')</span></span><button class="btn-action btn-delete">🗑 Remove</button>';
          li.querySelector('.btn-delete').onclick = () => removeAdmin(a._id);
          el.appendChild(li);
        });
      } catch (e) { console.error('Error loading admin whitelist:', e); }
    }

    async function syncDirectory(role) {
      const res = await fetch('/api/sync/' + role, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        alert(data.message);
        fetchData();
      } else {
        alert('Error: ' + data.error);
      }
    }

    function setupFormListeners() {
      const adminForm = document.getElementById('adminWhitelistForm');
      if (adminForm) {
        adminForm.onsubmit = async (e) => {
          e.preventDefault();
          const emailInput = document.getElementById('aEmail');
          const res = await fetch('/api/admin-whitelist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: emailInput.value })
          });
          if (res.ok) { emailInput.value = ''; fetchAdminWhitelist(); }
          else { const data = await res.json(); alert('Error: ' + (data.error || 'Failed to add admin')); }
        };
      }

      const dForm = document.getElementById('driverForm');
      if (dForm) {
        dForm.onsubmit = async (e) => {
          e.preventDefault();
          const res = await fetch('/api/drivers', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ name: document.getElementById('dName').value, email: document.getElementById('dEmail').value })
          });
          if (res.ok) { e.target.reset(); fetchData(); }
          else { const data = await res.json(); alert('Error: ' + data.error); }
        };
      }

      const bForm = document.getElementById('busForm');
      if (bForm) {
        bForm.onsubmit = async (e) => {
          e.preventDefault();
          await fetch('/api/buses', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ busNumber: document.getElementById('bNumber').value, isSpare: document.getElementById('bSpare').checked })
          });
          e.target.reset();
          fetchData();
        };
      }

      const mForm = document.getElementById('mechForm');
      if (mForm) {
        mForm.onsubmit = async (e) => {
          e.preventDefault();
          const res = await fetch('/api/mechanics', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ name: document.getElementById('mName').value, email: document.getElementById('mEmail').value })
          });
          if (res.ok) { e.target.reset(); fetchData(); }
          else { const data = await res.json(); alert('Error: ' + data.error); }
        };
      }

      const editFormEl = document.getElementById('editForm');
      if (editFormEl) {
        editFormEl.onsubmit = async (e) => {
          e.preventDefault();
          let payload = {}, endpoint = '';
          if (currentEditType === 'driver') {
            endpoint = '/api/drivers/' + currentEditId;
            payload = { name: document.getElementById('mDName').value, email: document.getElementById('mDEmail').value };
          } else if (currentEditType === 'bus') {
            endpoint = '/api/buses/' + currentEditId;
            payload = { busNumber: document.getElementById('mBNumber').value, isSpare: document.getElementById('mBSpare').checked };
          } else if (currentEditType === 'mechanic') {
            endpoint = '/api/mechanics/' + currentEditId;
            payload = { name: document.getElementById('mMName').value, email: document.getElementById('mMEmail').value };
          }
          await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          closeModal();
          fetchData();
        };
      }
    }

    async function removeAdmin(id) {
      if (!confirm('Are you sure you want to remove this admin record?')) return;
      await fetch('/api/admin-whitelist/' + id, { method: 'DELETE' });
      fetchAdminWhitelist();
    }

    async function deleteItem(type, id) {
      if (!confirm('Are you sure you want to delete this ' + type + '?')) return;
      const endpoint = type === 'driver' ? '/api/drivers/' : type === 'bus' ? '/api/buses/' : '/api/mechanics/';
      let res = await fetch(endpoint + id, { method: 'DELETE' });
      let data = await res.json();

      if (!res.ok && data.hasConflict) {
        const forceDelete = confirm(data.error + '\\n\\nDo you want to FORCE DELETE anyway?');
        if (forceDelete) {
          res = await fetch(endpoint + id + '?force=true', { method: 'DELETE' });
          data = await res.json();
          if (res.ok) { alert(type.toUpperCase() + ' force deleted.'); fetchData(); }
          else { alert('Error: ' + data.error); }
        }
      } else if (res.ok) { fetchData(); }
      else { alert('Error: ' + data.error); }
    }

    function openEdit(type, id) {
      currentEditType = type;
      currentEditId = id;
      const modalFields = document.getElementById('modalFields');

      if (type === 'driver') {
        const item = drivers.find(d => String(d._id) === String(id));
        if (!item) return;
        document.getElementById('modalTitle').innerText = 'Edit Driver';
        modalFields.innerHTML = '<input type="text" id="mDName" value="' + (item.name || '') + '" placeholder="Name" required style="width:100%; margin-bottom:8px;" />' +
          '<input type="email" id="mDEmail" value="' + (item.email || '') + '" placeholder="driver@parkwayschools.net" required style="width:100%; margin-bottom:8px;" />';
      } else if (type === 'bus') {
        const item = buses.find(b => String(b._id) === String(id));
        if (!item) return;
        document.getElementById('modalTitle').innerText = 'Edit Bus';
        modalFields.innerHTML = '<input type="text" id="mBNumber" value="' + (item.busNumber || '') + '" placeholder="Bus Number" required style="width:100%; margin-bottom:8px;" />' +
          '<label style="font-size:12px;"><input type="checkbox" id="mBSpare" ' + (item.isSpare ? 'checked' : '') + ' /> Is Spare Bus</label>';
      } else if (type === 'mechanic') {
        const item = mechanics.find(m => String(m._id) === String(id));
        if (!item) return;
        document.getElementById('modalTitle').innerText = 'Edit Mechanic';
        modalFields.innerHTML = '<input type="text" id="mMName" value="' + (item.name || '') + '" placeholder="Name" required style="width:100%; margin-bottom:8px;" />' +
          '<input type="email" id="mMEmail" value="' + (item.email || '') + '" placeholder="mechanic@parkwayschools.net" required style="width:100%; margin-bottom:8px;" />';
      }

      document.getElementById('editModal').style.display = 'flex';
    }

    function closeModal() {
      document.getElementById('editModal').style.display = 'none';
    }

    async function uploadCsv(endpoint, inputId) {
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
        fetchData();
      } else {
        alert('Error: ' + (data.error || 'Upload failed'));
      }
    }

    function addRouteRow(containerId, data) {
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
    }

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

      const availableBuses = (buses || []).filter(b => b.status !== 'In Shop');

      rows.forEach(row => {
        const driverSelect = row.querySelector('.r-driver');
        const busSelect = row.querySelector('.r-bus');
        if (!driverSelect || !busSelect) return;

        const currentDriver = String(driverSelect.value || driverSelect.dataset.assignedVal || '');
        const currentBus = String(busSelect.value || busSelect.dataset.assignedVal || '');

        driverSelect.innerHTML = '<option value="">Select Driver</option>' + 
          (drivers || []).map(d => {
            const dIdStr = String(d._id);
            const isTaken = selectedDrivers.has(dIdStr) && dIdStr !== currentDriver;
            return isTaken ? '' : '<option value="' + dIdStr + '">' + d.name + '</option>';
          }).join('');

        busSelect.innerHTML = '<option value="">Select Bus</option>' + 
          availableBuses.map(b => {
            const bIdStr = String(b._id);
            const isTaken = selectedBuses.has(bIdStr) && bIdStr !== currentBus;
            return isTaken ? '' : '<option value="' + bIdStr + '">Bus ' + b.busNumber + (b.isSpare ? ' (Spare)' : '') + '</option>';
          }).join('');

        if (currentDriver) driverSelect.value = currentDriver;
        if (currentBus) busSelect.value = currentBus;
      });
    }

    async function loadSchedule() {
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

    async function saveSchedule() {
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
    }

    async function clearAllSchedules() {
      if (!confirm("⚠️ ARE YOU SURE?\\n\\nThis will permanently delete ALL saved schedules!")) return;
      const res = await fetch('/api/schedule/clear-all', { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) { alert(data.message); loadSchedule(); }
      else { alert('Error: ' + data.error); }
    }

    async function copyForward() {
      const dateEl = document.getElementById('scheduleDate');
      if (!dateEl) return;
      const res = await fetch('/api/schedule/copy-forward', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ targetDate: dateEl.value })
      });
      if (res.ok) { alert('Copied previous day schedule!'); loadSchedule(); }
      else { const err = await res.json(); alert(err.error); }
    }
  `);
});

// ================= PROTECTED VIEW ROUTES =================

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

// ================= PROTECTED VIEW ROUTES =================

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

  <script>
    async function loadBuses() {
      const res = await fetch('/api/buses');
      let buses = await res.json();
      if (!Array.isArray(buses)) buses = [];

      const grid = document.getElementById('busGrid');
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
      fields.style.display = selectEl.value === 'In Shop' ? 'flex' : 'none';
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

    loadBuses();
  </script>
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
      const res = await fetch('/api/reports/daily/' + date);
      const tableBody = document.getElementById('reportTableBody');

      if (!res.ok) {
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

        <label id="dayPickerContainer" style="font-weight:bold; font-size:12px;">Date: 
          <input type="date" id="tripDate" onchange="loadTrips()" style="padding:2px; font-family:'Trebuchet MS';" />
        </label>

        <label id="monthPickerContainer" style="font-weight:bold; font-size:12px; display:none;">Month: 
          <input type="month" id="tripMonth" onchange="loadTrips()" style="padding:2px; font-family:'Trebuchet MS';" />
        </label>

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
        <span style="margin-left:auto; font-size:10px; color:#666; font-weight:normal;">
          🔄 Auto-refreshes every 30s
        </span>
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

  <script>
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    document.getElementById('tripDate').value = todayStr;
    document.getElementById('tripMonth').value = todayStr.substring(0, 7);

    let systemRateHr = 25.00;
    let systemRateMi = 2.50;
    let masterDriversList = [];
    let masterBusesList = [];

    async function loadSystemRates() {
      try {
        const res = await fetch('/api/system-rates');
        if (res.ok) {
          const rates = await res.json();
          systemRateHr = rates.ratePerHour;
          systemRateMi = rates.ratePerMile;
          document.getElementById('defRateHr').value = systemRateHr.toFixed(2);
          document.getElementById('defRateMi').value = systemRateMi.toFixed(2);
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

        html += '<div class="pair-row">';

        // Line 1: Selectors
        html += '<div class="pair-inputs">';
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
        html += '</select>';
        html += '</div>';

        // Line 2: Individual Bus Hours, Miles & Cost
        html += '<div class="pair-inputs" style="margin-top:2px;">';
        html += '<label>Start Hr: <input type="number" step="0.1" value="' + startHr + '" class="bus-start-hr" style="width:35px;" onblur="savePairAssignment(\'' + tripId + '\', ' + i + ')" /></label>';
        html += '<label>End Hr: <input type="number" step="0.1" value="' + endHr + '" class="bus-end-hr" style="width:35px;" onblur="savePairAssignment(\'' + tripId + '\', ' + i + ')" /></label>';
        html += '<label>Start Mi: <input type="number" value="' + startMi + '" class="bus-start-mi" style="width:40px;" onblur="savePairAssignment(\'' + tripId + '\', ' + i + ')" /></label>';
        html += '<label>End Mi: <input type="number" value="' + endMi + '" class="bus-end-mi" style="width:40px;" onblur="savePairAssignment(\'' + tripId + '\', ' + i + ')" /></label>';
        html += '<span style="margin-left:auto; font-weight:bold; color:#2e7d32;">$' + bCharge + '</span>';
        html += '</div>';

        html += '</div>';
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
        let promptLines = [];
        promptLines.push('Number of buses decreased from ' + oldVal + ' to ' + newVal + '.');
        promptLines.push('Which bus assignment would you like to remove?\\n');

        busAssignments.forEach((p, idx) => {
          const bMatch = masterBusesList.find(b => String(b._id) === String(p.busId));
          const dMatch = masterDriversList.find(d => String(d._id) === String(p.driverId));
          const bNum = bMatch ? ('Bus #' + bMatch.busNumber) : 'Unassigned Bus';
          const dName = dMatch ? dMatch.name : 'Unassigned Driver';
          promptLines.push('[' + (idx + 1) + '] ' + bNum + ' (' + dName + ')');
        });

        promptLines.push('\\nEnter the number [1-' + busAssignments.length + '] to delete, or click Cancel:');

        const choice = prompt(promptLines.join('\\n'));
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
        
        document.getElementById('th_' + id).innerHTML = '<b>' + (updatedTrip.totalHours || 0).toFixed(1) + '</b>';
        document.getElementById('tm_' + id).innerHTML = '<b>' + (updatedTrip.totalMiles || 0) + '</b>';
        document.getElementById('ch_' + id).innerHTML = '<b>$' + (updatedTrip.charge || 0).toFixed(2) + '</b>';
        
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

      document.getElementById('kpiCount').innerText = rows.length;
      document.getElementById('kpiHours').innerText = totHours.toFixed(1);
      document.getElementById('kpiMiles').innerText = totMiles;
      document.getElementById('kpiCharge').innerText = totCharge.toFixed(2);
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

    loadTrips();

    setInterval(() => {
      const activeEl = document.activeElement;
      const isEditing = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT');
      if (!isEditing) {
        loadTrips();
      }
    }, 30000);
  </script>
</body>
</html>
  `);
});

app.get('/', (req, res) => res.redirect('/dashboard'));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});