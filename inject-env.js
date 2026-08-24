/**
 * Build script to inject environment variables into the app
 * Run: node inject-env.js
 */

const fs = require('fs');
const path = require('path');

// Read environment variables (from process.env)
const envVars = {
  FIREBASE_API_KEY: process.env.FIREBASE_API_KEY,
  FIREBASE_AUTH_DOMAIN: process.env.FIREBASE_AUTH_DOMAIN,
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
  FIREBASE_STORAGE_BUCKET: process.env.FIREBASE_STORAGE_BUCKET,
  FIREBASE_MESSAGING_SENDER_ID: process.env.FIREBASE_MESSAGING_SENDER_ID,
  FIREBASE_APP_ID: process.env.FIREBASE_APP_ID,
  FIREBASE_MEASUREMENT_ID: process.env.FIREBASE_MEASUREMENT_ID
};

// Filter out undefined values
const definedVars = Object.entries(envVars).filter(([_, v]) => v);

// Generate the env-injection script
const envInjectionScript = `<script>
${definedVars.map(([key, val]) => `  window.${key} = "${val}";`).join('\n')}
</script>
`;

// Read index.html
const indexPath = path.join(__dirname, 'index.html');
let indexHtml = fs.readFileSync(indexPath, 'utf8');

// Inject before </head>
indexHtml = indexHtml.replace('</head>', `${envInjectionScript}</head>`);

fs.writeFileSync(indexPath, indexHtml);

console.log('✓ Environment variables injected into index.html');
console.log('  Injected vars:', definedVars.map(([k]) => k).join(', '));