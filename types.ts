
export interface QuestionSegment {
  id: string;
  content: string; // Text content OR Image Data URL
  type: 'single_choice' | 'multiple_choice' | 'text' | 'calculation' | 'other';
  // Difficulty removed as per request
  isImage: boolean;
  pageIndex?: number; // The index of the original page image (for PDF/Image sources)
  rect?: { xmin: number; ymin: number; xmax: number; ymax: number };
}

export interface ProcessingState {
  status: 'idle' | 'parsing' | 'analyzing' | 'complete' | 'error';
  message: string;
  progress: number;
}