#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');

const projectDir = '/home/z/my-project';
const nextBin = path.join(projectDir, 'node_modules', '.bin', 'next');

const child = spawn(nextBin, ['dev', '-p', '3000'], {
  cwd: projectDir,
  stdio: 'inherit',
  detached: true,
});

child.unref();
console.log(`Next.js dev server started with PID: ${child.pid}`);
