require('dotenv').config();
const { google } = require('googleapis');

async function testGoogleDirectoryAPI() {
  console.log('--------------------------------------------------');
  console.log('🔍 TESTING GOOGLE WORKSPACE DIRECTORY API');
  console.log('--------------------------------------------------');

  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  // Parse escaped newlines correctly
  let privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '';
  privateKey = privateKey.replace(/^"|"$/g, '').replace(/\\n/g, '\n');
  const adminEmail = process.env.GOOGLE_ADMIN_EMAIL;

  try {
    const auth = new google.auth.JWT({
      email: serviceAccountEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
      subject: adminEmail // Workspace Admin email to impersonate
    });

    console.log('1. Fetching OAuth2 Access Token via JWT...');
    const tokens = await auth.authorize();
    console.log('   - Access token acquired successfully!');

    console.log(`2. Requesting Directory Record for: ${adminEmail}...`);
    const service = google.admin({ version: 'directory_v1', auth });
    const res = await service.users.get({ userKey: adminEmail });

    console.log('\n================================------------------');
    console.log('✅ SUCCESS! CONNECTED TO GOOGLE WORKSPACE DIRECTORY');
    console.log('================================------------------');
    console.log('Full Name:', res.data.name?.fullName || 'N/A');
    console.log('Org Unit Path (OU):', res.data.orgUnitPath || '/');
    console.log('Job Title:', res.data.organizations?.[0]?.title || 'None Listed');
    console.log('--------------------------------------------------\n');

  } catch (err) {
    console.error('\n================================------------------');
    console.error('❌ DIRECTORY API LOOKUP FAILED');
    console.error('================================------------------');
    console.error('Error Message:', err.message);
    if (err.response && err.response.data) {
      console.error('Google API Error Response:', JSON.stringify(err.response.data, null, 2));
    }
    console.error('--------------------------------------------------\n');
  }
}

testGoogleDirectoryAPI();