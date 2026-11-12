import { db } from '@/lib/db';
import { NextResponse } from 'next/server';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const UPLOAD_DIR = '/home/z/my-project/upload';

function extractDescription(content: string): string {
  const docstringMatch = content.match(/"""([\s\S]*?)"""/) || content.match(/'''([\s\S]*?)'''/);
  if (docstringMatch) {
    const docContent = docstringMatch[1].trim();
    const firstLine = docContent.split('\n').find((l: string) => l.trim().length > 0);
    return firstLine?.trim() || '';
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') && trimmed.length > 1) {
      if (trimmed.startsWith('#!') || trimmed.startsWith('# -*-')) continue;
      return trimmed.replace(/^#+\s*/, '').trim();
    }
    if (trimmed.length > 0 && !trimmed.startsWith('#')) break;
  }
  return '';
}

function determineCategory(filename: string, content: string): string {
  const fn = filename.toLowerCase();
  const cl = content.toLowerCase();

  // Test scripts - check first to avoid false positives
  if (fn.startsWith('test') || fn === 'nb.py' || fn === 'pi.py') {
    return 'Test';
  }

  // Runner / CLI / UI
  if (fn.includes('runner') || fn.includes('cli') ||
      fn.includes('script_ui') || fn.includes('run_script') ||
      fn.includes('simple_runner') || fn.includes('button') ||
      fn.includes('run_segid') || fn.includes('segid_runner')) {
    return 'Runner';
  }

  // Structural Biology / Protein Analysis - check before Visualization
  // because many of these scripts reference chimeraX/pptx for output
  if (fn.includes('cdr') || fn.includes('fab') ||
      fn.includes('interaction') || fn.includes('interface') ||
      fn.includes('rmsd') || fn.includes('protein') ||
      fn.includes('anarci') || fn.includes('h_bond') ||
      fn.includes('locres') || fn.includes('mrc') ||
      fn.includes('segment') || fn.includes('chainid') ||
      fn.includes('segid') || fn.includes('ligand')) {
    return 'Structural Biology';
  }

  // Automation
  if (fn.includes('rename') || fn.includes('auto_') ||
      fn.includes('拆分') || fn.includes('flip') ||
      fn.includes('color') || fn.includes('highlight')) {
    return 'Automation';
  }

  // Visualization & Graphics - use more specific checks
  // Only match filename patterns, not broad content searches
  if (fn.includes('visualizer') || fn.includes('epitope') ||
      fn.includes('scalebar') || fn.includes('tile') ||
      fn.includes('isomesh') || fn.includes('ppt_to_images') ||
      fn.includes('interface_residue_ppt') ||
      fn.includes('interaction_to_xlxs_chimera')) {
    return 'Visualization';
  }

  // Fallback: check content for strong visualization signals
  if (fn.includes('ppt') || fn.includes('pptx')) {
    return 'Visualization';
  }

  return 'Utility';
}

export async function GET() {
  try {
    const files = readdirSync(UPLOAD_DIR).filter(
      (f: string) => f.endsWith('.py') && !f.includes('__pycache__')
    );

    let imported = 0;
    const errors: { path: string; error: string }[] = [];

    for (const file of files) {
      try {
        const filePath = join(UPLOAD_DIR, file);
        const content = readFileSync(filePath, 'utf-8');
        const description = extractDescription(content);
        const category = determineCategory(file, content);
        const name = file.replace(/\.py$/, '').replace(/[-_]/g, ' ');

        await db.script.upsert({
          where: { filename: file },
          update: {
            name,
            description,
            content,
            category,
            language: 'python',
            source: 'github',
          },
          create: {
            name,
            description,
            filename: file,
            content,
            category,
            language: 'python',
            source: 'github',
          },
        });
        imported++;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        errors.push({ path: file, error: errorMsg });
      }
    }

    return NextResponse.json({
      imported,
      total: files.length,
      errors,
      message: `Successfully imported ${imported} of ${files.length} scripts locally`,
    });
  } catch (error) {
    console.error('Error seeding scripts locally:', error);
    return NextResponse.json(
      { error: 'Failed to seed scripts locally' },
      { status: 500 }
    );
  }
}
