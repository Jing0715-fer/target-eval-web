import { NextRequest, NextResponse } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';

interface AnalysisResult {
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    description: string;
    required: boolean;
    default?: string;
  }>;
  dependencies: string[];
  usage: string;
  summary: string;
}

// POST /api/ai/analyze-script - Analyze a script using AI
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { content, filename } = body;

    if (!content) {
      return NextResponse.json(
        { error: 'Script content is required' },
        { status: 400 }
      );
    }

    // Create AI instance
    const zai = await ZAI.create();

    const prompt = `Analyze the following script file named "${filename || 'unknown'}" and extract structured information.

Script content:
\`\`\`
${content}
\`\`\`

Please provide a JSON analysis with the following structure (respond with ONLY valid JSON, no markdown):
{
  "description": "A clear description of what this script does",
  "parameters": [
    {
      "name": "parameter_name",
      "type": "string|number|boolean|etc",
      "description": "What this parameter does",
      "required": true,
      "default": "default value if any"
    }
  ],
  "dependencies": ["list", "of", "external", "dependencies"],
  "usage": "How to use this script from the command line",
  "summary": "A one-line summary of the script's purpose"
}

Rules:
- Extract command-line arguments and parameters the script accepts
- Identify all external dependencies and imports
- Provide accurate usage instructions
- If no parameters are found, return an empty array
- If no dependencies beyond standard library, return an empty array`;

    const result = await zai.chat.completions.create({
      messages: [
        {
          role: 'system',
          content:
            'You are a code analysis expert. Analyze scripts and extract structured information. Always respond with valid JSON only, no markdown formatting.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      thinking: { type: 'disabled' },
    });

    // Parse the AI response
    let analysis: AnalysisResult;

    if (result?.choices?.[0]?.message?.content) {
      let contentStr = result.choices[0].message.content;

      // Remove markdown code blocks if present
      contentStr = contentStr
        .replace(/^```(?:json)?\s*\n?/m, '')
        .replace(/\n?```\s*$/m, '')
        .trim();

      try {
        analysis = JSON.parse(contentStr);
      } catch {
        // If JSON parsing fails, return the raw content
        analysis = {
          description: contentStr,
          parameters: [],
          dependencies: [],
          usage: '',
          summary: contentStr.substring(0, 200),
        };
      }
    } else {
      return NextResponse.json(
        { error: 'No response from AI service' },
        { status: 502 }
      );
    }

    return NextResponse.json({ analysis });
  } catch (error) {
    console.error('Error analyzing script:', error);
    return NextResponse.json(
      { error: 'Failed to analyze script with AI' },
      { status: 500 }
    );
  }
}
