import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';

// GET /api/scripts - List all scripts with optional category filter
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');

    const where = category ? { category } : {};

    const scripts = await db.script.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        filename: true,
        category: true,
        language: true,
        source: true,
        sourceUrl: true,
        params: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: { executions: true },
        },
      },
    });

    return NextResponse.json({ scripts });
  } catch (error) {
    console.error('Error fetching scripts:', error);
    return NextResponse.json(
      { error: 'Failed to fetch scripts' },
      { status: 500 }
    );
  }
}

// POST /api/scripts - Create a new script
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, description, filename, content, category, language, source, sourceUrl, params } = body;

    if (!name || !filename || !content) {
      return NextResponse.json(
        { error: 'name, filename, and content are required' },
        { status: 400 }
      );
    }

    const script = await db.script.create({
      data: {
        name,
        description: description || '',
        filename,
        content,
        category: category || 'Uncategorized',
        language: language || 'python',
        source: source || 'manual',
        sourceUrl: sourceUrl || null,
        params: params || '[]',
      },
    });

    return NextResponse.json({ script }, { status: 201 });
  } catch (error) {
    console.error('Error creating script:', error);
    return NextResponse.json(
      { error: 'Failed to create script' },
      { status: 500 }
    );
  }
}
