import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';

// GET /api/llm-config - List all LLM configs
export async function GET() {
  try {
    const configs = await db.llmConfig.findMany({
      orderBy: { updatedAt: 'desc' },
    });

    return NextResponse.json({ configs });
  } catch (error) {
    console.error('Error fetching LLM configs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch LLM configs' },
      { status: 500 }
    );
  }
}

// POST /api/llm-config - Create a new LLM config
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, provider, apiKey, baseUrl, model, isDefault } = body;

    if (!name) {
      return NextResponse.json(
        { error: 'name is required' },
        { status: 400 }
      );
    }

    // If this is set as default, unset any existing default
    if (isDefault) {
      await db.llmConfig.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
    }

    const config = await db.llmConfig.create({
      data: {
        name,
        provider: provider || 'z-ai',
        apiKey: apiKey || '',
        baseUrl: baseUrl || '',
        model: model || '',
        isDefault: isDefault || false,
      },
    });

    return NextResponse.json({ config }, { status: 201 });
  } catch (error) {
    console.error('Error creating LLM config:', error);
    return NextResponse.json(
      { error: 'Failed to create LLM config' },
      { status: 500 }
    );
  }
}
