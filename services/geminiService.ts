import { GoogleGenAI, Type, Schema } from "@google/genai";
import { QuestionSegment } from "../types";

const parseApiKey = (): string => {
  const key = process.env.API_KEY;
  if (!key) {
    throw new Error("缺少 API Key。");
  }
  return key;
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Optimized: Downscale image for AI analysis.
// maxDimension set to 1024 to ensure sufficient resolution for detecting column gaps in dense layouts,
// while keeping payload size reasonable for speed.
const resizeImageForAnalysis = async (base64Str: string, maxDimension = 1024): Promise<string> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let width = img.width;
      let height = img.height;

      // Calculate new dimensions while maintaining aspect ratio
      if (width > maxDimension || height > maxDimension) {
        if (width > height) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
          // Fill white background to handle any transparent PNGs cleanly when converting to JPEG
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
          // Export as JPEG with 0.7 quality - good balance for text readability vs size
          resolve(canvas.toDataURL('image/jpeg', 0.7).split(',')[1]); 
      } else {
          // Fallback
          resolve(base64Str.split(',')[1]);
      }
    };
    img.onerror = () => resolve(base64Str.split(',')[1]);
    img.src = base64Str;
  });
};

// Schema for TEXT based extraction (DOCX/TXT)
const textSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          content: { type: Type.STRING },
          type: { type: Type.STRING, enum: ['single_choice', 'multiple_choice', 'text', 'calculation', 'other'] },
        },
        required: ["content", "type"],
      },
    },
  },
  required: ["questions"],
};

// Schema for VISUAL segmentation (PDF)
const visualSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          ymin: { type: Type.INTEGER, description: "Top Y coordinate (0-1000 scale)" },
          ymax: { type: Type.INTEGER, description: "Bottom Y coordinate (0-1000 scale)" },
          xmin: { type: Type.INTEGER, description: "Left X coordinate (0-1000 scale)" },
          xmax: { type: Type.INTEGER, description: "Right X coordinate (0-1000 scale)" },
          type: { type: Type.STRING, enum: ['single_choice', 'multiple_choice', 'text', 'calculation', 'other'] },
        },
        required: ["ymin", "ymax", "xmin", "xmax", "type"],
      },
    },
  },
  required: ["segments"],
};

// 1. Process Text/HTML (Word/Txt)
export const segmentTextWithGemini = async (text: string): Promise<QuestionSegment[]> => {
  try {
    const ai = new GoogleGenAI({ apiKey: parseApiKey() });
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          { text: "Analyze the document text/html. Split it into distinct questions. Return JSON." },
          { text: text.slice(0, 100000) } // Reduced safety truncate limit to avoid payload issues
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: textSchema,
        temperature: 0.2,
      }
    });

    const parsed = JSON.parse(response.text || '{"questions": []}');
    return parsed.questions.map((q: any, i: number) => ({
      id: `q-${Date.now()}-${i}`,
      content: q.content,
      type: q.type || 'other',
      isImage: false
    }));
  } catch (error) {
    console.error("Text Segmentation Error", error);
    throw new Error("AI 文本分析失败");
  }
};

// 2. Process Image (PDF Page)
export interface BoxSegment {
  ymin: number;
  ymax: number;
  xmin: number;
  xmax: number;
  type: string;
}

export const segmentPageImage = async (imageBase64: string): Promise<BoxSegment[]> => {
  // Optimize: Resize image for analysis to 1024px. 
  // This is slightly larger than 768px to ensure two-column gaps are clearly visible to the model, 
  // improving accuracy on complex layouts without significant speed penalty.
  const optimizedBase64Data = await resizeImageForAnalysis(imageBase64, 1024);
  const ai = new GoogleGenAI({ apiKey: parseApiKey() });

  const prompt = `
    Analyze this exam page image. Return a JSON object with a "segments" array containing bounding boxes for each question.
    
    RULES:
    1. **Boundaries**: Box must encompass the question number, full text, options, and any graphics.
    2. **Layout**: Strictly respect TWO-COLUMN layouts.
       - Scan order: Left column (top-down), then Right column (top-down).
       - NEVER create a box that spans across the column gap.
    3. **Exclusions**: Ignore page headers/footers.
    
    Output coordinates on 0-1000 scale.
  `;

  // Retry Logic for robustness against 500/Network errors
  const MAX_RETRIES = 3;
  let lastError: any;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: {
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: "image/jpeg", 
                data: optimizedBase64Data
              }
            }
          ]
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: visualSchema,
          temperature: 0.1, // Reduced temperature for more deterministic output
        }
      });

      const parsed = JSON.parse(response.text || '{"segments": []}');
      return parsed.segments;

    } catch (error: any) {
      console.warn(`Visual Segmentation Attempt ${attempt} failed:`, error);
      lastError = error;
      
      // If it's the last attempt, don't wait, just loop and throw
      if (attempt < MAX_RETRIES) {
        // Exponential backoff: 1000ms, 2000ms, etc.
        await delay(1000 * attempt);
      }
    }
  }

  console.error("Visual Segmentation Error after retries", lastError);
  // Return empty array on error so we can skip page rather than crash the whole app
  return [];
};