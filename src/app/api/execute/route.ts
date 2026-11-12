import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const TMP_DIR = '/tmp/script-manager';

// Ensure temp directory exists
if (!existsSync(TMP_DIR)) {
  mkdirSync(TMP_DIR, { recursive: true });
}

interface ExecuteResult {
  output: string;
  error: string;
  exitCode: number | null;
  duration: number;
}

function executeCommand(
  command: string,
  args: string[],
  timeout: number = 30000
): Promise<ExecuteResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';

    const proc = spawn(command, args, {
      cwd: TMP_DIR,
      env: { ...process.env },
      timeout,
    });

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      resolve({
        output: stdout,
        error: stderr,
        exitCode: code,
        duration,
      });
    });

    proc.on('error', (err) => {
      const duration = Date.now() - startTime;
      resolve({
        output: stdout,
        error: err.message,
        exitCode: null,
        duration,
      });
    });

    // Handle timeout - spawn will kill the process, which triggers 'close'
    proc.on('exit', (code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        const duration = Date.now() - startTime;
        resolve({
          output: stdout,
          error: `Process was terminated (signal: ${signal}). Possible timeout after ${timeout}ms.`,
          exitCode: null,
          duration,
        });
      }
    });
  });
}

// POST /api/execute - Execute a script by id
export async function POST(request: NextRequest) {
  let scriptFile: string | null = null;
  let paramsFile: string | null = null;

  try {
    const body = await request.json();
    const { id, params: execParams } = body;

    if (!id) {
      return NextResponse.json(
        { error: 'Script id is required' },
        { status: 400 }
      );
    }

    // Find the script
    const script = await db.script.findUnique({ where: { id } });
    if (!script) {
      return NextResponse.json(
        { error: 'Script not found' },
        { status: 404 }
      );
    }

    // Generate unique filenames for temp files
    const runId = randomUUID();
    const language = script.language?.toLowerCase() || 'python';

    // Determine file extension and command
    let command: string;
    let args: string[];
    let extension: string;

    if (language === 'shell' || language === 'bash' || language === 'sh') {
      extension = '.sh';
      command = 'bash';
    } else if (language === 'node' || language === 'javascript' || language === 'js') {
      extension = '.js';
      command = 'node';
    } else {
      // Default to Python
      extension = '.py';
      command = 'python3';
    }

    // Write script content to temp file
    scriptFile = join(TMP_DIR, `${runId}${extension}`);
    writeFileSync(scriptFile, script.content, 'utf-8');

    // Parse and write params if provided
    if (execParams && typeof execParams === 'object') {
      paramsFile = join(TMP_DIR, `${runId}_params.json`);
      writeFileSync(paramsFile, JSON.stringify(execParams, null, 2), 'utf-8');
      args = [scriptFile, paramsFile];
    } else {
      args = [scriptFile];
    }

    // Execute the script with 30-second timeout
    const result = await executeCommand(command, args, 30000);

    // Determine status
    let status: string;
    if (result.exitCode === 0) {
      status = 'success';
    } else if (result.exitCode === null) {
      status = 'timeout';
    } else {
      status = 'error';
    }

    // Create execution log
    const executionLog = await db.executionLog.create({
      data: {
        scriptId: script.id,
        params: execParams ? JSON.stringify(execParams) : '{}',
        output: result.output,
        error: result.error,
        status,
        duration: result.duration,
      },
    });

    // Clean up temp files
    try {
      if (scriptFile) unlinkSync(scriptFile);
      if (paramsFile) unlinkSync(paramsFile);
    } catch {
      // Ignore cleanup errors
    }

    return NextResponse.json({
      execution: executionLog,
      output: result.output,
      error: result.error,
      exitCode: result.exitCode,
      duration: result.duration,
      status,
    });
  } catch (error) {
    // Clean up temp files on error
    try {
      if (scriptFile) unlinkSync(scriptFile);
      if (paramsFile) unlinkSync(paramsFile);
    } catch {
      // Ignore cleanup errors
    }

    console.error('Error executing script:', error);
    return NextResponse.json(
      { error: 'Failed to execute script' },
      { status: 500 }
    );
  }
}
