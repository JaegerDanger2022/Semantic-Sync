#!/usr/bin/env node
// Reads FIREBASE_API_KEY from .env (or process.env) and patches out/auth.js
// after tsc compiles. Run via: npm run build

const fs = require('fs');
const path = require('path');

// Load .env if present
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach((line) => {
      const [key, ...rest] = line.split('=');
      if (key && rest.length && !process.env[key.trim()]) {
        process.env[key.trim()] = rest.join('=').trim();
      }
    });
}

const apiKey = process.env.FIREBASE_API_KEY || '';
if (!apiKey) {
  console.warn('Warning: FIREBASE_API_KEY not set. Auth will not work.');
}

const authJsPath = path.join(__dirname, '..', 'out', 'auth.js');
if (!fs.existsSync(authJsPath)) {
  console.error('out/auth.js not found. Run tsc first.');
  process.exit(1);
}

let content = fs.readFileSync(authJsPath, 'utf8');
content = content.replace(
  /typeof __FIREBASE_API_KEY__ !== 'undefined' \? __FIREBASE_API_KEY__ : ''/g,
  JSON.stringify(apiKey)
);
fs.writeFileSync(authJsPath, content);
console.log('Injected FIREBASE_API_KEY into out/auth.js');
