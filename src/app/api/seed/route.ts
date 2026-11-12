import { db } from '@/lib/db';
import { NextResponse } from 'next/server';

const GITHUB_REPO = 'Jing0715-fer/my-py-scripts';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/git/trees/main?recursive=1`;
const RAW_BASE_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main`;

interface GitHubTreeItem {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
  url: string;
}

function extractDescription(content: string): string {
  const lines = content.split('\n');

  // Try to find docstring (first """ or ''' block)
  const docstringMatch = content.match(/"""([\s\S]*?)"""/) || content.match(/'''([\s\S]*?)'''/);
  if (docstringMatch) {
    const docContent = docstringMatch[1].trim();
    // Return first non-empty line of the docstring
    const firstLine = docContent.split('\n').find((l) => l.trim().length > 0);
    return firstLine?.trim() || '';
  }

  // Try to find # description comments at the top
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') && trimmed.length > 1) {
      // Skip shebang and encoding lines
      if (trimmed.startsWith('#!') || trimmed.startsWith('# -*-')) continue;
      return trimmed.replace(/^#+\s*/, '').trim();
    }
    // Stop looking if we hit code (non-comment, non-empty line)
    if (trimmed.length > 0 && !trimmed.startsWith('#')) break;
  }

  return '';
}

function determineCategory(path: string, content: string): string {
  const parts = path.split('/');
  const filename = parts[parts.length - 1].toLowerCase();
  const contentLower = content.toLowerCase();

  // If in subdirectory, use that as category
  if (parts.length > 1) {
    const category = parts[0];
    return category
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Test scripts - check first to avoid false positives
  if (filename.startsWith('test') || filename === 'nb.py' || filename === 'pi.py') {
    return 'Test';
  }

  // Runner / CLI / UI
  if (filename.includes('runner') || filename.includes('cli') ||
      filename.includes('script_ui') || filename.includes('run_script') ||
      filename.includes('simple_runner') || filename.includes('button') ||
      filename.includes('run_segid') || filename.includes('segid_runner')) {
    return 'Runner';
  }

  // Structural Biology / Protein Analysis - check before Visualization
  // because many of these scripts reference chimeraX/pptx for output
  if (filename.includes('cdr') || filename.includes('fab') ||
      filename.includes('interaction') || filename.includes('interface') ||
      filename.includes('rmsd') || filename.includes('protein') ||
      filename.includes('anarci') || filename.includes('h_bond') ||
      filename.includes('locres') || filename.includes('mrc') ||
      filename.includes('segment') || filename.includes('chainid') ||
      filename.includes('segid') || filename.includes('ligand')) {
    return 'Structural Biology';
  }

  // Automation
  if (filename.includes('rename') || filename.includes('auto_') ||
      filename.includes('拆分') || filename.includes('flip') ||
      filename.includes('color') || filename.includes('highlight')) {
    return 'Automation';
  }

  // Visualization & Graphics - use more specific checks
  // Only match filename patterns, not broad content searches
  if (filename.includes('visualizer') || filename.includes('epitope') ||
      filename.includes('scalebar') || filename.includes('tile') ||
      filename.includes('isomesh') || filename.includes('ppt_to_images') ||
      filename.includes('interface_residue_ppt') ||
      filename.includes('interaction_to_xlxs_chimera')) {
    return 'Visualization';
  }

  // Fallback: check filename for presentation-related patterns
  if (filename.includes('ppt') || filename.includes('pptx')) {
    return 'Visualization';
  }

  return 'Utility';
}

// GET /api/seed - Import scripts from GitHub repo
export async function GET() {
  try {
    // Fetch repo tree
    const treeResponse = await fetch(GITHUB_API_URL, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'script-manager-app',
      },
    });

    if (!treeResponse.ok) {
      const errorText = await treeResponse.text();
      console.error('GitHub API error:', treeResponse.status, errorText);

      if (treeResponse.status === 403) {
        return NextResponse.json(
          { error: 'GitHub API rate limit exceeded. Please try again later.' },
          { status: 429 }
        );
      }

      return NextResponse.json(
        { error: `Failed to fetch repository tree: ${treeResponse.status}` },
        { status: 502 }
      );
    }

    const treeData = await treeResponse.json();
    const treeItems: GitHubTreeItem[] = treeData.tree || [];

    // Filter for .py files
    const pyFiles = treeItems.filter(
      (item) =>
        item.type === 'blob' &&
        item.path.endsWith('.py') &&
        !item.path.includes('__pycache__') &&
        !item.path.includes('.venv')
    );

    if (pyFiles.length === 0) {
      return NextResponse.json({
        imported: 0,
        errors: [],
        message: 'No Python files found in the repository',
      });
    }

    let imported = 0;
    const errors: { path: string; error: string }[] = [];

    // Process each file
    for (const file of pyFiles) {
      try {
        // Fetch file content
        const rawUrl = `${RAW_BASE_URL}/${file.path}`;
        const contentResponse = await fetch(rawUrl);

        if (!contentResponse.ok) {
          errors.push({
            path: file.path,
            error: `Failed to fetch content: ${contentResponse.status}`,
          });
          continue;
        }

        const content = await contentResponse.text();

        // Extract metadata
        const description = extractDescription(content);
        const category = determineCategory(file.path, content);
        const filename = file.path.split('/').pop() || file.path;
        const name = filename.replace(/\.py$/, '').replace(/[-_]/g, ' ');

        // Upsert the script (by unique filename)
        await db.script.upsert({
          where: { filename },
          update: {
            name,
            description,
            content,
            category,
            language: 'python',
            source: 'github',
            sourceUrl: rawUrl,
          },
          create: {
            name,
            description,
            filename,
            content,
            category,
            language: 'python',
            source: 'github',
            sourceUrl: rawUrl,
          },
        });

        imported++;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        errors.push({ path: file.path, error: errorMsg });
      }
    }

    return NextResponse.json({
      imported,
      total: pyFiles.length,
      errors,
      message: `Successfully imported ${imported} of ${pyFiles.length} scripts`,
    });
  } catch (error) {
    console.error('Error seeding scripts:', error);
    return NextResponse.json(
      { error: 'Failed to seed scripts from GitHub' },
      { status: 500 }
    );
  }
}
